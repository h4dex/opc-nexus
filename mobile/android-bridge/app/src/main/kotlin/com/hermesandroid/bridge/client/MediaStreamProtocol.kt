package com.hermesandroid.bridge.client

/** Binary media frame shared with the OPC-Nexus Mobile Gateway protocol. */
object MediaStreamProtocol {
    const val MAX_REQUEST_ID_BYTES = 128
    const val MAX_CHUNK_BYTES = 64 * 1024

    data class Frame(val requestId: String, val payload: ByteArray)

    fun encode(requestId: String, payload: ByteArray, payloadLength: Int = payload.size): ByteArray {
        val id = requestId.toByteArray(Charsets.UTF_8)
        require(id.size in 1..MAX_REQUEST_ID_BYTES) { "requestId must encode to 1..$MAX_REQUEST_ID_BYTES bytes" }
        require(payloadLength in 0..minOf(payload.size, MAX_CHUNK_BYTES)) { "Invalid media payload length" }

        return ByteArray(2 + id.size + payloadLength).also { frame ->
            frame[0] = ((id.size ushr 8) and 0xff).toByte()
            frame[1] = (id.size and 0xff).toByte()
            id.copyInto(frame, 2)
            payload.copyInto(frame, 2 + id.size, 0, payloadLength)
        }
    }

    fun decode(frame: ByteArray): Frame {
        require(frame.size >= 3) { "Media frame is too short" }
        val idLength = ((frame[0].toInt() and 0xff) shl 8) or (frame[1].toInt() and 0xff)
        require(idLength in 1..MAX_REQUEST_ID_BYTES && frame.size >= 2 + idLength) { "Invalid media requestId length" }
        val payloadLength = frame.size - 2 - idLength
        require(payloadLength <= MAX_CHUNK_BYTES) { "Media frame exceeds the chunk limit" }
        val requestId = frame.copyOfRange(2, 2 + idLength).toString(Charsets.UTF_8)
        require(requestId.toByteArray(Charsets.UTF_8).contentEquals(frame.copyOfRange(2, 2 + idLength))) {
            "Media requestId is not valid UTF-8"
        }
        return Frame(requestId, frame.copyOfRange(2 + idLength, frame.size))
    }
}
