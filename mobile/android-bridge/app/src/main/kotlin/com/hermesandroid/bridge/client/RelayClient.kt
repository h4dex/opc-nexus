package com.hermesandroid.bridge.client

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.hermesandroid.bridge.BridgeApplication
import com.hermesandroid.bridge.auth.DeviceIdentity
import com.hermesandroid.bridge.auth.GatewayPairing
import com.hermesandroid.bridge.auth.SpkiPinning
import com.hermesandroid.bridge.audio.MicrophoneRecorderService
import com.hermesandroid.bridge.audio.MicrophoneRecordingFiles
import com.hermesandroid.bridge.executor.ActionExecutor
import com.hermesandroid.bridge.media.ScreenRecorder
import com.hermesandroid.bridge.server.CommandDispatcher
import com.hermesandroid.bridge.service.MobileConnectionService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Outbound, SPKI-pinned OPC-Nexus Mobile Gateway client. */
object RelayClient {
    private const val TAG = "OpcNexusGateway"
    private const val PREFS_NAME = "opcnexus_mobile_bridge"
    private const val KEY_GATEWAY_URL = "gateway_url"
    private const val KEY_GATEWAY_SPKI = "gateway_spki"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_ENABLED = "connection_enabled"
    private const val HEARTBEAT_MS = 10_000L
    private const val MAX_BACKOFF_MS = 30_000L

    private val gson = Gson()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val reconnectPolicy = ReconnectPolicy(maxRetries = Int.MAX_VALUE, maxBackoffMs = MAX_BACKOFF_MS)
    private var prefs: SharedPreferences? = null
    private var context: Context? = null
    private var webSocket: WebSocket? = null
    private var client: OkHttpClient? = null
    private var scope: CoroutineScope? = null
    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    private var pendingPairing: GatewayPairing? = null
    private var generation = 0
    private var shouldReconnect = false
    private var reconnectPending = false
    private var sessionStartedNs = 0L

    @Volatile
    var isConnected: Boolean = false
        private set

    @Volatile
    var isSocketOpen: Boolean = false
        private set

    val serverUrl: String?
        get() = prefs?.getString(KEY_GATEWAY_URL, null)

    val certificatePin: String?
        get() = prefs?.getString(KEY_GATEWAY_SPKI, null)

    val deviceId: String?
        get() = prefs?.getString(KEY_DEVICE_ID, null)

    val connectionEnabled: Boolean
        get() = prefs?.getBoolean(KEY_ENABLED, false) == true

    var onStatusChanged: ((connected: Boolean, message: String) -> Unit)? = null

