package com.hermesandroid.bridge.client

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import com.hermesandroid.bridge.BuildConfig
import com.hermesandroid.bridge.media.ScreenRecorder
import com.hermesandroid.bridge.model.DeviceCapabilities
import com.hermesandroid.bridge.service.BridgeAccessibilityService
import com.hermesandroid.bridge.service.BridgeNotificationListener

object DeviceState {
    private fun permission(context: Context, name: String): String =
        if (context.checkSelfPermission(name) == PackageManager.PERMISSION_GRANTED) "granted" else "denied"

    fun snapshot(context: Context): Map<String, Any> {
        val accessibility = BridgeAccessibilityService.instance != null
        val projection = ScreenRecorder.hasPermission()
        val screenCapture = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) accessibility else projection
        val notification = BridgeNotificationListener.instance != null
        val telephony = DeviceCapabilities.hasTelephony
        val displayName = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
            ?.takeIf { it.isNotBlank() } ?: Build.MODEL
        return mapOf(
            "name" to displayName,
            "model" to Build.MODEL,
            "manufacturer" to Build.MANUFACTURER,
            "androidVersion" to Build.VERSION.RELEASE,
            "apiLevel" to Build.VERSION.SDK_INT,
            "appVersion" to BuildConfig.VERSION_NAME,
            "permissions" to mapOf(
                "accessibility" to if (accessibility) "granted" else "denied",
                "screen_capture" to if (screenCapture) "granted" else "denied",
                "media_projection" to if (projection) "granted" else "denied",
                "notification_access" to if (notification) "granted" else "denied",
                "location" to permission(context, Manifest.permission.ACCESS_FINE_LOCATION),
                "contacts" to if (telephony) permission(context, Manifest.permission.READ_CONTACTS) else "not_available",
                "sms" to if (telephony) permission(context, Manifest.permission.SEND_SMS) else "not_available",
                "phone" to if (telephony) permission(context, Manifest.permission.CALL_PHONE) else "not_available",
                "microphone" to permission(context, Manifest.permission.RECORD_AUDIO),
                "clipboard" to if (accessibility || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) "granted" else "restricted",
                "tts" to "granted",
            ),
            "capabilities" to mapOf(
                "accessibility" to accessibility,
                "screenCapture" to screenCapture,
                "mediaProjection" to projection,
                "notificationAccess" to notification,
                "telephony" to telephony,
                "microphone" to (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED),
            ),
        )
    }
}
