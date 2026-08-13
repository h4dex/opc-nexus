package com.hermesandroid.bridge.executor

import android.location.Location
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ActionExecutorLocationTest {
    @Test
    fun `location result preserves coordinates and provider`() {
        val location = Location("gps").apply {
            latitude = 31.2304
            longitude = 121.4737
            accuracy = 3.5f
            altitude = 8.0
            time = 1_700_000_000_000L
        }

        val result = ActionExecutor.locationResult(location)

        assertTrue(result.success)
        @Suppress("UNCHECKED_CAST")
        val data = result.data as Map<String, Any>
        assertEquals(31.2304, data["latitude"] as Double, 0.000001)
        assertEquals(121.4737, data["longitude"] as Double, 0.000001)
        assertEquals("gps", data["provider"])
        assertEquals(1_700_000_000_000L, data["timestamp"])
    }
}
