package app.dsp.phone.torrenttest

import app.dsp.phone.TorrentArgs
import app.dsp.phone.TorrentCore
import app.dsp.phone.TorrentHttp
import org.libtorrent4j.SessionManager
import org.libtorrent4j.SessionParams
import org.libtorrent4j.SettingsPack
import org.libtorrent4j.TcpEndpoint
import org.libtorrent4j.TorrentBuilder
import org.libtorrent4j.TorrentInfo
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.util.Random

var bad = 0
fun ok(name: String, cond: Boolean, x: String = "") { if (!cond) { bad++; println("FAIL $name $x") } else println("ok   $name $x") }

private fun get(url: String, range: String?): Triple<Int, ByteArray, Map<String, List<String>>> {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 10_000; c.readTimeout = 90_000
    if (range != null) c.setRequestProperty("Range", range)
    val code = c.responseCode
    val body = (if (code < 400) c.inputStream else c.errorStream)?.readBytes() ?: ByteArray(0)
    return Triple(code, body, c.headerFields)
}

private fun session(): SessionManager {
    val sp = SettingsPack()
    sp.listenInterfaces("127.0.0.1:0")
    sp.setEnableDht(false)
    sp.setEnableLsd(false)
    val s = SessionManager(); s.start(SessionParams(sp)); return s
}

