package com.hermesandroid.bridge.auth

import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.Base64
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class SpkiPinning(private val expectedPin: String) : X509TrustManager {
    init {
        require(expectedPin.matches(Regex("sha256/[A-Za-z0-9+/]{43}="))) { "Invalid SPKI pin" }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) = throw java.security.cert.CertificateException("Client certificates are not accepted")

    override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw java.security.cert.CertificateException("Server certificate is missing")
        val digest = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
        val actual = "sha256/${Base64.getEncoder().encodeToString(digest)}"
        if (!MessageDigest.isEqual(actual.toByteArray(Charsets.US_ASCII), expectedPin.toByteArray(Charsets.US_ASCII))) {
            throw java.security.cert.CertificateException("OPC-Nexus Gateway SPKI fingerprint mismatch")
        }
        leaf.checkValidity()
    }

    fun socketFactory(): SSLSocketFactory {
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf<TrustManager>(this), null)
        return context.socketFactory
    }

    val hostnameVerifier = HostnameVerifier { _, session ->
        try {
            checkServerTrusted(arrayOf(session.peerCertificates.first() as X509Certificate), "UNKNOWN")
            true
        } catch (_: Exception) {
            false
        }
    }
}
