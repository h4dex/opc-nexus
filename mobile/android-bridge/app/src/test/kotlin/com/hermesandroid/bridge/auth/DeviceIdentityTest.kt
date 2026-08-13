package com.hermesandroid.bridge.auth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec

class DeviceIdentityTest {
    private fun keyPair() = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }

    @Test
    fun `P-256 identity signs the versioned device challenge`() {
        val keys = keyPair()
        val signature = DeviceIdentity.signChallenge(keys.private, "device-123", "nonce-456")

        assertTrue(DeviceIdentity.verifyChallenge(keys.public, "device-123", "nonce-456", signature))
    }

    @Test
    fun `signature cannot be replayed for another device or challenge`() {
        val keys = keyPair()
        val signature = DeviceIdentity.signChallenge(keys.private, "device-123", "nonce-456")

        assertFalse(DeviceIdentity.verifyChallenge(keys.public, "device-999", "nonce-456", signature))
        assertFalse(DeviceIdentity.verifyChallenge(keys.public, "device-123", "nonce-other", signature))
        assertFalse(DeviceIdentity.verifyChallenge(keys.public, "device-123", "nonce-456", "not-base64"))
    }
}
