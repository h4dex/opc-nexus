package com.hermesandroid.bridge.media

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import com.hermesandroid.bridge.model.ActionResult
import com.hermesandroid.bridge.service.BridgeAccessibilityService
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

object ScreenRecorder {
    private const val NO_PERMISSION_MESSAGE =
        "No MediaProjection. Grant Screen Recording in the app before each capture on Android 16."
    private const val MAX_DURATION_MS = 30_000L
    private const val SCREENSHOT_TIMEOUT_MS = 5_000L
    private const val MAX_RECORDING_LONG_EDGE = 1280
    private const val VIDEO_DIMENSION_ALIGNMENT = 16

    @Volatile private var projectionResultCode: Int? = null
    @Volatile private var projectionData: Intent? = null
    @Volatile private var recorder: MediaRecorder? = null
    @Volatile private var virtualDisplay: VirtualDisplay? = null
    @Volatile private var cancelRequested = false
    private val handlerThread = HandlerThread("ScreenRecorder").apply { start() }
    private val handler = Handler(handlerThread.looper)

    fun hasPermission(): Boolean = projectionData != null

    fun setProjectionPermission(resultCode: Int, data: Intent) {
        projectionResultCode = resultCode
        projectionData = Intent(data)
    }

    private fun clearProjectionPermission() {
        projectionResultCode = null
        projectionData = null
    }

