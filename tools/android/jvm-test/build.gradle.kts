// Логика моста (сервер) на обычной JVM против настоящих классов Android (robolectric android-all):
//   cd tools/android/jvm-test && gradle runTests   (сервер, разбор BLE / Wi-Fi IE / ГНСС)
// Датчики и WebView здесь не проверяются — им нужен телефон.
plugins { kotlin("jvm") version "2.0.21"; application }
repositories { mavenCentral() }
dependencies { compileOnly("org.robolectric:android-all:14-robolectric-10818077"); runtimeOnly("org.robolectric:android-all:14-robolectric-10818077") }
sourceSets { main { kotlin.srcDir("src"); kotlin.srcDir("../app/src/main/java") } }
application { mainClass.set("app.dsp.phone.ServerTestKt") }
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
tasks.register<JavaExec>("runVpnEngineTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.vpntest.VpnEngineTestKt")
}
tasks.register<JavaExec>("runTlsTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.tlstest.TlsTestKt")
}
tasks.register<JavaExec>("runTlsStoreTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.tlsstoretest.TlsStoreTestKt")
}
tasks.register("runTests") { dependsOn("runServerTest", "runRecordsTest", "runProxyTest", "runVpnEngineTest", "runTlsTest", "runTlsStoreTest") }
