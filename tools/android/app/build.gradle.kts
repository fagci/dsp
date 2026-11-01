plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.dsp.phone"
    compileSdk = 35
    defaultConfig {
        applicationId = "app.dsp.phone"
        minSdk = 26
        targetSdk = 34
        versionCode = (findProperty("versionCode") as String?)?.toIntOrNull() ?: 1       // в Actions — номер запуска
        versionName = "1.$versionCode"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }          // libVLC и libtorrent собраны для ARM; x86 в APK не нужен (+60 МБ)
    }
    // Один ключ на все сборки (лежит в репозитории): обновления ставятся поверх. Это не магазинный ключ — для своей установки.
    signingConfigs {
        create("dsp") {
            storeFile = rootDir.resolve("dsp.keystore")
            storePassword = "android"; keyAlias = "dsp"; keyPassword = "android"
        }
    }
    buildTypes {
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("dsp") }
        debug { signingConfig = signingConfigs.getByName("dsp") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    androidResources { noCompress += listOf("wasm", "onnx", "bin", "img") }
    packaging { jniLibs { useLegacyPackaging = true } }                    // библиотеки libVLC / libtorrent сжимаются в APK (иначе ~+80 МБ к загрузке)
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/web"))
}

// Само приложение (корень репозитория) кладём в assets/www: WebView отдаёт его офлайн
val copyWeb by tasks.registering(Sync::class) {
    from(rootDir.resolve("../..")) {
        include("index.html", "manifest.json", "favicon.svg", "styles.css", "*.js", "README.md")   // README.md и help/ — справка в приложении
        include("icons/**", "modules/**", "vendor/**", "data/**", "help/**")
    }
    into(layout.buildDirectory.dir("generated/web/www"))
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(copyWeb) }

// Нативный плеер (ExoPlayer): mkv / ts / avi, AC3 / DTS, udp:// и rtp:// multicast, rtsp://, HLS / DASH системными декодерами
dependencies {
    val media3 = "1.4.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-exoplayer-dash:$media3")
    implementation("androidx.media3:media3-exoplayer-rtsp:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    // Торренты (команды torrent.* моста, TorrentHub.kt): libtorrent; ARM — телефоны и приставки
    val lt = "2.1.0-39"
    implementation("org.libtorrent4j:libtorrent4j:$lt")
    implementation("org.libtorrent4j:libtorrent4j-android-arm64:$lt")
    implementation("org.libtorrent4j:libtorrent4j-android-arm:$lt")
    // libVLC 3.6 (LGPL 2.1): второй нативный движок, VlcPlayer.kt — mkv / avi / DivX, AC3 / DTS, rtmp, smb:// ftp:// sftp:// nfs:// upnp://
    implementation("org.videolan.android:libvlc-all:3.6.0")
}
