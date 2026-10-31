package app.dsp.phone

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.provider.MediaStore
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.io.RandomAccessFile
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Чистая логика записи на диск (без Android — проверяется на JVM). */
object RecArgs {
    /** Не пишем на диск: личные сообщения и сырой звук / пакеты (огромные и чувствительные). */
    val DENY = setOf("sms", "mic", "pkt")
    private val NAME = Regex("[a-z0-9_]{1,24}")
    private val FILE = Regex("[A-Za-z0-9._-]{1,100}\\.(jsonl|wav)")

    fun subs(a: List<String>): List<String> = a.map { it.trim().lowercase() }.filter { NAME.matches(it) && it !in DENY }.distinct().take(30)
    fun subs(s: String?): List<String> = subs((s ?: "").split(',', ';', ' '))

    /** Запись + время приёма: {"_t":мс,…} (у многих записей своего поля t нет). */
    fun stamp(json: String, t: Long): String = when {
        json.length > 2 && json[0] == '{' -> "{\"_t\":$t," + json.substring(1)
        json == "{}" -> "{\"_t\":$t}"
        else -> json
    }

    fun safeName(s: String?): String = (s ?: "").replace(Regex("[^A-Za-z0-9_-]"), "_").take(40).ifEmpty { "rec" }

    fun fileName(name: String, ms: Long, part: Int, zone: ZoneId): String =
        safeName(name) + "-" + DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").format(Instant.ofEpochMilli(ms).atZone(zone)) + (if (part > 0) "-$part" else "") + ".jsonl"

    /** Имя файла из команды: только наши .jsonl и .wav (записи звонков), без путей. */
    fun validFile(s: String?): String? = s?.trim()?.takeIf { FILE.matches(it) && !it.contains("..") }

    /** Какие старейшие файлы удалить, чтобы всё влезло в cap байт; keep (текущий) не трогаем. files — (имя, размер) от старых к новым. */
    fun overflow(files: List<Pair<String, Long>>, cap: Long, keep: String?): List<String> {
        var total = files.sumOf { it.second }
        val out = ArrayList<String>()
        for ((n, sz) in files) { if (total <= cap) break; if (n == keep) continue; out.add(n); total -= sz }
        return out
    }
}

/**
 * Запись записей моста на диск без открытой страницы: JSON Lines в папке приложения (getExternalFilesDir/rec), по файлу на запуск, новый файл
 * при maxMb, самые старые стираются сверх общего лимита. Включённая запись возобновляется при запуске службы (в том числе после перезагрузки).
 * Команды (только страница приложения): rec.start {name, subs, hz, wifiEvery, cellEvery, maxMb} / rec.stop / rec.status / rec.list /
 * rec.read {file, offset, limit} — записи из файла обратно на страницу / rec.delete {file} / rec.export {file} — копия в Downloads.
 */
class RecHub(private val ctx: Context, private val cfg: Config, private val server: BridgeServer) {
    private val thread = HandlerThread("dsp-rec").also { it.start() }
    private val handler = Handler(thread.looper)
    @Volatile private var sink: BridgeServer.Sink? = null
    private var out: BufferedWriter? = null
    private var cur: File? = null
    private var bytes = 0L
    private var part = 0
    @Volatile private var lines = 0L
    @Volatile private var failed: String? = null
    private val zone get() = ZoneId.systemDefault()

    val dir: File get() = (ctx.getExternalFilesDir(null)?.let { File(it, "rec") } ?: File(ctx.filesDir, "rec")).also { it.mkdirs() }
    fun active() = sink != null

    private val flushRun = object : Runnable {
        override fun run() { synchronized(this@RecHub) { try { out?.flush() } catch (e: Exception) { } }; if (sink != null) handler.postDelayed(this, 2000) }
    }

    /** Возобновить запись из настроек (запуск службы). */
    fun resume() { if (cfg.recOn && sink == null) start(cfg.recName, RecArgs.subs(cfg.recSubs), cfg.recHz, cfg.recWifi, cfg.recCell, cfg.recMaxMb, persist = false) }