    fun init(context: Context) {
        this.context = context.applicationContext
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    @Synchronized
    fun pair(pairing: GatewayPairing) {
        require(pairing.expiresAt > System.currentTimeMillis()) { "Pairing offer has expired" }
        disconnect(clearEnabled = false)
        pendingPairing = pairing
        shouldReconnect = true
        prefs?.edit()?.putBoolean(KEY_ENABLED, true)?.apply()
        reconnectPolicy.reset()
        scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        doConnect(pairing.url, pairing.spki)
    }

    @Synchronized
    fun connectStored(): Boolean {
        val url = serverUrl ?: return false
        val pin = certificatePin ?: return false
        if (deviceId.isNullOrBlank()) return false
        disconnect(clearEnabled = false)
        pendingPairing = null
        shouldReconnect = true
        prefs?.edit()?.putBoolean(KEY_ENABLED, true)?.apply()
        reconnectPolicy.reset()
        scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        doConnect(url, pin)
        return true
    }

    @Synchronized
    fun disconnect(clearEnabled: Boolean = true) {
        shouldReconnect = false
        reconnectPending = false
        reconnectJob?.cancel()
        heartbeatJob?.cancel()
        reconnectJob = null
        heartbeatJob = null
        generation++
        webSocket?.close(1000, "Emergency disconnect")
        webSocket = null
        client?.dispatcher?.executorService?.shutdown()
        client = null
        scope?.cancel()
        scope = null
        isConnected = false
        isSocketOpen = false
        sessionStartedNs = 0L
        pendingPairing = null
        if (clearEnabled) prefs?.edit()?.putBoolean(KEY_ENABLED, false)?.apply()
        context?.let { MobileConnectionService.stop(it) }
        notifyStatus(false, "Disconnected")
    }

    fun clearPairing() {
        disconnect()
        prefs?.edit()?.remove(KEY_GATEWAY_URL)?.remove(KEY_GATEWAY_SPKI)?.remove(KEY_DEVICE_ID)?.apply()
    }

    private fun buildClient(pin: String): OkHttpClient {
        val trust = SpkiPinning(pin)
        return OkHttpClient.Builder()
            .sslSocketFactory(trust.socketFactory(), trust)
            .hostnameVerifier(trust.hostnameVerifier)
            .pingInterval(10, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
    }

    @Synchronized
    private fun doConnect(url: String, pin: String) {
        val myGeneration = ++generation
        val request = Request.Builder().url(url).build()
        client?.dispatcher?.executorService?.shutdown()
        client = buildClient(pin)
        notifyStatus(false, "Connecting to OPC-Nexus...")
        webSocket = client!!.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (myGeneration != generation) return webSocket.cancel()
                isSocketOpen = true
                sessionStartedNs = System.nanoTime()
                val pairing = pendingPairing
                if (pairing != null) {
                    sendJson(webSocket, JsonObject().apply {
                        addProperty("type", "pair")
                        addProperty("protocolVersion", pairing.protocolVersion)
                        addProperty("pairingId", pairing.pairingId)
                        addProperty("secret", pairing.secret)
                        addProperty("publicKey", DeviceIdentity.publicKeyBase64())
                        add("device", gson.toJsonTree(deviceSnapshot()))
                    })
                    notifyStatus(false, "Authenticating pairing...")
                } else {
                    val id = deviceId
                    if (id.isNullOrBlank()) {
                        webSocket.close(1008, "Device is not paired")
                    } else {
                        sendJson(webSocket, JsonObject().apply {
                            addProperty("type", "hello")
                            addProperty("deviceId", id)
                        })
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope?.launch { handleMessage(webSocket, text, url, pin) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                Log.w(TAG, "Unexpected binary message from gateway (${bytes.size} bytes)")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (myGeneration != generation) return
                handleDisconnected("Connection closed: $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (myGeneration != generation) return
                Log.e(TAG, "Gateway connection failed", t)
                handleDisconnected("Connection failed: ${t.message ?: t.javaClass.simpleName}")
            }
        })
    }

    private suspend fun handleMessage(ws: WebSocket, text: String, url: String, pin: String) {
        try {
            val json = JsonParser.parseString(text).asJsonObject
            when (json.get("type")?.asString) {
                "paired" -> {
                    val id = json.get("deviceId")?.asString.orEmpty()
                    require(id.isNotBlank()) { "Gateway did not return a device ID" }
                    prefs?.edit()
                        ?.putString(KEY_GATEWAY_URL, url)
                        ?.putString(KEY_GATEWAY_SPKI, pin)
                        ?.putString(KEY_DEVICE_ID, id)
                        ?.putBoolean(KEY_ENABLED, true)
                        ?.apply()
                    pendingPairing = null
                    authenticated(ws, "Paired with OPC-Nexus")
                }
                "challenge" -> {
                    val id = deviceId ?: throw IllegalStateException("Device ID is missing")
                    val nonce = json.get("nonce")?.asString.orEmpty()
                    require(nonce.isNotBlank()) { "Authentication challenge is empty" }
                    sendJson(ws, JsonObject().apply {
                        addProperty("type", "authenticate")
                        addProperty("deviceId", id)
                        addProperty("signature", DeviceIdentity.signChallenge(id, nonce))
                        add("device", gson.toJsonTree(deviceSnapshot()))
                    })
                }
                "authenticated" -> authenticated(ws, "Connected to OPC-Nexus")
                "heartbeat_ack" -> Unit
                "command" -> handleCommand(ws, json)
                "emergency_stop" -> emergencyStop()
                else -> Log.w(TAG, "Ignoring unknown gateway message")
            }
        } catch (error: Exception) {
            Log.e(TAG, "Could not handle gateway message", error)
            val requestId = runCatching { JsonParser.parseString(text).asJsonObject.get("request_id")?.asString }.getOrNull()
            if (!requestId.isNullOrBlank()) sendCommandResult(ws, requestId, mapOf("error" to (error.message ?: "Command failed")), 500)
        }
    }

    private fun authenticated(ws: WebSocket, message: String) {
        isConnected = true
        reconnectPending = false
        context?.let { appContext ->
            runCatching { MobileConnectionService.start(appContext) }
                .onFailure { Log.w(TAG, "Could not refresh connection foreground service", it) }
        }
        notifyStatus(true, message)
        heartbeatJob?.cancel()
        heartbeatJob = scope?.launch {
            while (isConnected && shouldReconnect) {
                sendJson(ws, JsonObject().apply { addProperty("type", "heartbeat"); addProperty("timestamp", System.currentTimeMillis()) })
                sendDeviceState(ws)
                delay(HEARTBEAT_MS)
            }
        }
    }

    private suspend fun handleCommand(ws: WebSocket, json: JsonObject) {
        val requestId = json.get("request_id")?.asString.orEmpty()
        require(requestId.isNotBlank()) { "Command is missing request_id" }
        val method = json.get("method")?.asString?.uppercase() ?: "GET"
        val path = json.get("path")?.asString.orEmpty()
        val params = json.getAsJsonObject("params") ?: JsonObject()
        val body = json.getAsJsonObject("body") ?: JsonObject()

        if (method == "GET" && path == "/mic_file") {
            streamMicrophoneRecording(ws, requestId, params.get("name")?.asString)
            return
        }

        val response = CommandDispatcher.dispatch(method, path, params, body, authenticated = true)
        if (path == "/screen_record") {
            val tree = gson.toJsonTree(response.first)
            val encoded = tree.asJsonObject.getAsJsonObject("data")?.get("video")?.asString
            if (!encoded.isNullOrBlank()) {
                val bytes = Base64.decode(encoded, Base64.DEFAULT)
                streamBytes(ws, requestId, "screen-recording.mp4", "video/mp4", bytes)
                return
            }
        }
        sendCommandResult(ws, requestId, response.first, response.second)
        sendDeviceState(ws)
    }

    private fun emergencyStop() {
        runCatching { MicrophoneRecorderService.stop(BridgeApplication.instance) }
        runCatching { ActionExecutor.stopSpeaking() }
        runCatching { ScreenRecorder.cancelActive() }
        notifyStatus(isConnected, "Control session stopped by OPC-Nexus")
    }

    private fun sendDeviceState(ws: WebSocket) {
        sendJson(ws, JsonObject().apply {
            addProperty("type", "device_state")
            add("device", gson.toJsonTree(deviceSnapshot()))
        })
    }

    private fun deviceSnapshot(): Map<String, Any> = DeviceState.snapshot(context ?: BridgeApplication.instance)

    @Synchronized
    private fun handleDisconnected(message: String) {
        isConnected = false
        isSocketOpen = false
        heartbeatJob?.cancel()
        heartbeatJob = null
        val started = sessionStartedNs
        sessionStartedNs = 0L
        if (started != 0L) reconnectPolicy.onSessionEnded((System.nanoTime() - started) / 1_000_000L)
        notifyStatus(false, message)
        scheduleReconnect()
    }

    @Synchronized
    private fun scheduleReconnect() {
        if (!shouldReconnect || reconnectPending) return
        val activeScope = scope ?: return
        val pairing = pendingPairing
        if (pairing != null && pairing.expiresAt <= System.currentTimeMillis()) {
            shouldReconnect = false
            notifyStatus(false, "Pairing offer expired. Scan a new QR code.")
            return
        }
        val url = pairing?.url ?: serverUrl ?: return
        val pin = pairing?.spki ?: certificatePin ?: return
        reconnectPending = true
        val backoff = reconnectPolicy.nextBackoffMs()
        reconnectJob = activeScope.launch {
            notifyStatus(false, "Reconnecting in ${backoff / 1000}s...")
            delay(backoff)
            synchronized(this@RelayClient) {
                reconnectPending = false
                if (!shouldReconnect || isConnected) return@synchronized
                generation++
                webSocket?.cancel()
                doConnect(url, pin)
            }
        }
    }

    private suspend fun streamMicrophoneRecording(ws: WebSocket, requestId: String, requestedName: String?) {
        val file = MicrophoneRecordingFiles.resolve(BridgeApplication.instance, requestedName)
        if (file == null) return sendCommandResult(ws, requestId, mapOf("error" to "Recording not found"), 404)
        streamFile(ws, requestId, file.name, "audio/wav", file.length()) { consumer ->
            FileInputStream(file).use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count > 0) consumer(buffer, count)
                }
            }
        }
    }