fun main() {
    // ----- чистая логика -----
    ok("kind", TorrentArgs.kind("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x") == "magnet" && TorrentArgs.kind("https://h/a.torrent") == "url" && TorrentArgs.kind("ftp://x") == "" && TorrentArgs.kind("magnet:?dn=x") == "")
    ok("magnet hash hex", TorrentArgs.magnetHash("magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567") == "0123456789abcdef0123456789abcdef01234567")
    ok("magnet hash base32", TorrentArgs.magnetHash("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") == "0".repeat(40) && TorrentArgs.magnetHash("magnet:?xt=urn:btih:BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").startsWith("08"))
    ok("video / mime", TorrentArgs.isVideo("a.MKV") && !TorrentArgs.isVideo("a.srt") && TorrentArgs.mime("a.mp4") == "video/mp4" && TorrentArgs.mime("x.bin") == "application/octet-stream")
    val wt = TorrentArgs.withTrackers("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x")
    ok("trackers added to a bare magnet", wt.contains("tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce") && wt.split("tr=").size - 1 == TorrentArgs.TRACKERS.size)
    val own = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Fa%3A1&tr=udp%3A%2F%2Fb%3A1&tr=udp%3A%2F%2Fc%3A1"
    ok("magnet with 3+ trackers is left alone", TorrentArgs.withTrackers(own) == own)
    val dup = TorrentArgs.withTrackers("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce")
    ok("a given tracker is not repeated", dup.split("tracker.opentrackr.org").size - 1 == 1)
    ok("range: none → whole", TorrentArgs.range(null, 100)!!.toList() == listOf(0L, 99L))
    ok("range: a-b", TorrentArgs.range("bytes=10-19", 100)!!.toList() == listOf(10L, 19L))
    ok("range: a-", TorrentArgs.range("bytes=90-", 100)!!.toList() == listOf(90L, 99L))
    ok("range: -n", TorrentArgs.range("bytes=-10", 100)!!.toList() == listOf(90L, 99L) && TorrentArgs.range("bytes=-500", 100)!!.toList() == listOf(0L, 99L))
    ok("range: end beyond size is cut", TorrentArgs.range("bytes=50-5000", 100)!!.toList() == listOf(50L, 99L))
    ok("range: unsatisfiable", TorrentArgs.range("bytes=100-", 100) == null && TorrentArgs.range("bytes=20-10", 100) == null && TorrentArgs.range("bytes=-", 100) == null && TorrentArgs.range("bytes=0-1", 0) == null)
    ok("range: other unit ignored", TorrentArgs.range("items=1-2", 100)!!.toList() == listOf(0L, 99L))
    ok("pieces", TorrentArgs.pieces(0, 0, 1, 16384).toList() == listOf(0, 0) && TorrentArgs.pieces(10000, 7000, 20000, 16384).toList() == listOf(1, 2) && TorrentArgs.pieces(0, 16384, 16384, 16384).toList() == listOf(1, 1))

    // ----- настоящий libtorrent: раздающий и качающий на 127.0.0.1, стриминг по HTTP Range -----
    val tmp = Files.createTempDirectory("tt").toFile()
    val seedDir = File(tmp, "seed").also { it.mkdirs() }
    val data = ByteArray(2_600_000).also { Random(7).nextBytes(it) }
    File(seedDir, "clip.mp4").writeBytes(data)
    val gen = TorrentBuilder().path(File(seedDir, "clip.mp4")).pieceSize(65536).generate()
    val tbytes = gen.entry().bencode()
    val ti = TorrentInfo.bdecode(tbytes)
    ok("torrent built", ti.numFiles() == 1 && ti.files().fileSize(0) == data.size.toLong() && ti.pieceLength() == 65536, "pieces=${ti.numPieces()}")

    val seeder = session()
    seeder.download(ti, seedDir)
    var seeding = false
    for (i in 0 until 300) { val h = seeder.find(ti.infoHash()); if (h != null && h.isValid && h.status().isSeeding) { seeding = true; break }; Thread.sleep(100) }
    ok("seeder is seeding", seeding)
    val seedPort = seeder.swig().listen_port()

    val leech = session()
    val core = TorrentCore(leech, File(tmp, "leech"))
    val item = core.add(TorrentInfo.bdecode(tbytes), listOf(TcpEndpoint("127.0.0.1", seedPort)))
    ok("leecher has a handle", item.th != null)
    val http = TorrentHttp(core, "tok123"); http.start()
    val url = http.url(item.id, 0, "clip.mp4")
    ok("url shape", url.startsWith("http://127.0.0.1:${http.port}/t/tok123/${item.id}/0/clip.mp4"))

    val mid = get(url, "bytes=1000000-1000099")
    ok("range in the middle: 206 + exact bytes", mid.first == 206 && mid.second.contentEquals(data.copyOfRange(1_000_000, 1_000_100)), "code=${mid.first} n=${mid.second.size}")
    ok("Content-Range", mid.third["Content-Range"]?.firstOrNull() == "bytes 1000000-1000099/${data.size}", mid.third["Content-Range"].toString())
    val tail = get(url, "bytes=-100")
    ok("tail range (moov at the end): exact bytes", tail.first == 206 && tail.second.contentEquals(data.copyOfRange(data.size - 100, data.size)))
    val bad416 = get(url, "bytes=99999999-")
    ok("416 beyond the end", bad416.first == 416)
    ok("wrong token: 404", get(url.replace("tok123", "nope"), null).first == 404)
    val all = get(url, null)
    ok("whole file: 200 + identical", all.first == 200 && all.second.contentEquals(data), "n=${all.second.size}")
    val st = core.status(item)
    ok("status shows progress", st != null && st.totalDone() > 0, "done=${st?.totalDone()}")
    ok("content type", all.third["Content-Type"]?.firstOrNull() == "video/mp4")

    // magnet: добавляется в сессию сразу, метаданные — от раздающего (x.pe — адрес пира в ссылке), файл читается по HTTP той же раздачей, без повторного поиска пиров
    val leech2 = session()
    val core2 = TorrentCore(leech2, File(tmp, "leech2"))
    val mag = "magnet:?xt=urn:btih:${item.id}&dn=clip&x.pe=127.0.0.1:$seedPort"
    val item2 = core2.addMagnet(mag, 60)
    ok("magnet: metadata arrives from the peer", item2 != null && item2.ti.numFiles() == 1 && item2.ti.files().fileSize(0) == data.size.toLong())
    if (item2 != null) {
        ok("magnet: the file is not downloaded until selected", core2.status(item2)?.totalDone() == 0L, "done=${core2.status(item2)?.totalDone()}")
        val http2 = TorrentHttp(core2, "t2"); http2.start()
        val m2 = get(http2.url(item2.id, 0, "clip.mp4"), "bytes=2000000-2000049")
        ok("magnet: range read gives exact bytes", m2.first == 206 && m2.second.contentEquals(data.copyOfRange(2_000_000, 2_000_050)), "code=${m2.first}")
        ok("trackers line is readable", core2.trackers(item2.th!!).isNotEmpty(), core2.trackers(item2.th!!))
        ok("second addMagnet returns the same item", core2.addMagnet(mag, 5) === item2)
        http2.stop()
    }
    ok("a hash that nobody serves: null after the timeout, no exception", run { val z = core2.addMagnet("magnet:?xt=urn:btih:" + "ab".repeat(20), 3); z == null })
    leech2.stop()

    core.remove(item.id, true)
    ok("remove deletes files", !item.dir.exists())
    http.stop(); leech.stop(); seeder.stop()
    tmp.deleteRecursively()
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
