package com.hermesandroid.bridge.media

import org.junit.Assert.assertEquals
import org.junit.Test

class ScreenRecorderDimensionsTest {
    @Test
    fun `scales portrait 1080p display to aligned 720p recording`() {
        assertEquals(720 to 1280, ScreenRecorder.recordingDimensions(1080, 1920))
    }

    @Test
    fun `scales landscape display without changing orientation`() {
        assertEquals(1280 to 720, ScreenRecorder.recordingDimensions(1920, 1080))
    }

    @Test
    fun `does not upscale smaller displays and aligns dimensions down`() {
        assertEquals(704 to 1248, ScreenRecorder.recordingDimensions(710, 1250))
    }
}
