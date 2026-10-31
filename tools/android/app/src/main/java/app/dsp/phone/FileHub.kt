package app.dsp.phone

import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Base64
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * Файлы и галерея (только страница приложения — личные данные).
 * Галерея (MediaStore): media.list {kind, q, from, to, limit, exif, thumbs, thumbSize} / media.thumb {id, kind, size} / media.read {id, kind, offset, limit} /
 *   media.save {name, mime, kind, folder, data (base64) | text}. Читает системная галерея — отдельные разрешения Android 13+ (READ_MEDIA_*), раньше READ_EXTERNAL_STORAGE;
 *   положение снимка (EXIF) — ACCESS_MEDIA_LOCATION. Сохранение в Pictures / Movies / Music / Download (подпапка DSP) — Android 10+, без разрешений.
 * Папки (SAF): fs.pick — системный выбор папки, доступ запоминается; fs.grants / fs.list / fs.read / fs.write / fs.mkdir / fs.delete / fs.revoke по grant и пути внутри папки.
 */
class FileHub(private val ctx: Context, private val needs: Needs) {
    private val sp = ctx.getSharedPreferences("fs-grants", Context.MODE_PRIVATE)

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        try {
            when {
                cmd.startsWith("media.") -> media(c, j, cmd, id)
                cmd.startsWith("fs.") -> fs(c, j, cmd, id)
                else -> Reply.done(c, id, cmd, "unknown file command", "args")
            }
        } catch (e: SecurityException) { Reply.done(c, id, cmd, "no permission: " + e.message, "permission") }
        catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: "file error", "error") }
    }

    // ---------------- галерея ----------------

    private fun tree(kind: String): Uri = when (kind) {
        "video" -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        "audio" -> MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        "files" -> MediaStore.Files.getContentUri("external")
        else -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    }

    private fun media(c: BridgeServer.Client, j: JSONObject, cmd: String, id: Any?) {
        val kind = FsArgs.kind(j.optString("kind"))
        when (cmd) {
            "media.list" -> {
                val exif = j.optBoolean("exif", false); val thumbs = j.optBoolean("thumbs", false)
                if (!needs.need(c, id, cmd, FsArgs.readPerms(kind, Build.VERSION.SDK_INT, exif))) return
                val lim = Cmd.limit(j.optInt("limit"), 50, if (exif || thumbs) 100 else 500)
                val q = j.optString("q").trim()
                val from = j.optLong("from"); val to = j.optLong("to")
                val sel = ArrayList<String>(); val args = ArrayList<String>()
                if (q.isNotEmpty()) { sel.add("${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?"); args.add("%$q%") }
                if (from > 0) { sel.add("${MediaStore.MediaColumns.DATE_ADDED} >= ?"); args.add((from / 1000).toString()) }
                if (to > 0) { sel.add("${MediaStore.MediaColumns.DATE_ADDED} <= ?"); args.add((to / 1000).toString()) }
                val cols = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE,
                    MediaStore.MediaColumns.DATE_ADDED, MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT)
                val out = ArrayList<String>()
                ctx.contentResolver.query(tree(kind), cols, if (sel.isEmpty()) null else sel.joinToString(" AND "), if (args.isEmpty()) null else args.toTypedArray(),
                    MediaStore.MediaColumns.DATE_ADDED + " DESC")?.use { cur ->
                    while (cur.moveToNext() && out.size < lim) {
                        val mid = cur.getLong(0); val mime = cur.getString(2) ?: ""
                        val u = ContentUris.withAppendedId(tree(kind), mid)
                        val kv = ArrayList<Pair<String, String?>>()
                        kv.add("src" to "\"media\""); kv.add("kind" to Json.str(kind)); kv.add("id" to mid.toString()); kv.add("name" to Json.str(cur.getString(1)))
                        kv.add("mime" to Json.str(mime)); kv.add("size" to cur.getLong(3).toString()); kv.add("t" to (cur.getLong(4) * 1000).toString())
                        kv.add("w" to cur.getInt(5).toString()); kv.add("h" to cur.getInt(6).toString()); kv.add("label" to Json.str(cur.getString(1)))
                        if (exif && mime.startsWith("image/")) exifPos(u)?.let { kv.add("lat" to Json.num(it[0], 1e6)); kv.add("lon" to Json.num(it[1], 1e6)) }
                        if (thumbs && Build.VERSION.SDK_INT >= 29) thumb(u, j.optInt("thumbSize", 128))?.let { kv.add("thumb" to Json.str(FsArgs.dataUri("image/jpeg", it))) }
                        out.add(Json.obj(*kv.toTypedArray()))
                    }
                }
                for (chunk in out.chunked(20)) c.send(Json.rows(chunk))
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to out.size.toString()))
            }
            "media.thumb" -> {
                if (!needs.need(c, id, cmd, FsArgs.readPerms(kind, Build.VERSION.SDK_INT, false))) return
                if (Build.VERSION.SDK_INT < 29) return Reply.done(c, id, cmd, "thumbnails need Android 10+", "state")
                val mid = j.optLong("id_media", j.optLong("media", -1)); if (mid < 0) return Reply.done(c, id, cmd, "media: the id from media.list", "args")
                val b64 = thumb(ContentUris.withAppendedId(tree(kind), mid), j.optInt("size", 256)) ?: return Reply.done(c, id, cmd, "no thumbnail", "state")
                c.send(Json.rows(listOf(Json.obj("src" to "\"media\"", "kind" to Json.str("thumb"), "id" to mid.toString(), "mime" to Json.str("image/jpeg"), "data" to Json.str(b64)))))
                Reply.done(c, id, cmd, null)
            }
            "media.read" -> {
                if (!needs.need(c, id, cmd, FsArgs.readPerms(kind, Build.VERSION.SDK_INT, false))) return
                val mid = j.optLong("media", -1); if (mid < 0) return Reply.done(c, id, cmd, "media: the id from media.list", "args")
                readChunk(c, id, cmd, ContentUris.withAppendedId(tree(kind), mid), j, "media", mid.toString())
            }
            "media.save" -> {
                if (Build.VERSION.SDK_INT < 29) return Reply.done(c, id, cmd, "saving to the gallery needs Android 10+", "state")
                val bytes = payload(j) ?: return Reply.done(c, id, cmd, "data (base64) or text, up to ${FsArgs.MAX_SAVE / 1024} kB", "args")
                val name = FsArgs.safeName(j.optString("name"))
                val mime = j.optString("mime").ifEmpty { "application/octet-stream" }
                val v = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name); put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, FsArgs.relPath(kind, j.optString("folder")))
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val u = ctx.contentResolver.insert(if (kind == "files") MediaStore.Downloads.EXTERNAL_CONTENT_URI else tree(kind), v) ?: return Reply.done(c, id, cmd, "the gallery refused the file", "state")
                ctx.contentResolver.openOutputStream(u)?.use { it.write(bytes) } ?: return Reply.done(c, id, cmd, "cannot write", "error")
                ctx.contentResolver.update(u, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                Reply.done(c, id, cmd, null, extra = arrayOf("uri" to Json.str(u.toString()), "bytes" to bytes.size.toString(), "path" to Json.str(FsArgs.relPath(kind, j.optString("folder")) + "/" + name)))
            }
            else -> Reply.done(c, id, cmd, "unknown media command", "args")
        }
    }

    private fun exifPos(u: Uri): DoubleArray? = try {
        val src = if (Build.VERSION.SDK_INT >= 29) MediaStore.setRequireOriginal(u) else u
        ctx.contentResolver.openInputStream(src)?.use { ins -> val ll = FloatArray(2); if (android.media.ExifInterface(ins).getLatLong(ll)) doubleArrayOf(ll[0].toDouble(), ll[1].toDouble()) else null }
    } catch (e: Exception) { null }

    @Suppress("NewApi")
    private fun thumb(u: Uri, size: Int): String? = try {
        val s = size.coerceIn(48, 512)
        val bmp = ctx.contentResolver.loadThumbnail(u, Size(s, s), null)
        val o = ByteArrayOutputStream(); bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, o)
        Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) { null }

    private fun payload(j: JSONObject): ByteArray? {
        val b = when {
            j.has("data") -> try { Base64.decode(j.optString("data"), Base64.DEFAULT) } catch (e: Exception) { return null }
            j.has("text") -> j.optString("text").toByteArray(Charsets.UTF_8)
            else -> return null
        }
        return b.takeIf { it.size <= FsArgs.MAX_SAVE }
    }

    private fun readChunk(c: BridgeServer.Client, id: Any?, cmd: String, u: Uri, j: JSONObject, src: String, ref: String) {
        val size = ctx.contentResolver.openAssetFileDescriptor(u, "r")?.use { it.length } ?: -1L
        val (off, n) = FsArgs.window(j.optLong("offset"), j.optInt("limit"), size)
        val buf = ByteArray(n); var got = 0
        ctx.contentResolver.openInputStream(u)?.use { ins -> skipFully(ins, off); while (got < n) { val k = ins.read(buf, got, n - got); if (k <= 0) break; got += k } } ?: return Reply.done(c, id, cmd, "cannot open", "error")
        val eof = size >= 0 && off + got >= size || got < n
        val text = j.optBoolean("text", false)
        val data = if (text) Json.str(String(buf, 0, got, Charsets.UTF_8)) else Json.str(Base64.encodeToString(buf, 0, got, Base64.NO_WRAP))
        c.send(Json.rows(listOf(Json.obj("src" to "\"$src\"", "kind" to Json.str("data"), "id" to Json.str(ref), "offset" to off.toString(), "n" to got.toString(), "eof" to eof.toString(), (if (text) "text" else "data") to data))))
        Reply.done(c, id, cmd, null, extra = arrayOf("next" to (off + got).toString(), "eof" to eof.toString(), "size" to size.toString()))
    }

    private fun skipFully(ins: InputStream, n: Long) { var left = n; while (left > 0) { val k = ins.skip(left); if (k <= 0) { if (ins.read() < 0) return; left-- } else left -= k } }

    // ---------------- папки (SAF) ----------------

    private fun grants(): JSONObject = try { JSONObject(sp.getString("g", "{}") ?: "{}") } catch (e: Exception) { JSONObject() }
    private fun saveGrants(g: JSONObject) = sp.edit().putString("g", g.toString()).apply()

    private class Doc(val uri: Uri, val id: String, val name: String, val mime: String, val size: Long, val t: Long) { val dir get() = mime == DocumentsContract.Document.MIME_TYPE_DIR }

    private fun treeOf(grant: String): Uri? = grants().optString(grant).takeIf { it.isNotEmpty() }?.let { Uri.parse(it) }

    private fun children(tree: Uri, parentId: String): List<Doc> {
        val out = ArrayList<Doc>()
        val u = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        ctx.contentResolver.query(u, cols, null, null, null)?.use { cur ->
            while (cur.moveToNext()) { val did = cur.getString(0); out.add(Doc(DocumentsContract.buildDocumentUriUsingTree(tree, did), did, cur.getString(1) ?: "", cur.getString(2) ?: "", if (cur.isNull(3)) -1 else cur.getLong(3), cur.getLong(4))) }
        }
        return out
    }

    /** Документ по пути внутри папки; create — недостающие папки по пути создаются (кроме последнего звена: его создаёт вызывающий). */
    private fun walk(tree: Uri, segs: List<String>, createDirs: Boolean): Pair<String, Doc?> {
        var pid = DocumentsContract.getTreeDocumentId(tree); var cur: Doc? = null
        for ((i, s) in segs.withIndex()) {
            var d = children(tree, pid).firstOrNull { it.name == s }
            if (d == null && createDirs && i < segs.size - 1) {
                val nu = DocumentsContract.createDocument(ctx.contentResolver, DocumentsContract.buildDocumentUriUsingTree(tree, pid), DocumentsContract.Document.MIME_TYPE_DIR, s) ?: return pid to null
                d = Doc(nu, DocumentsContract.getDocumentId(nu), s, DocumentsContract.Document.MIME_TYPE_DIR, -1, 0)
            }
            if (d == null) return pid to null
            cur = d; pid = d.id
        }
        return pid to cur
    }

    private fun fs(c: BridgeServer.Client, j: JSONObject, cmd: String, id: Any?) {
        when (cmd) {
            "fs.pick" -> {
                val rid = FilePick.register(c, id, this)
                val i = Intent(ctx, FilePickActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(FilePickActivity.EXTRA, rid)
                val pi = PendingIntent.getActivity(ctx, 5, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(PICK_ID,
                    Notification.Builder(ctx, BridgeService.CH_PERM).setSmallIcon(android.R.drawable.ic_menu_compass).setContentTitle("DSP: choose a folder").setContentText("Tap to pick the folder the patch may use")
                        .setContentIntent(pi).setAutoCancel(true).build())
                try { ctx.startActivity(i) } catch (e: Exception) { /* из фона нельзя — останется уведомление */ }
                // ответ придёт, когда папку выберут (record {src:'fs', kind:'grant'} и Reply этой команды)
            }
            "fs.grants" -> {
                val g = grants(); val rows = g.keys().asSequence().map { k -> Json.obj("src" to "\"fs\"", "kind" to Json.str("grant"), "grant" to Json.str(k), "name" to Json.str(g.optString(k + ".name")), "uri" to Json.str(g.optString(k))) }.toList()
                if (rows.isNotEmpty()) c.send(Json.rows(rows))
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString()))
            }
            "fs.revoke" -> {
                val k = j.optString("grant"); val g = grants(); val u = g.optString(k)
                if (u.isEmpty()) return Reply.done(c, id, cmd, "no such grant", "args")
                try { ctx.contentResolver.releasePersistableUriPermission(Uri.parse(u), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (e: Exception) { }
                g.remove(k); g.remove("$k.name"); saveGrants(g); Reply.done(c, id, cmd, null)
            }
            else -> {
                val tree = treeOf(j.optString("grant")) ?: return Reply.done(c, id, cmd, "grant: an id from fs.pick / fs.grants", "args")
                val segs = FsArgs.safeSegments(j.optString("path"))
                when (cmd) {
                    "fs.list" -> {
                        val (pid, d) = if (segs.isEmpty()) DocumentsContract.getTreeDocumentId(tree) to null else walk(tree, segs, false)
                        if (segs.isNotEmpty() && (d == null || !d.dir)) return Reply.done(c, id, cmd, "no such folder", "state")
                        val rows = children(tree, pid).take(Cmd.limit(j.optInt("limit"), 200, 1000)).map { Json.obj("src" to "\"fs\"", "kind" to Json.str(if (it.dir) "dir" else "file"), "name" to Json.str(it.name), "mime" to Json.str(it.mime), "size" to it.size.toString(), "t" to it.t.toString(), "path" to Json.str((segs + it.name).joinToString("/"))) }
                        for (chunk in rows.chunked(50)) c.send(Json.rows(chunk))
                        Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString()))
                    }
                    "fs.read" -> {
                        val d = walk(tree, segs, false).second?.takeIf { !it.dir } ?: return Reply.done(c, id, cmd, "no such file", "state")
                        readChunk(c, id, cmd, d.uri, j, "fs", segs.joinToString("/"))
                    }
                    "fs.write" -> {
                        if (segs.isEmpty()) return Reply.done(c, id, cmd, "path: the file name", "args")
                        val bytes = payload(j) ?: return Reply.done(c, id, cmd, "data (base64) or text, up to ${FsArgs.MAX_SAVE / 1024} kB", "args")
                        var (pid, d) = walk(tree, segs, true)
                        if (d == null) {
                            val parent = if (segs.size == 1) DocumentsContract.getTreeDocumentId(tree) else walk(tree, segs.dropLast(1), true).second?.id ?: return Reply.done(c, id, cmd, "cannot make the folders", "state")
                            val nu = DocumentsContract.createDocument(ctx.contentResolver, DocumentsContract.buildDocumentUriUsingTree(tree, parent), j.optString("mime").ifEmpty { "application/octet-stream" }, segs.last()) ?: return Reply.done(c, id, cmd, "cannot create the file", "state")
                            d = Doc(nu, DocumentsContract.getDocumentId(nu), segs.last(), "", -1, 0)
                        }
                        ctx.contentResolver.openOutputStream(d.uri, if (j.optBoolean("append", false)) "wa" else "wt")?.use { it.write(bytes) } ?: return Reply.done(c, id, cmd, "cannot write", "error")
                        Reply.done(c, id, cmd, null, extra = arrayOf("bytes" to bytes.size.toString()))
                    }
                    "fs.mkdir" -> {
                        if (segs.isEmpty()) return Reply.done(c, id, cmd, "path: the folder name", "args")
                        val parent = if (segs.size == 1) DocumentsContract.getTreeDocumentId(tree) else walk(tree, segs.dropLast(1), true).second?.id ?: return Reply.done(c, id, cmd, "cannot make the folders", "state")
                        if (children(tree, parent).any { it.name == segs.last() }) return Reply.done(c, id, cmd, null)
                        DocumentsContract.createDocument(ctx.contentResolver, DocumentsContract.buildDocumentUriUsingTree(tree, parent), DocumentsContract.Document.MIME_TYPE_DIR, segs.last()) ?: return Reply.done(c, id, cmd, "cannot create the folder", "state")
                        Reply.done(c, id, cmd, null)
                    }
                    "fs.delete" -> {
                        val d = walk(tree, segs, false).second ?: return Reply.done(c, id, cmd, "no such file", "state")
                        if (DocumentsContract.deleteDocument(ctx.contentResolver, d.uri)) Reply.done(c, id, cmd, null) else Reply.done(c, id, cmd, "cannot delete", "error")
                    }
                    else -> Reply.done(c, id, cmd, "unknown folder command", "args")
                }
            }
        }
    }

    /** Папку выбрали (FilePickActivity): запомнить доступ и ответить на fs.pick. */
    fun granted(c: BridgeServer.Client, id: Any?, tree: Uri?) {
        if (tree == null) return Reply.done(c, id, "fs.pick", "no folder was chosen", "cancelled")
        try { ctx.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (e: Exception) { }
        val g = grants(); val key = "g" + Integer.toHexString(tree.toString().hashCode())
        val name = try { children(tree, DocumentsContract.getTreeDocumentId(tree)); DocumentsContract.getTreeDocumentId(tree).substringAfter(':').ifEmpty { "root" } } catch (e: Exception) { "folder" }
        g.put(key, tree.toString()); g.put("$key.name", name); saveGrants(g)
        c.send(Json.rows(listOf(Json.obj("src" to "\"fs\"", "kind" to Json.str("grant"), "grant" to Json.str(key), "name" to Json.str(name), "uri" to Json.str(tree.toString())))))
        Reply.done(c, id, "fs.pick", null, extra = arrayOf("grant" to Json.str(key), "name" to Json.str(name)))
    }

    companion object { const val PICK_ID = 7314 }
}

/** Ожидающие fs.pick: id запроса → (клиент, id команды, хаб). */
object FilePick {
    private class P(val c: BridgeServer.Client, val id: Any?, val hub: FileHub)
    private val pending = ConcurrentHashMap<Int, P>()
    private var seq = 0
    @Synchronized fun register(c: BridgeServer.Client, id: Any?, hub: FileHub): Int { val r = ++seq; pending[r] = P(c, id, hub); return r }
    fun done(rid: Int, tree: Uri?) { pending.remove(rid)?.let { if (!it.c.dead) it.hub.granted(it.c, it.id, tree) } }
}

/** Прозрачное окно системного выбора папки (ACTION_OPEN_DOCUMENT_TREE) для fs.pick. */
class FilePickActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(FileHub.PICK_ID)
        try {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION), 1)
        } catch (e: Exception) { FilePick.done(intent.getIntExtra(EXTRA, 0), null); finish() }
    }

    override fun onActivityResult(code: Int, res: Int, data: Intent?) {
        FilePick.done(intent.getIntExtra(EXTRA, 0), if (res == RESULT_OK) data?.data else null)
        finish()
    }

    companion object { const val EXTRA = "rid" }
}
