plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.hermesandroid.bridge"
    compileSdk = 34

    val releaseSigning = mapOf(
        "keystore" to System.getenv("OPCNEXUS_ANDROID_KEYSTORE"),
        "storePassword" to System.getenv("OPCNEXUS_ANDROID_STORE_PASSWORD"),
        "keyAlias" to System.getenv("OPCNEXUS_ANDROID_KEY_ALIAS"),
        "keyPassword" to System.getenv("OPCNEXUS_ANDROID_KEY_PASSWORD"),
    )
    val releaseRequested = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
    if (releaseRequested && releaseSigning.values.any { it.isNullOrBlank() }) {
        throw GradleException(
            "Release signing requires OPCNEXUS_ANDROID_KEYSTORE, OPCNEXUS_ANDROID_STORE_PASSWORD, " +
                "OPCNEXUS_ANDROID_KEY_ALIAS and OPCNEXUS_ANDROID_KEY_PASSWORD"
        )
    }

    defaultConfig {
        applicationId = "com.senke.opcnexus.bridge"
        minSdk = 26
        targetSdk = 34
        versionCode = 5
        versionName = "0.4.3"
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }

    signingConfigs {
        if (releaseSigning.values.none { it.isNullOrBlank() }) {
            create("production") {
                storeFile = file(releaseSigning.getValue("keystore")!!)
                storePassword = releaseSigning.getValue("storePassword")
                keyAlias = releaseSigning.getValue("keyAlias")
                keyPassword = releaseSigning.getValue("keyPassword")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            manifestPlaceholders["usesCleartextTraffic"] = "false"
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("production")
            manifestPlaceholders["usesCleartextTraffic"] = "false"
        }
    }

    applicationVariants.all {
        val variant = this
        outputs.all {
            (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl)
                .outputFileName = "opcnexus-mobile-bridge-${variant.versionName}-${variant.buildType.name}.apk"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/INDEX.LIST",
                "META-INF/io.netty.versions.properties",
                "META-INF/DEPENDENCIES",
            )
        }
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    implementation(libs.androidx.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.gson)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.robolectric)
    testImplementation(libs.kotlinx.coroutines.test)
}

val verifyNoLocalListener by tasks.registering {
    group = "verification"
    description = "Reject Android main-source APIs that can open a local listening socket"
    doLast {
        val forbidden = listOf(
            "embeddedServer(" to "Ktor embedded server",
            "java.net.ServerSocket" to "TCP server socket",
            "java.nio.channels.ServerSocketChannel" to "NIO server socket",
            "android.net.LocalServerSocket" to "Android local server socket",
        )
        val violations = fileTree("src/main") {
            include("**/*.kt", "**/*.java")
        }.files.flatMap { source ->
            val content = source.readText()
            forbidden.filter { (marker, _) -> content.contains(marker) }
                .map { (_, label) -> "${source.relativeTo(projectDir)}: $label" }
        }
        if (violations.isNotEmpty()) {
            throw GradleException(
                "OPC-Nexus Android Bridge must be outbound-WSS-only; local listeners are forbidden:\n" +
                    violations.joinToString("\n")
            )
        }
    }
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(verifyNoLocalListener)
}
