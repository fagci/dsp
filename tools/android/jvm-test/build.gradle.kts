// Логика моста (сервер) на обычной JVM против настоящих классов Android (robolectric android-all):
//   cd tools/android/jvm-test && gradle runTests   (сервер, разбор BLE / Wi-Fi IE / ГНСС)
// Датчики и WebView здесь не проверяются — им нужен телефон.
plugins { kotlin("jvm") version "2.0.21"; application }
repositories { mavenCentral() }
dependencies {
    compileOnly("org.robolectric:android-all:14-robolectric-10818077"); runtimeOnly("org.robolectric:android-all:14-robolectric-10818077")
    // libtorrent для TorrentHub.kt: на JVM — настоящая нативная сборка под Linux (тест раздачи и стриминга по Range)
    implementation("org.libtorrent4j:libtorrent4j:2.1.0-39"); runtimeOnly("org.libtorrent4j:libtorrent4j-linux:2.1.0-39")
}
// NativePlayer.kt (ExoPlayer, media3) собирается только в приложении; MainActivity находит его по имени (PlayerApi.kt — общий интерфейс)
sourceSets { main { kotlin.srcDir("src"); kotlin.srcDir("../app/src/main/java"); kotlin.exclude("**/NativePlayer.kt") } }
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
tasks.register<JavaExec>("runAlarmTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.alarmtest.AlarmTestKt")
}
tasks.register<JavaExec>("runBootTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.boottest.BootTestKt")
}
tasks.register<JavaExec>("runCalTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.caltest.CalTestKt")
}
tasks.register<JavaExec>("runRecTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.rectest.RecTestKt")
}
tasks.register<JavaExec>("runMicTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.mictest.MicTestKt")
}
tasks.register<JavaExec>("runCallTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.calltest.CallTestKt")
}
tasks.register<JavaExec>("runFsTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.fstest.FsTestKt")
}
tasks.register<JavaExec>("runDialTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.dialtest.DialTestKt")
}
tasks.register<JavaExec>("runScreenTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.screentest.ScreenTestKt")
}
tasks.register<JavaExec>("runShortcutTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.shortcuttest.ShortcutTestKt")
}
tasks.register<JavaExec>("runScanDiagTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.scandiagtest.ScanDiagTestKt")
}
// нативная libtorrent под Linux лежит в jar: System.loadLibrary("torrent4j") ищет её в java.library.path
val ltNative = tasks.register<Copy>("ltNative") {
    from(configurations.runtimeClasspath.get().filter { it.name.startsWith("libtorrent4j-linux") }.map { zipTree(it) }) { include("lib/x86_64/*.so"); eachFile { path = name }; includeEmptyDirs = false }
    into(layout.buildDirectory.dir("ltnative"))
}
tasks.register<JavaExec>("runTorrentTest") {
    dependsOn(ltNative)
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.torrenttest.TorrentTestKt")
    jvmArgs("-Djava.library.path=" + layout.buildDirectory.dir("ltnative").get().asFile.absolutePath)
}
tasks.register<JavaExec>("runRtpTest") {
    classpath = sourceSets.main.get().runtimeClasspath; mainClass.set("app.dsp.phone.rtptest.RtpTestKt")
}
tasks.register("runTests") { dependsOn("runTorrentTest", "runRtpTest", "runScanDiagTest", "runShortcutTest", "runScreenTest", "runDialTest", "runFsTest", "runCallTest", "runMicTest", "runServerTest", "runRecordsTest", "runAlarmTest", "runBootTest", "runCalTest", "runRecTest", "runProxyTest", "runVpnEngineTest", "runTlsTest", "runTlsStoreTest") }
