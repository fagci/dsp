// Логика моста (сервер, поворот кадра) на обычной JVM против настоящих классов Android (robolectric android-all):
//   cd tools/android/jvm-test && gradle runTests   (сервер, поворот кадра, разбор BLE / Wi-Fi IE / ГНСС)
// Камера, датчики и WebView здесь не проверяются — им нужен телефон.
plugins { kotlin("jvm") version "2.0.21"; application }
repositories { mavenCentral() }
dependencies { compileOnly("org.robolectric:android-all:14-robolectric-10818077"); runtimeOnly("org.robolectric:android-all:14-robolectric-10818077") }
sourceSets { main { kotlin.srcDir("src"); kotlin.srcDir("../app/src/main/java") } }
application { mainClass.set("app.dsp.phone.ServerTestKt") }
tasks.register<JavaExec>("runRotTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.RotTestKt")
}
tasks.register<JavaExec>("runServerTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.ServerTestKt")
    jvmArgs("-Djdk.httpclient.allowRestrictedHeaders=origin")
}
tasks.register<JavaExec>("runRecordsTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.recordstest.RecordsTestKt")
}
tasks.register<JavaExec>("runProxyTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.proxytest.ProxyTestKt")
}
tasks.register("runTests") { dependsOn("runRotTest", "runServerTest", "runRecordsTest", "runProxyTest") }