    suspend fun captureScreenshot(): ActionResult {
        val service = BridgeAccessibilityService.instance
            ?: return ActionResult(false, "Accessibility service not running")
        val resultCode = projectionResultCode
            ?: return ActionResult(false, "MediaProjection permission is required", mapOf("restricted" to true, "reason" to "permission_denied"))
        val resultData = projectionData
            ?: return ActionResult(false, "MediaProjection permission is required", mapOf("restricted" to true, "reason" to "permission_denied"))

        return suspendCancellableCoroutine { continuation ->
            handler.post {
                var projection: MediaProjection? = null
                var projectionCallback: MediaProjection.Callback? = null
                var imageReader: ImageReader? = null
                var display: VirtualDisplay? = null
                val completed = AtomicBoolean(false)
                lateinit var timeout: Runnable

                fun cleanup() {
                    handler.removeCallbacks(timeout)
                    runCatching { imageReader?.setOnImageAvailableListener(null, null) }
                    runCatching { display?.release() }
                    runCatching {
                        if (projectionCallback != null) projection?.unregisterCallback(projectionCallback!!)
                    }
                    runCatching { projection?.stop() }
                    runCatching { imageReader?.close() }
                    display = null
                    imageReader = null
                    projection = null
                }

                fun finish(result: ActionResult) {
                    if (!completed.compareAndSet(false, true)) return
                    cleanup()
                    if (continuation.isActive) continuation.resume(result)
                }

                timeout = Runnable {
                    finish(ActionResult(false, "Screenshot timed out", mapOf("restricted" to true, "reason" to "capture_timeout")))
                }

                continuation.invokeOnCancellation {
                    handler.post {
                        if (completed.compareAndSet(false, true)) cleanup()
                    }
                }

                try {
                    val metrics = service.resources.displayMetrics
                    val width = metrics.widthPixels
                    val height = metrics.heightPixels
                    val manager = service.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                    projection = manager.getMediaProjection(resultCode, resultData)
                        ?: throw IllegalStateException("MediaProjection permission token was not accepted")
                    projectionCallback = object : MediaProjection.Callback() {
                        override fun onStop() {
                            finish(ActionResult(false, "Screen capture was stopped by Android", mapOf("restricted" to true, "reason" to "projection_stopped")))
                        }
                    }
                    projection!!.registerCallback(projectionCallback!!, handler)

                    imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
                    imageReader!!.setOnImageAvailableListener({ reader ->
                        val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                        try {
                            val plane = image.planes.firstOrNull()
                                ?: throw IllegalStateException("Screenshot image has no pixel plane")
                            val pixelStride = plane.pixelStride
                            val rowStride = plane.rowStride
                            val paddedWidth = width + (rowStride - pixelStride * width) / pixelStride
                            val padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
                            padded.copyPixelsFromBuffer(plane.buffer)
                            val bitmap = if (paddedWidth == width) padded else Bitmap.createBitmap(padded, 0, 0, width, height)
                            if (bitmap !== padded) padded.recycle()
                            val output = ByteArrayOutputStream()
                            bitmap.compress(Bitmap.CompressFormat.JPEG, 80, output)
                            bitmap.recycle()
                            finish(ActionResult(true, "Screenshot captured", mapOf(
                                "image" to Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP),
                                "width" to width,
                                "height" to height,
                                "format" to "jpeg",
                                "mimeType" to "image/jpeg",
                                "encoding" to "base64",
                            )))
                        } catch (error: Exception) {
                            finish(ActionResult(false, "Screenshot failed: ${error.message ?: error.javaClass.simpleName}"))
                        } finally {
                            image.close()
                        }
                    }, handler)
                    display = projection!!.createVirtualDisplay(
                        "OpcNexusScreenshot",
                        width,
                        height,
                        metrics.densityDpi,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                        imageReader!!.surface,
                        null,
                        handler,
                    )
                    handler.postDelayed(timeout, SCREENSHOT_TIMEOUT_MS)
                } catch (error: Exception) {
                    if (error is SecurityException || error is IllegalStateException) clearProjectionPermission()
                    finish(ActionResult(false, "Screenshot failed: ${error.message ?: error.javaClass.simpleName}", mapOf(
                        "restricted" to true,
                        "reason" to if (error is SecurityException) "permission_denied" else "capture_failed",
                    )))
                }
            }
        }
    }

    /**
     * Record the screen for [durationMs] milliseconds.
     * CRITICAL: Entire recording runs on the HandlerThread via handler.post().
     * MediaRecorder.start()/stop() and Thread.sleep() MUST be on the same thread
     * that created the VirtualDisplay callback handler — NOT on Dispatchers.IO.
     */
    fun record(durationMs: Long = 5000): Map<String, Any?> {
        val safeDuration = durationMs.coerceAtMost(MAX_DURATION_MS)
        val service = BridgeAccessibilityService.instance
            ?: return mapOf("success" to false, "message" to "Accessibility service not running")
        val resultCode = projectionResultCode
            ?: return mapOf("success" to false, "message" to NO_PERMISSION_MESSAGE)
        val resultData = projectionData
            ?: return mapOf("success" to false, "message" to NO_PERMISSION_MESSAGE)

        val latch = java.util.concurrent.CountDownLatch(1)
        val resultHolder = arrayOf<Map<String, Any?>?>(null)

        cancelRequested = false
        handler.post {
            var outputFile: File? = null
            var projection: MediaProjection? = null
            var projectionCallback: MediaProjection.Callback? = null
            try {
                service.startForeground(includeMediaProjection = true)
                val mpm = service.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                projection = mpm.getMediaProjection(resultCode, resultData)
                    ?: throw IllegalStateException("MediaProjection permission token was not accepted")
                projectionCallback = object : MediaProjection.Callback() {
                    override fun onStop() {
                        cleanupRecording()
                    }
                }
                projection.registerCallback(projectionCallback, handler)

                outputFile = File(service.cacheDir, "screen_record_${System.currentTimeMillis()}.mp4")
                val metrics = service.resources.displayMetrics
                val (width, height) = recordingDimensions(metrics.widthPixels, metrics.heightPixels)
                val density = metrics.densityDpi

                val mr = MediaRecorder(service).apply {
                    setVideoSource(MediaRecorder.VideoSource.SURFACE)
                    setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                    setOutputFile(outputFile.absolutePath)
                    setVideoEncoder(MediaRecorder.VideoEncoder.H264)
                    setVideoSize(width, height)
                    setVideoEncodingBitRate(1_500_000)
                    setVideoFrameRate(24)
                    prepare()
                }
                recorder = mr

                val vd = projection.createVirtualDisplay(
                    "ScreenRecorder", width, height, density,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    mr.surface, null, handler
                )
                virtualDisplay = vd

                mr.start()

                // Safe to block here — we're on the dedicated HandlerThread
                var elapsed = 0L
                while (elapsed < safeDuration && !cancelRequested) {
                    val slice = minOf(100L, safeDuration - elapsed)
                    Thread.sleep(slice)
                    elapsed += slice
                }

                mr.stop()
                mr.release()
                vd.release()
                recorder = null
                virtualDisplay = null

                val bytes = outputFile.readBytes()
                val base64Video = Base64.encodeToString(bytes, Base64.NO_WRAP)
                outputFile.delete()

                resultHolder[0] = mapOf(
                    "success" to true,
                    "message" to "Recorded ${elapsed}ms",
                    "data" to mapOf(
                        "video" to base64Video,
                        "width" to width,
                        "height" to height,
                        "durationMs" to elapsed,
                        "sizeBytes" to bytes.size,
                        "mimeType" to "video/mp4"
                    )
                )
            } catch (e: Exception) {
                cleanupRecording()
                outputFile?.delete()
                if (e is SecurityException || e is IllegalStateException) {
                    clearProjectionPermission()
                }
                resultHolder[0] = mapOf("success" to false, "message" to "Recording failed: ${e.javaClass.simpleName}: ${e.message}")
            } finally {
                try {
                    if (projectionCallback != null) projection?.unregisterCallback(projectionCallback)
                } catch (_: Exception) {}
                try { projection?.stop() } catch (_: Exception) {}
                latch.countDown()
            }
        }

        // Wait for the handler thread to finish (with generous timeout)
        latch.await(safeDuration + 10000, java.util.concurrent.TimeUnit.MILLISECONDS)
        return resultHolder[0] ?: mapOf("success" to false, "message" to "Recording timed out")
    }

    internal fun recordingDimensions(sourceWidth: Int, sourceHeight: Int): Pair<Int, Int> {
        require(sourceWidth > 0 && sourceHeight > 0) { "Display dimensions must be positive" }
        val scale = minOf(1.0, MAX_RECORDING_LONG_EDGE.toDouble() / maxOf(sourceWidth, sourceHeight))
        fun aligned(value: Int): Int =
            ((value * scale).toInt() / VIDEO_DIMENSION_ALIGNMENT * VIDEO_DIMENSION_ALIGNMENT)
                .coerceAtLeast(VIDEO_DIMENSION_ALIGNMENT)
        return aligned(sourceWidth) to aligned(sourceHeight)
    }

    private fun cleanupRecording() {
        try { recorder?.release() } catch (_: Exception) {}
        try { virtualDisplay?.release() } catch (_: Exception) {}
        recorder = null
        virtualDisplay = null
    }

    fun cancelActive() {
        cancelRequested = true
    }

    fun release() {
        cleanupRecording()
        handlerThread.quitSafely()
    }
}
