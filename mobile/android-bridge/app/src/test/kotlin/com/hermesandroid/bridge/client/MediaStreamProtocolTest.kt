package com.hermesandroid.bridge.client

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MediaStreamProtocolTest {
    @Test
    fun `round trips request id and payload with big endian prefix`() {
        val payload = byteArrayOf(1, 2, 3, 4)
        val encoded = MediaStreamProtocol.encode("request-123", payload)

        assertEquals(0, encoded[0].toInt())
        assertEquals("request-123".length, encoded[1].toInt())
        val decoded = MediaStreamProtocol.decode(encoded)
        assertEquals("request-123", decoded.requestId)
        assertArrayEquals(payload, decoded.payload)
    }

    @Test
    fun `honors the supplied payload count without leaking stale buffer bytes`() {
        val decoded = MediaStreamProtocol.decode(MediaStreamProtocol.encode("req", byteArrayOf(9, 8, 7, 6), 2))
        assertArrayEquals(byteArrayOf(9, 8), decoded.payload)
    }

    @Test
    fun `enforces request id and 64 KiB chunk boundaries`() {
        MediaStreamProtocol.encode("r", ByteArray(MediaStreamProtocol.MAX_CHUNK_BYTES))

        assertThrows(IllegalArgumentException::class.java) {
            MediaStreamProtocol.encode("", byteArrayOf(1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            MediaStreamProtocol.encode("r".repeat(129), byteArrayOf(1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            MediaStreamProtocol.encode("r", ByteArray(MediaStreamProtocol.MAX_CHUNK_BYTES + 1))
        }
    }

    @Test
    fun `rejects malformed frames`() {
        assertThrows(IllegalArgumentException::class.java) { MediaStreamProtocol.decode(byteArrayOf(0, 1)) }
        assertThrows(IllegalArgumentException::class.java) { MediaStreamProtocol.decode(byteArrayOf(0, 8, 1)) }
    }
}
