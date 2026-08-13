package com.hermesandroid.bridge.debug

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.util.Log
import com.hermesandroid.bridge.auth.GatewayPairing
import com.hermesandroid.bridge.client.RelayClient

/** ADB-only pairing entry point compiled into debug builds. */
class DebugPairingReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_PAIR) {
            setResultCode(Activity.RESULT_CANCELED)
            setResultData("unsupported_action")
            return
        }

        try {
            val encoded = requireNotNull(intent.getStringExtra(EXTRA_PAYLOAD_BASE64)) {
                "Missing pairing payload"
            }
            val payload = String(
                Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),
                Charsets.UTF_8,
            )
            RelayClient.pair(GatewayPairing.parse(payload))
            setResultCode(Activity.RESULT_OK)
            setResultData("pairing_started")
        } catch (error: Exception) {
            Log.e(TAG, "Debug pairing failed", error)
            setResultCode(Activity.RESULT_CANCELED)
            setResultData("pairing_failed:${error.message ?: error.javaClass.simpleName}")
        }
    }

    companion object {
        const val ACTION_PAIR = "com.senke.opcnexus.bridge.debug.PAIR"
        const val EXTRA_PAYLOAD_BASE64 = "payload_b64"
        private const val TAG = "OpcNexusDebugPair"
    }
}
