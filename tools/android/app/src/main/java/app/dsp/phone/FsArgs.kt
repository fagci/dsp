package app.dsp.phone

/** Чистая логика файлов и галереи (без Android — проверяется на JVM). */
object FsArgs {
    /** Один кусок данных за вызов — не больше (base64 в записи WebSocket). */
    const val MAX_CHUNK = 262_144
    /** Сохранение за один вызов — не больше. */
    const val MAX_SAVE = 4_194_304

    /** Что искать в MediaStore. */
    fun kind(s: String?): String = when ((s ?: "").trim().lowercase()) { "video", "videos" -> "video"; "audio", "music" -> "audio"; "files", "file", "downloads" -> "files"; else -> "images" }

    /** Куда сохранять (RELATIVE_PATH, Android 10+): всегда внутри стандартной папки и подпапки DSP; пользовательская подпапка — только из безопасных символов. */
    fun relPath(kind: String, folder: String?): String {
        val base = when (kind) { "video" -> "Movies"; "audio" -> "Music"; "files" -> "Download"; else -> "Pictures" }
        val sub = safeSegments(folder).ifEmpty { listOf("DSP") }
        return base + "/" + sub.joinToString("/")
    }

    /** «a/b», «\a\..\b» → ["a","b"]: пустые и «.»/«..» отбрасываются, символы — буквы, цифры, пробел, _ . -; не больше 4 уровней. */
    fun safeSegments(path: String?): List<String> = (path ?: "").split('/', '\\').map { it.trim() }
        .filter { it.isNotEmpty() && it != "." && it != ".." }.map { it.replace(Regex("[^\\p{L}\\p{N} _.-]"), "_").take(60) }.take(4)

    fun safeName(s: String?): String = (s ?: "").replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().take(120).ifEmpty { "file" }

    /** Границы чтения: (с какого байта, сколько) — не больше MAX_CHUNK и не за концом файла (size < 0 — размер неизвестен). */
    fun window(offset: Long, limit: Int, size: Long): Pair<Long, Int> {
        val o = offset.coerceAtLeast(0)
        var n = (if (limit <= 0) MAX_CHUNK else minOf(limit, MAX_CHUNK))
        if (size >= 0) n = minOf(n.toLong(), (size - o).coerceAtLeast(0)).toInt()
        return o to n
    }

    /** Метка времени медиафайла: дата съёмки, иначе дата добавления (секунды → мс). */
    fun when_(taken: Long, addedSec: Long): Long = if (taken > 0) taken else addedSec * 1000

    /** Разрешения чтения медиа по Android: 13+ — отдельные, раньше — общее; +доступ к положению в EXIF (10+). */
    fun readPerms(kind: String, sdk: Int, exif: Boolean): List<String> {
        val p = ArrayList<String>()
        if (sdk >= 33) p.add(when (kind) { "video" -> "android.permission.READ_MEDIA_VIDEO"; "audio" -> "android.permission.READ_MEDIA_AUDIO"; "files" -> "android.permission.READ_MEDIA_IMAGES"; else -> "android.permission.READ_MEDIA_IMAGES" })
        else p.add("android.permission.READ_EXTERNAL_STORAGE")
        if (exif && sdk >= 29) p.add("android.permission.ACCESS_MEDIA_LOCATION")
        return p
    }

    /** Миниатюра как data-URI для Table / карточек. */
    fun dataUri(mime: String, b64: String) = "data:$mime;base64,$b64"
}
