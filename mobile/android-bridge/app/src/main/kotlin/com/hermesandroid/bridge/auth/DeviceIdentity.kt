package com.hermesandroid.bridge.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.PrivateKey
import java.security.PublicKey
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

object DeviceIdentity {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "opcnexus_mobile_identity_v1"
    private const val SIGNING_PREFIX = "opcnexus-mobile-v1"

    private fun entry(): KeyStore.PrivateKeyEntry {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val existing = store.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry
        if (existing != null) return existing
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build()
        )
        generator.generateKeyPair()
        return store.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
    }

    fun publicKeyBase64(): String = Base64.getEncoder().encodeToString(entry().certificate.publicKey.encoded)

    fun signChallenge(deviceId: String, nonce: String): String {
        return signChallenge(entry().privateKey, deviceId, nonce)
    }

    internal fun challengePayload(deviceId: String, nonce: String): ByteArray {
        require(deviceId.isNotBlank()) { "Device ID is required" }
        require(nonce.isNotBlank()) { "Challenge nonce is required" }
        return "$SIGNING_PREFIX\n$deviceId\n$nonce".toByteArray(Charsets.UTF_8)
    }

    internal fun signChallenge(privateKey: PrivateKey, deviceId: String, nonce: String): String {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(privateKey)
        signature.update(challengePayload(deviceId, nonce))
        return Base64.getEncoder().encodeToString(signature.sign())
    }

    internal fun verifyChallenge(publicKey: PublicKey, deviceId: String, nonce: String, encodedSignature: String): Boolean {
        val signatureBytes = try {
            Base64.getDecoder().decode(encodedSignature)
        } catch (_: IllegalArgumentException) {
            return false
        }
        return Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey)
            update(challengePayload(deviceId, nonce))
            verify(signatureBytes)
        }
    }
}
