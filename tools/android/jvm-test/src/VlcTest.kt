package app.dsp.phone.vlctest

import app.dsp.phone.VlcArgs

var bad = 0
fun ok(name: String, cond: Boolean, x: String = "") { if (!cond) { bad++; println("FAIL $name $x") } else println("ok   $name $x") }

fun main() {
    ok("sout: raw PCM over UDP to loopback", VlcArgs.sout(40000, 48000, 2) == ":sout=#transcode{acodec=s16l,channels=2,samplerate=48000}:std{access=udp,mux=raw,dst=127.0.0.1:40000}")
    ok("sout: mono, rate and port clamped", VlcArgs.sout(10, 1, 9) == ":sout=#transcode{acodec=s16l,channels=2,samplerate=8000}:std{access=udp,mux=raw,dst=127.0.0.1:1024}"
        && VlcArgs.sout(70000, 1_000_000, 1).contains("samplerate=192000") && VlcArgs.sout(70000, 44100, 0).contains("channels=1") && VlcArgs.sout(70000, 44100, 1).endsWith("127.0.0.1:65535}"))
    val o = VlcArgs.options(40001, 44100, 1, 50)
    ok("options: no video, no output to the speaker, caching clamped", o[0].contains("channels=1") && ":no-video" in o && ":no-sout-all" in o && ":network-caching=100" in o && VlcArgs.options(40001, 44100, 1, 99999).contains(":network-caching=10000"))
    for (u in listOf("http://h/a.mp3", "https://h/s", "rtsp://cam/x", "udp://@239.1.1.1:1234", "rtp://@239.1.1.1:5004", "smb://nas/v/a.flac", "SFTP://h/a", "upnp://uuid:1/2", "rtmp://h/live/s", "nfs://h/x"))
        ok("url ok: $u", VlcArgs.urlOk(u))
    for (u in listOf("file:///sdcard/a.mp3", "fd://3", "content://media/1", "javascript:alert(1)", "a.mp3", "", "http://h/\n:sout=#x", "gopher://x", "://x", "http://" + "x".repeat(2100)))
        ok("url refused: ${u.take(30).replace("\n", " ")}", !VlcArgs.urlOk(u))
    ok("port", VlcArgs.portOk(1024) && VlcArgs.portOk(65535) && !VlcArgs.portOk(80) && !VlcArgs.portOk(0) && !VlcArgs.portOk(70000))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
