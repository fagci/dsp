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
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes {
        release { isMinifyEnabled = false }
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
        include("index.html", "manifest.json", "favicon.svg", "styles.css", "*.js")
        include("icons/**", "modules/**", "vendor/**", "data/**")
    }
    into(layout.buildDirectory.dir("generated/web/www"))
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(copyWeb) }
