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
