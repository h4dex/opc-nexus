package com.hermesandroid.bridge.power

import android.content.Context
import android.os.PowerManager
import kotlinx.coroutines.delay

object WakeLockManager {

    private var powerManager: PowerManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private const val HOLD_MS = 3_000L

    fun init(context: Context) {
        powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    }

    suspend fun <T> wakeForAction(block: suspend () -> T): T {
        val pm = powerManager
        val alreadyAwake = pm?.isInteractive ?: true

        if (!alreadyAwake) {
            acquireWakeLock()
            delay(150)
        }

        return try {
            block()
        } finally {
            if (!alreadyAwake) {
                delay(HOLD_MS)
                releaseWakeLock()
            }
        }
    }

    @Synchronized
    private fun acquireWakeLock() {
        val pm = powerManager ?: return
        wakeLock?.takeIf { it.isHeld }?.release()
        @Suppress("DEPRECATION")
        wakeLock = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
            PowerManager.ACQUIRE_CAUSES_WAKEUP or
            PowerManager.ON_AFTER_RELEASE,
            "hermes:bridge_action"
        ).apply { acquire(10_000) }
    }

    @Synchronized
    private fun releaseWakeLock() {
        try {
            wakeLock?.takeIf { it.isHeld }?.release()
        } catch (_: Exception) {}
        wakeLock = null
    }

    fun forceRelease() = releaseWakeLock()
}