    /** null — запись пошла; иначе причина. */
    @Synchronized
    fun start(name: String, subs: List<String>, hz: Int, wifiEvery: Int, cellEvery: Int, maxMb: Int, persist: Boolean = true): String? {
        stop(persist = false)
        if (subs.isEmpty()) return "subs: at least one source (gps, wifi, ble, bt, cell, accel, sys…); sms, mic and pkt are not recorded"
        cfg.recMaxMb = maxMb.takeIf { it > 0 } ?: cfg.recMaxMb
        if (persist) { cfg.recOn = true; cfg.recName = RecArgs.safeName(name); cfg.recSubs = subs.joinToString(","); cfg.recHz = hz; cfg.recWifi = wifiEvery; cfg.recCell = cellEvery }
        failed = null; part = 0; lines = 0
        try { openFile() } catch (e: Exception) { failed = e.message; return "cannot write to " + dir + ": " + e.message }
        val s = BridgeServer.Sink(subs.toSet(), hz.coerceIn(0, 1000), wifiEvery.coerceIn(0, 600), cellEvery.coerceIn(0, 120), on = { l -> write(l) })
        sink = s; server.addSink(s)
        handler.postDelayed(flushRun, 2000)
        return null
    }

    @Synchronized
    fun stop(persist: Boolean = true) {
        if (persist) cfg.recOn = false
        sink?.let { server.removeSink(it) }; sink = null
        handler.removeCallbacks(flushRun)
        try { out?.flush(); out?.close() } catch (e: Exception) { }
        out = null
    }

    private fun openFile() {
        val f = File(dir, RecArgs.fileName(cfg.recName, System.currentTimeMillis(), part, zone))
        out = BufferedWriter(OutputStreamWriter(FileOutputStream(f, true), Charsets.UTF_8), 32 * 1024); cur = f; bytes = f.length()
        val all = (dir.listFiles { x -> x.isFile && RecArgs.validFile(x.name) != null } ?: emptyArray()).sortedBy { it.lastModified() }
        for (n in RecArgs.overflow(all.map { it.name to it.length() }, cfg.recTotalMb * 1_048_576L, f.name)) File(dir, n).delete()
    }

