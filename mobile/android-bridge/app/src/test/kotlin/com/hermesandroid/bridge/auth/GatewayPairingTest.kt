package com.hermesandroid.bridge.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayPairingTest {
    private val now = 1_700_000_000_000L
    private val secret = "A".repeat(43)
    private val pin = "sha256/${"A".repeat(43)}="

    private fun payload(
        url: String = "wss://192.168.50.10:19443/v1/device",
        expiresAt: Long = now + 300_000,
        version: Int = 1,
    ) = """{"v":$version,"url":"$url","pairingId":"12345678-abcd","secret":"$secret","spki":"$pin","expiresAt":$expiresAt}"""

    @Test
    fun `parses a current RFC1918 WSS pairing offer`() {
        val pairing = GatewayPairing.parse(payload(), now)

        assertEquals(1, pairing.protocolVersion)
        assertEquals("wss://192.168.50.10:19443/v1/device", pairing.url)
        assertEquals(secret, pairing.secret)
    }

    @Test
    fun `parses the formatted JSON copied by the desktop app`() {
        val copied = """
            {
              "v": 1,
              "url": "wss://192.168.50.10:19443/v1/device",
              "pairingId": "12345678-abcd",
              "secret": "$secret",
              "spki": "$pin",
              "expiresAt": ${now + 300_000}
            }
        """.trimIndent()

        val pairing = GatewayPairing.parse(copied, now)

        assertEquals("12345678-abcd", pairing.pairingId)
        assertEquals(now + 300_000, pairing.expiresAt)
    }

    @Test
    fun `accepts all RFC1918 ranges`() {
        listOf("10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.2").forEach { host ->
            assertEquals(host, java.net.URI(GatewayPairing.parse(payload(url = "wss://$host:19443/v1/device"), now).url).host)
        }
    }

    @Test
    fun `rejects expired or unexpectedly long lived offers`() {
        assertThrows(IllegalArgumentException::class.java) { GatewayPairing.parse(payload(expiresAt = now), now) }
        assertThrows(IllegalArgumentException::class.java) { GatewayPairing.parse(payload(expiresAt = now + 600_001), now) }
    }

    @Test
    fun `rejects cleartext public and loopback endpoints`() {
        listOf(
            "ws://192.168.1.2:19443/v1/device",
            "wss://8.8.8.8:19443/v1/device",
            "wss://127.0.0.1:19443/v1/device",
            "wss://192.168.1.2:19443/other",
        ).forEach { url ->
            assertThrows(url, IllegalArgumentException::class.java) { GatewayPairing.parse(payload(url = url), now) }
        }
    }

    @Test
    fun `rejects unsupported protocol versions`() {
        assertThrows(IllegalArgumentException::class.java) { GatewayPairing.parse(payload(version = 2), now) }
    }
}
