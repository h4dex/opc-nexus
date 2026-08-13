package com.hermesandroid.bridge.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.hermesandroid.bridge.MainActivity
import com.hermesandroid.bridge.R
import com.hermesandroid.bridge.client.RelayClient

class MobileConnectionService : Service() {
    companion object {
        private const val CHANNEL_ID = "opcnexus_mobile_connection"
        private const val NOTIFICATION_ID = 19021
        private const val ACTION_START = "com.senke.opcnexus.bridge.CONNECTION_START"
        private const val ACTION_DISCONNECT = "com.senke.opcnexus.bridge.CONNECTION_DISCONNECT"

        fun start(context: Context) {
            val intent = Intent(context, MobileConnectionService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MobileConnectionService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            RelayClient.disconnect()
            stopSelf()
            return START_NOT_STICKY
        }
        createChannel()
        startForeground(NOTIFICATION_ID, notification())
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(
            CHANNEL_ID,
            "OPC-Nexus 手机连接",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "显示手机桥与 OPC-Nexus 的活动连接" })
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val disconnect = PendingIntent.getService(
            this,
            1,
            Intent(this, MobileConnectionService::class.java).setAction(ACTION_DISCONNECT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(this)
        return builder
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("已连接到 OPC-Nexus，可随时紧急断开")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "紧急断开", disconnect).build())
            .build()
    }
}
