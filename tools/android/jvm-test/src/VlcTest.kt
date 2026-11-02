package app.dsp.phone.vlctest

import app.dsp.phone.VlcArgs
import app.dsp.phone.VlcOutArgs
import app.dsp.phone.VlcVideoArgs
import app.dsp.phone.MjpegRelay
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.Executors

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
    // VLC Out
    val tc = "transcode{acodec=mp3,ab=128,channels=2,samplerate=48000}"
    ok("out http mp3", VlcOutArgs.sout("http", "mp3", 128, 48000, 2, "", 8080, "/live", "", "", "", 4) == ":sout=#$tc:std{access=http,mux=mp3,dst=:8080/live}")
    ok("out rtp multicast", VlcOutArgs.sout("rtp", "aac", 96, 44100, 1, "239.1.1.1", 5004, "", "", "", "", 99) == ":sout=#transcode{acodec=mp4a,ab=96,channels=1,samplerate=44100}:rtp{dst=239.1.1.1,port=5004,mux=ts,ttl=32}")
    ok("out icecast", VlcOutArgs.sout("icecast", "mp3", 128, 48000, 2, "ice.h", 8000, "stream", "source", "pw", "", 4) == ":sout=#$tc:std{access=shout,mux=mp3,dst='//source:pw@ice.h:8000/stream'}")
    ok("out opus rate fixed, bitrate clamped", VlcOutArgs.sout("icecast", "opus", 5, 44100, 2, "h", 1, "m", "s", "p", "", 4)!!.contains("samplerate=48000") && VlcOutArgs.sout("icecast", "opus", 5000, 44100, 2, "h", 1, "m", "s", "p", "", 4)!!.contains("ab=320") && VlcOutArgs.sout("http", "opus", 5, 44100, 2, "", 8080, "m", "", "", "", 4)!!.contains("ab=32,"))
    ok("out file", VlcOutArgs.sout("file", "flac", 128, 48000, 2, "", 0, "", "", "", "/d/a.flac", 4)!!.endsWith("std{access=file,mux=raw,dst='/d/a.flac'}"))
    ok("out refused combos", VlcOutArgs.sout("rtp", "opus", 128, 48000, 2, "h", 1, "", "", "", "", 4) == null && VlcOutArgs.sout("icecast", "aac", 128, 48000, 2, "h", 1, "m", "s", "p", "", 4) == null
        && VlcOutArgs.sout("renderer", "mp3", 128, 48000, 2, "", 0, "", "", "", "", 4) == null && VlcOutArgs.sout("http", "wav", 128, 48000, 2, "", 8080, "m", "", "", "", 4) == null)
    ok("out fields", VlcOutArgs.hostOk("239.1.1.1") && VlcOutArgs.hostOk("ice.example.org") && VlcOutArgs.hostOk("[fe80::1]") && !VlcOutArgs.hostOk("a b") && !VlcOutArgs.hostOk("h'}:sout=#x") && !VlcOutArgs.hostOk(""))
    ok("out path/file/cred", VlcOutArgs.mountOk("a/b-c.mp3") && !VlcOutArgs.mountOk("../x") && !VlcOutArgs.mountOk("a b") && VlcOutArgs.fileOk("my-rec_1.mp3") && !VlcOutArgs.fileOk("../a") && !VlcOutArgs.fileOk(".hid") && !VlcOutArgs.fileOk("a/b")
        && VlcOutArgs.credOk("hackme") && !VlcOutArgs.credOk("p@ss") && !VlcOutArgs.credOk("a'b") && !VlcOutArgs.credOk("a b") && !VlcOutArgs.credOk("a,b") && !VlcOutArgs.credOk("x".repeat(101)))
    val oi = VlcOutArgs.input(40000, 48000, 2, 300, true)
    ok("out input: raw s16le from loopback", oi.first == "udp://@127.0.0.1:40000" && oi.second.containsAll(listOf(":demux=rawaud", ":rawaud-fourcc=s16l", ":rawaud-channels=2", ":rawaud-samplerate=48000", ":network-caching=300")) && VlcOutArgs.input(10, 1, 9, 1, false).first == "udp://@127.0.0.1:1024")
    ok("out pick device", VlcOutArgs.pick(listOf("Living Room TV", "Kitchen speaker"), "kitchen") == 1 && VlcOutArgs.pick(listOf("A", "AB"), "a") == 0 && VlcOutArgs.pick(listOf("A"), "") == -1 && VlcOutArgs.pick(listOf("A"), "z") == -1)
    // видео: MJPEG на loopback + мост с CORS
    ok("video sout", VlcVideoArgs.sout(45000, 10, 640, 1500) == ":sout=#transcode{vcodec=MJPG,vb=1500,fps=10,width=640,acodec=none}:std{access=http{mime=multipart/x-mixed-replace;boundary=--dspframe},mux=mpjpeg,dst=127.0.0.1:45000/v.mjpg}")
    ok("video sout clamps", VlcVideoArgs.sout(1, 99, 9999, 1).let { it.contains("fps=30") && it.contains("width=1920") && it.contains("vb=100,") && it.contains("127.0.0.1:1024/") })
    ok("video options: no audio", VlcVideoArgs.options(45000, 10, 640, 1500, 1).let { ":no-audio" in it && ":network-caching=100" in it })
    ok("request line", VlcVideoArgs.request("GET /a/v.mjpg?x=1 HTTP/1.1\r\nHost: h\r\n\r\n") == ("GET" to "/a/v.mjpg") && VlcVideoArgs.request("junk") == null && VlcVideoArgs.request("GET /x") == null)
    ok("content type", VlcVideoArgs.contentType("HTTP/1.0 200 OK\r\ncontent-type:  multipart/x-mixed-replace;boundary=--b\r\n\r\n") == "multipart/x-mixed-replace;boundary=--b" && VlcVideoArgs.contentType("HTTP/1.0 200 OK\r\n\r\n") == null)
    val pool = Executors.newCachedThreadPool()
    val frames = ByteArray(40000) { i -> (i * 7).toByte() }
    val fake = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
    pool.execute {
        try { while (true) { val c = fake.accept(); pool.execute { c.use { x ->
            val b = StringBuilder(); val i = x.getInputStream()
            while (!b.endsWith("\r\n\r\n")) { val r = i.read(); if (r < 0) break; b.append(r.toChar()) }
            val o = x.getOutputStream()
            if (b.startsWith("GET /v.mjpg ")) { o.write("HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace;boundary=--dspframe\r\n\r\n".toByteArray()); o.write(frames); o.flush() }
        } } } } catch (e: Exception) { }
    }
    val relay = MjpegRelay(fake.localPort, pool); relay.start()
    val rc = URL(relay.url).openConnection() as HttpURLConnection
    val got = rc.inputStream.readBytes()
    ok("relay: status, CORS and the type of libVLC passed on", rc.responseCode == 200 && rc.getHeaderField("Access-Control-Allow-Origin") == "*" && rc.contentType == "multipart/x-mixed-replace;boundary=--dspframe", rc.contentType ?: "")
    ok("relay: the body arrives intact", got.contentEquals(frames), "${got.size}")
    val rb = URL(relay.url.replace(Regex("/[0-9a-f]{24}/"), "/00/")).openConnection() as HttpURLConnection
    ok("relay: a wrong token gets 404", rb.responseCode == 404)
    val opt = URL(relay.url).openConnection() as HttpURLConnection; opt.requestMethod = "OPTIONS"
    ok("relay: preflight", opt.responseCode == 204 && opt.getHeaderField("Access-Control-Allow-Origin") == "*")
    ok("relay: only loopback, address has a token", relay.url.startsWith("http://127.0.0.1:") && Regex("/[0-9a-f]{24}/v\\.mjpg$").containsMatchIn(relay.url))
    relay.close(); fake.close(); pool.shutdownNow()
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