    @Synchronized
    private fun write(l: List<String>) {
        val w = out ?: return
        val now = System.currentTimeMillis()
        try {
            for (j in l) { val s = RecArgs.stamp(j, now); w.write(s); w.write("\n"); bytes += s.length + 1; lines++ }
            if (bytes > cfg.recMaxMb * 1_048_576L) { w.flush(); w.close(); part++; openFile() }
        } catch (e: Exception) { failed = e.message; stop(persist = false); server.note("error", "recording stopped: ${e.message}") }
    }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        try {
            when (cmd) {
                "rec.start" -> {
                    val subs = j.optJSONArray("subs")?.let { a -> RecArgs.subs((0 until a.length()).map { a.optString(it) }) } ?: RecArgs.subs(j.optString("subs"))
                    val e = start(j.optString("name", "rec"), subs, j.optInt("hz"), j.optInt("wifiEvery"), j.optInt("cellEvery"), j.optInt("maxMb"))
                    if (e != null) Reply.done(c, id, cmd, e, "args") else Reply.done(c, id, cmd, null, extra = arrayOf("file" to Json.str(cur?.name), "subs" to Json.str(subs.joinToString(","))))
                }
                "rec.stop" -> { val n = lines; stop(); Reply.done(c, id, cmd, null, extra = arrayOf("lines" to n.toString())) }
                "rec.status" -> {
                    c.send(Json.rows(listOf(Json.obj("src" to "\"recording\"", "kind" to Json.str("status"), "on" to active().toString(), "file" to Json.str(cur?.name ?: ""), "bytes" to bytes.toString(), "lines" to lines.toString(),
                        "subs" to Json.str(cfg.recSubs), "err" to failed?.let { Json.str(it) }, "dir" to Json.str(dir.absolutePath)))))
                    Reply.done(c, id, cmd, null)
                }
                "rec.list" -> {
                    val fs = (dir.listFiles { x -> x.isFile && RecArgs.validFile(x.name) != null } ?: emptyArray()).sortedByDescending { it.lastModified() }
                    val rows = fs.take(200).map { Json.obj("src" to "\"recording\"", "kind" to Json.str("file"), "file" to Json.str(it.name), "bytes" to it.length().toString(), "t" to it.lastModified().toString(), "live" to (it == cur && active()).toString()) }
                    if (rows.isNotEmpty()) c.send(Json.rows(rows))
                    Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString()))
                }
                "rec.read" -> {
                    val f = RecArgs.validFile(j.optString("file"))?.let { File(dir, it) }?.takeIf { it.isFile } ?: return Reply.done(c, id, cmd, "file: a name from rec.list", "args")
                    if (!f.name.endsWith(".jsonl")) return Reply.done(c, id, cmd, "only .jsonl records can be read back (a .wav is a call recording — export it)", "args")
                    synchronized(this) { try { out?.flush() } catch (e: Exception) { } }
                    val limit = Cmd.limit(j.optInt("limit"), 500, 2000); var pos = j.optLong("offset").coerceAtLeast(0)
                    val rows = ArrayList<String>()
                    RandomAccessFile(f, "r").use { r ->
                        r.seek(pos)
                        while (rows.size < limit && pos < r.length()) {
                            val b = r.readLine() ?: break
                            pos = r.filePointer
                            val line = String(b.toByteArray(Charsets.ISO_8859_1), Charsets.UTF_8)
                            if (line.isNotBlank()) rows.add(line)
                        }
                    }
                    if (rows.isNotEmpty()) c.send(Json.rows(rows))
                    Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString(), "next" to pos.toString(), "eof" to (pos >= f.length()).toString()))
                }
                "rec.delete" -> {
                    val f = RecArgs.validFile(j.optString("file"))?.let { File(dir, it) }?.takeIf { it.isFile } ?: return Reply.done(c, id, cmd, "file: a name from rec.list", "args")
                    if (f == cur && active()) return Reply.done(c, id, cmd, "the file is being written — rec.stop first", "state")
                    if (f.delete()) Reply.done(c, id, cmd, null) else Reply.done(c, id, cmd, "cannot delete", "error")
                }
                "rec.export" -> {
                    val f = RecArgs.validFile(j.optString("file"))?.let { File(dir, it) }?.takeIf { it.isFile } ?: return Reply.done(c, id, cmd, "file: a name from rec.list", "args")
                    synchronized(this) { try { out?.flush() } catch (e: Exception) { } }
                    val where = export(f)
                    Reply.done(c, id, cmd, null, extra = arrayOf("to" to Json.str(where)))
                }
                else -> Reply.done(c, id, cmd, "unknown recording command", "args")
            }
        } catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: "recording error", "error") }
    }

    /** Копия в общую папку «Загрузки»: Android 10+ через MediaStore, раньше — в папку приложения. */
    private fun export(f: File): String {
        if (Build.VERSION.SDK_INT >= 29) {
            val v = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, f.name); put(MediaStore.Downloads.MIME_TYPE, if (f.name.endsWith(".wav")) "audio/wav" else "application/x-ndjson")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DSP")
            }
            val u = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: throw java.io.IOException("no Downloads")
            ctx.contentResolver.openOutputStream(u)?.use { o -> f.inputStream().use { it.copyTo(o) } } ?: throw java.io.IOException("cannot write")
            return "Downloads/DSP/" + f.name
        }
        val d = File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.filesDir, "export").also { it.mkdirs() }
        f.copyTo(File(d, f.name), overwrite = true)
        return d.absolutePath + "/" + f.name
    }

    fun close() { stop(persist = false); thread.quitSafely() }
}
