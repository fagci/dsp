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
    lint { checkReleaseBuilds = false }                                    // lintVital в assembleRelease съедает ~30 с на каждой сборке; ловит только фатальное (манифест), компиляция и проверки моста это и так покрывают
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

// Нативный слой (whisper.cpp, native/): собирается скриптом native/build.sh из исходников по тегу — нужны NDK, git, cmake и сеть.
// Без него (-PnoNative) приложение собирается как раньше, а речь на телефоне просто недоступна (ai.caps покажет, что нативной библиотеки нет).
val nativeOut = layout.buildDirectory.dir("generated/jniLibs")
val buildNative by tasks.registering(Exec::class) {
    onlyIf { !project.hasProperty("noNative") }
    inputs.dir("../native"); outputs.dir(nativeOut)
    val ndk = System.getenv("ANDROID_NDK_HOME") ?: System.getenv("ANDROID_NDK_ROOT")
        ?: "${System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT") ?: ""}/ndk/" + (File("${System.getenv("ANDROID_HOME") ?: ""}/ndk").list()?.maxOrNull() ?: "")
    commandLine("bash", rootDir.resolve("native/build.sh").absolutePath, ndk, nativeOut.get().asFile.absolutePath)
}
android.sourceSets["main"].jniLibs.srcDir(nativeOut)
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(buildNative) }

dependencies {
    // Торренты (команды torrent.* моста, TorrentHub.kt): libtorrent; ARM — телефоны и приставки
    val lt = "2.1.0-39"
    implementation("org.libtorrent4j:libtorrent4j:$lt")
    implementation("org.libtorrent4j:libtorrent4j-android-arm64:$lt")
    implementation("org.libtorrent4j:libtorrent4j-android-arm:$lt")
    // libVLC 3.6 (LGPL 2.1): открывает любой адрес (VlcHub.kt) — mkv / avi / DivX, AC3 / DTS, rtmp, rtsp, multicast, smb:// ftp:// sftp:// nfs:// upnp:// — и отдаёт странице звук, MJPEG или HLS; плеера в приложении нет, играет <video> страницы
    implementation("org.videolan.android:libvlc-all:3.6.0")
}
