package com.hermesandroid.bridge.auth

import com.google.gson.JsonParser
import java.net.URI

data class GatewayPairing(
    val protocolVersion: Int,
    val url: String,
    val pairingId: String,
    val secret: String,
    val spki: String,
    val expiresAt: Long,
) {
    companion object {
        fun parse(payload: String, now: Long = System.currentTimeMillis()): GatewayPairing {
            val json = try {
                JsonParser.parseString(payload).asJsonObject
            } catch (error: Exception) {
                throw IllegalArgumentException("配对二维码不是有效 JSON", error)
            }
            val protocolVersion = json.get("v")?.asInt ?: throw IllegalArgumentException("配对二维码缺少协议版本")
            require(protocolVersion == 1) { "不支持的 OPC-Nexus 手机协议版本: $protocolVersion" }
            val url = json.get("url")?.asString?.trim().orEmpty()
            val uri = try { URI(url) } catch (error: Exception) { throw IllegalArgumentException("网关地址无效", error) }
            require(uri.scheme == "wss" && !uri.host.isNullOrBlank() && uri.path == "/v1/device") { "网关必须使用 wss://.../v1/device" }
            require(isPrivateIpv4(uri.host)) { "首版只允许 RFC1918 局域网 IPv4" }
            val pairingId = json.get("pairingId")?.asString.orEmpty()
            require(pairingId.matches(Regex("[A-Za-z0-9-]{8,100}"))) { "配对 ID 无效" }
            val secret = json.get("secret")?.asString.orEmpty()
            require(secret.matches(Regex("[A-Za-z0-9_-]{40,100}"))) { "一次性配对密钥无效" }
            val spki = json.get("spki")?.asString.orEmpty()
            require(spki.matches(Regex("sha256/[A-Za-z0-9+/]{43}="))) { "服务器 SPKI 指纹无效" }
            val expiresAt = json.get("expiresAt")?.asLong ?: throw IllegalArgumentException("配对二维码缺少过期时间")
            require(expiresAt > now && expiresAt <= now + 10 * 60_000L) { "配对二维码已过期或有效期异常" }
            return GatewayPairing(protocolVersion, url, pairingId, secret, spki, expiresAt)
        }

        fun fromManual(url: String, pairingId: String, secret: String, spki: String): GatewayPairing {
            val normalized = if (url.trim().startsWith("wss://")) url.trim() else "wss://${url.trim()}"
            val withPath = if (URI(normalized).path.isNullOrBlank() || URI(normalized).path == "/") "$normalized/v1/device" else normalized
            val payload = """{"v":1,"url":"$withPath","pairingId":"$pairingId","secret":"$secret","spki":"$spki","expiresAt":${System.currentTimeMillis() + 5 * 60_000L}}"""
            return parse(payload)
        }

        private fun isPrivateIpv4(host: String): Boolean {
            val parts = host.split('.').mapNotNull { it.toIntOrNull() }
            if (parts.size != 4 || parts.any { it !in 0..255 }) return false
            return parts[0] == 10 || (parts[0] == 172 && parts[1] in 16..31) || (parts[0] == 192 && parts[1] == 168)
        }
    }
}