    private suspend fun streamBytes(ws: WebSocket, requestId: String, filename: String, mimeType: String, data: ByteArray) {
        streamFile(ws, requestId, filename, mimeType, data.size.toLong()) { consumer ->
            var offset = 0
            while (offset < data.size) {
                val count = minOf(64 * 1024, data.size - offset)
                consumer(data.copyOfRange(offset, offset + count), count)
                offset += count
            }
        }
    }

    private suspend fun streamFile(
        ws: WebSocket,
        requestId: String,
        filename: String,
        mimeType: String,
        size: Long,
        producer: suspend (suspend (ByteArray, Int) -> Unit) -> Unit,
    ) {
        sendJson(ws, JsonObject().apply {
            addProperty("type", "command_result")
            addProperty("request_id", requestId)
            addProperty("status", 200)
            add("stream", JsonObject().apply {
                addProperty("event", "start")
                addProperty("filename", filename)
                addProperty("mimeType", mimeType)
                addProperty("size", size)
            })
        })
        val digest = MessageDigest.getInstance("SHA-256")
        var bytesSent = 0L
        try {
            producer { buffer, count ->
                while (ws.queueSize() > 1024L * 1024L) delay(10)
                digest.update(buffer, 0, count)
                check(ws.send(buildStreamFrame(requestId, buffer, count))) { "WebSocket rejected media data" }
                bytesSent += count
            }
            sendJson(ws, JsonObject().apply {
                addProperty("type", "command_result")
                addProperty("request_id", requestId)
                addProperty("status", 200)
                add("stream", JsonObject().apply {
                    addProperty("event", "end")
                    addProperty("bytes", bytesSent)
                    addProperty("sha256", digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) })
                })
            })
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            sendJson(ws, JsonObject().apply {
                addProperty("type", "command_result")
                addProperty("request_id", requestId)
                addProperty("status", 500)
                add("stream", JsonObject().apply { addProperty("event", "error"); addProperty("message", error.message ?: "Media stream failed") })
            })
        }
    }

    private fun buildStreamFrame(requestId: String, payload: ByteArray, payloadLength: Int): ByteString =
        MediaStreamProtocol.encode(requestId, payload, payloadLength).toByteString()

    private fun sendCommandResult(ws: WebSocket, requestId: String, result: Any, status: Int) {
        sendJson(ws, JsonObject().apply {
            addProperty("type", "command_result")
            addProperty("request_id", requestId)
            add("result", gson.toJsonTree(result))
            addProperty("status", status)
        })
    }

    private fun sendJson(ws: WebSocket, json: JsonObject): Boolean = ws.send(json.toString())

    private fun notifyStatus(connected: Boolean, message: String) {
        mainHandler.post { onStatusChanged?.invoke(connected, message) }
    }
}
