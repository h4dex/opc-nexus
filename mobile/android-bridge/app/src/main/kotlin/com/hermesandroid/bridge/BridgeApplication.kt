package com.hermesandroid.bridge

import android.app.Application
import com.hermesandroid.bridge.client.RelayClient
import com.hermesandroid.bridge.model.DeviceCapabilities
import com.hermesandroid.bridge.power.WakeLockManager

class BridgeApplication : Application() {
    companion object {
        lateinit var instance: BridgeApplication
            private set
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        DeviceCapabilities.init(applicationContext)
        WakeLockManager.init(applicationContext)
        RelayClient.init(applicationContext)
        if (RelayClient.connectionEnabled) RelayClient.connectStored()
    }
}
