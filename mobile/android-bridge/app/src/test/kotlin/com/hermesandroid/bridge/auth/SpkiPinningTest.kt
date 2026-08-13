package com.hermesandroid.bridge.auth

import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64

class SpkiPinningTest {
    private fun publicKey(): PublicKey = KeyPairGenerator.getInstance("EC").run {
        initialize(256)
        generateKeyPair().public
    }

    private fun certificate(key: PublicKey): X509Certificate = object : X509Certificate() {
        override fun getPublicKey(): PublicKey = key
        override fun checkValidity() = Unit
        override fun checkValidity(date: java.util.Date?) = Unit
        override fun getEncoded(): ByteArray = byteArrayOf()
        override fun verify(key: PublicKey?) = Unit
        override fun verify(key: PublicKey?, sigProvider: String?) = Unit
        override fun toString(): String = "test certificate"
        override fun getVersion(): Int = 3
        override fun getSerialNumber(): java.math.BigInteger = java.math.BigInteger.ONE
        override fun getIssuerDN(): java.security.Principal? = null
        override fun getSubjectDN(): java.security.Principal? = null
        override fun getNotBefore(): java.util.Date = java.util.Date(0)
        override fun getNotAfter(): java.util.Date = java.util.Date(Long.MAX_VALUE)
        override fun getTBSCertificate(): ByteArray = byteArrayOf()
        override fun getSignature(): ByteArray = byteArrayOf()
        override fun getSigAlgName(): String = "SHA256withECDSA"
        override fun getSigAlgOID(): String = "1.2.840.10045.4.3.2"
        override fun getSigAlgParams(): ByteArray? = null
        override fun getIssuerUniqueID(): BooleanArray? = null
        override fun getSubjectUniqueID(): BooleanArray? = null
        override fun getKeyUsage(): BooleanArray? = null
        override fun getBasicConstraints(): Int = -1
        override fun hasUnsupportedCriticalExtension(): Boolean = false
        override fun getCriticalExtensionOIDs(): MutableSet<String>? = null
        override fun getNonCriticalExtensionOIDs(): MutableSet<String>? = null
        override fun getExtensionValue(oid: String?): ByteArray? = null
    }

    private fun pin(key: PublicKey): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(key.encoded)
        return "sha256/${Base64.getEncoder().encodeToString(digest)}"
    }

    @Test
    fun `accepts the pinned leaf SPKI`() {
        val key = publicKey()
        SpkiPinning(pin(key)).checkServerTrusted(arrayOf(certificate(key)), "ECDHE_ECDSA")
    }

    @Test
    fun `rejects a different leaf SPKI and missing chains`() {
        val expected = publicKey()
        val trust = SpkiPinning(pin(expected))

        assertThrows(CertificateException::class.java) {
            trust.checkServerTrusted(arrayOf(certificate(publicKey())), "ECDHE_ECDSA")
        }
        assertThrows(CertificateException::class.java) { trust.checkServerTrusted(emptyArray(), "ECDHE_ECDSA") }
    }
}
