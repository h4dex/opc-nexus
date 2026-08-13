package com.hermesandroid.bridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.integration.android.IntentIntegrator
import com.hermesandroid.bridge.auth.GatewayPairing
import com.hermesandroid.bridge.client.DeviceState
import com.hermesandroid.bridge.client.RelayClient
import com.hermesandroid.bridge.media.ScreenRecorder
import com.hermesandroid.bridge.overlay.StatusOverlay
import com.hermesandroid.bridge.service.BridgeAccessibilityService

class MainActivity : Activity() {
    companion object {
        private const val REQUEST_SCREEN_CAPTURE = 1001
        private const val REQUEST_RUNTIME_PERMISSIONS = 1002
        const val ACTION_EMERGENCY_DISCONNECT = "com.senke.opcnexus.bridge.EMERGENCY_DISCONNECT"
    }

    private lateinit var connectionIndicator: View
    private lateinit var connectionStatus: TextView
    private lateinit var gatewayValue: TextView
    private lateinit var deviceIdValue: TextView
    private lateinit var fingerprintValue: TextView
    private lateinit var accessibilityStatus: TextView
    private lateinit var notificationStatus: TextView
    private lateinit var screenCaptureStatus: TextView
    private lateinit var runtimeStatus: TextView
    private lateinit var connectionSwitch: Switch
    private lateinit var pairingConfigInput: EditText
    private lateinit var gatewayInput: EditText
    private lateinit var pairingIdInput: EditText
    private lateinit var pairingSecretInput: EditText
    private lateinit var spkiInput: EditText
    private var updatingSwitch = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()
        findViewById<TextView>(R.id.tvVersion).text = "v${BuildConfig.VERSION_NAME} · protocol 1"
        setupActions()
        setupGatewayStatus()
        handleIntent(intent)
        updateStatus()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    override fun onDestroy() {
        RelayClient.onStatusChanged = null
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scan != null) {
            if (!scan.contents.isNullOrBlank()) pairFromPayload(scan.contents)
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_SCREEN_CAPTURE) {
            if (resultCode == RESULT_OK && data != null) {
                ScreenRecorder.setProjectionPermission(resultCode, data)
                showMessage("屏幕投影权限已授予")
            } else {
                showMessage("未授予屏幕投影权限")
            }
            updateStatus()
        }
    }

    private fun bindViews() {
        connectionIndicator = findViewById(R.id.indicatorConnection)
        connectionStatus = findViewById(R.id.tvConnectionStatus)
        gatewayValue = findViewById(R.id.tvGatewayValue)
        deviceIdValue = findViewById(R.id.tvDeviceIdValue)
        fingerprintValue = findViewById(R.id.tvFingerprintValue)
        accessibilityStatus = findViewById(R.id.tvAccessibilityStatus)
        notificationStatus = findViewById(R.id.tvNotificationStatus)
        screenCaptureStatus = findViewById(R.id.tvScreenCaptureStatus)
        runtimeStatus = findViewById(R.id.tvRuntimeStatus)
        connectionSwitch = findViewById(R.id.switchConnection)
        pairingConfigInput = findViewById(R.id.etPairingConfig)
        gatewayInput = findViewById(R.id.etGatewayUrl)
        pairingIdInput = findViewById(R.id.etPairingId)
        pairingSecretInput = findViewById(R.id.etPairingSecret)
        spkiInput = findViewById(R.id.etSpki)
    }

    private fun setupActions() {
        findViewById<Button>(R.id.btnScanQr).setOnClickListener {
            IntentIntegrator(this)
                .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                .setPrompt("扫描 OPC-Nexus 配对二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(false)
                .initiateScan()
        }
        findViewById<Button>(R.id.btnParsePairingConfig).setOnClickListener {
            val payload = pairingConfigInput.text.toString().trim()
            if (payload.isBlank()) {
                showMessage("请先粘贴完整配对配置")
            } else {
                pairFromPayload(payload, "粘贴的配对配置无效")
            }
        }
        findViewById<Button>(R.id.btnManualPair).setOnClickListener {
            try {
                val pairing = GatewayPairing.fromManual(
                    gatewayInput.text.toString(),
                    pairingIdInput.text.toString().trim(),
                    pairingSecretInput.text.toString().trim(),
                    spkiInput.text.toString().trim(),
                )
                beginPairing(pairing)
            } catch (error: Exception) {
                showMessage(error.message ?: "手动配对信息无效")
            }
        }
        findViewById<Button>(R.id.btnAccessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<Button>(R.id.btnNotificationAccess).setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        findViewById<Button>(R.id.btnScreenCapture).setOnClickListener {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE)
        }
        findViewById<Button>(R.id.btnRuntimePermissions).setOnClickListener { requestBridgePermissions() }
        findViewById<Button>(R.id.btnOverlay).setOnClickListener {
            if (!Settings.canDrawOverlays(this)) {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            } else if (StatusOverlay.isShowing) {
                StatusOverlay.hide(this)
            } else {
                StatusOverlay.show(this)
            }
        }
        findViewById<Button>(R.id.btnEmergencyDisconnect).setOnClickListener {
            RelayClient.disconnect()
            showMessage("已紧急断开，自动重连已关闭")
            updateStatus()
        }
        findViewById<Button>(R.id.btnForgetPairing).setOnClickListener {
            RelayClient.clearPairing()
            showMessage("已清除网关绑定")
            updateStatus()
        }
        connectionSwitch.setOnCheckedChangeListener { _, enabled ->
            if (updatingSwitch) return@setOnCheckedChangeListener
            if (enabled) {
                if (!RelayClient.connectStored()) {
                    updatingSwitch = true
                    connectionSwitch.isChecked = false
                    updatingSwitch = false
                    showMessage("请先扫描配对二维码")
                }
            } else {
                RelayClient.disconnect()
            }
        }
    }

    private fun setupGatewayStatus() {
        RelayClient.onStatusChanged = { _, message ->
            connectionStatus.text = message
            updateStatus()
        }
    }

    private fun pairFromPayload(payload: String, fallback: String = "配对二维码无效") {
        try {
            beginPairing(GatewayPairing.parse(payload))
        } catch (error: Exception) {
            showMessage(error.message ?: fallback)
        }
    }

    private fun beginPairing(pairing: GatewayPairing) {
        pairingConfigInput.setText("")
        gatewayInput.setText(pairing.url)
        pairingIdInput.setText(pairing.pairingId)
        pairingSecretInput.setText("")
        spkiInput.setText(pairing.spki)
        RelayClient.pair(pairing)
        showMessage("正在与 OPC-Nexus 配对")
        updateStatus()
    }

    private fun requestBridgePermissions() {
        val permissions = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.SEND_SMS,
            Manifest.permission.CALL_PHONE,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) permissions += Manifest.permission.POST_NOTIFICATIONS
        requestPermissions(permissions.toTypedArray(), REQUEST_RUNTIME_PERMISSIONS)
    }

    private fun updateStatus() {
        val state = DeviceState.snapshot(this)
        @Suppress("UNCHECKED_CAST")
        val permissions = state["permissions"] as Map<String, String>
        val connected = RelayClient.isConnected
        val enabled = RelayClient.connectionEnabled
        connectionIndicator.setBackgroundResource(if (connected) R.drawable.bg_status_dot_green else if (enabled) R.drawable.bg_status_dot_red else R.drawable.bg_status_dot_grey)
        if (connectionStatus.text.isBlank()) connectionStatus.text = if (connected) "已连接" else if (enabled) "正在连接" else "未连接"
        connectionStatus.setTextColor(if (connected) 0xFF22C1A3.toInt() else 0xFFAAAAAA.toInt())
        gatewayValue.text = RelayClient.serverUrl ?: "未配对"
        deviceIdValue.text = RelayClient.deviceId ?: "-"
        fingerprintValue.text = RelayClient.certificatePin ?: "-"
        accessibilityStatus.renderPermission(permissions.getValue("accessibility"))
        notificationStatus.renderPermission(permissions.getValue("notification_access"))
        screenCaptureStatus.renderPermission(permissions.getValue("screen_capture"))
        val runtimeGranted = listOf("location", "contacts", "sms", "phone", "microphone").count { permissions[it] == "granted" }
        runtimeStatus.text = "$runtimeGranted / 5"
        runtimeStatus.setTextColor(if (runtimeGranted > 0) 0xFF22C1A3.toInt() else 0xFF888888.toInt())
        updatingSwitch = true
        connectionSwitch.isChecked = enabled
        updatingSwitch = false
    }

    private fun TextView.renderPermission(value: String) {
        text = when (value) { "granted" -> "已授权"; "not_available" -> "不可用"; "restricted" -> "受限"; else -> "未授权" }
        setTextColor(if (value == "granted") 0xFF22C1A3.toInt() else if (value == "restricted") 0xFFF59E0B.toInt() else 0xFF888888.toInt())
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == ACTION_EMERGENCY_DISCONNECT) {
            RelayClient.disconnect()
            showMessage("已紧急断开")
        }
    }

    private fun showMessage(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
}
