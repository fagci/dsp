package app.dsp.phone

import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Оболочка root: `su -c <скрипт>`. Скрипты — только свои, из этого файла; из страницы в них ничего не подставляется. */
object RootSh {
    /** (код выхода, вывод вместе с ошибками). Код −1 — su нет или не ответил за timeoutMs. */
    fun run(script: String, timeoutMs: Long = 15_000): Pair<Int, String> = try {
        val p = ProcessBuilder("su", "-c", script).redirectErrorStream(true).start()
        val out = StringBuilder()
        val t = Thread { try { p.inputStream.bufferedReader().forEachLine { if (out.length < 20_000) out.appendLine(it) } } catch (e: Exception) {} }.also { it.isDaemon = true; it.start() }
        if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) { p.destroy(); t.join(500); -1 to out.toString() + "(timeout)" }
        else { t.join(1000); p.exitValue() to out.toString() }
    } catch (e: Exception) { -1 to "su: ${e.message}" }
}

/**
 * Камеры с root. Камерный сервис знает больше камер, чем он показывает приложениям: дополнительные (ультраширик, макро, ToF, ИК)
 * на многих телефонах (Qualcomm и производные) видны только пакетам из системных свойств. Здесь — разведка (только чтение),
 * добавление нашего пакета в эти свойства с перезапуском камерного сервиса и откат. Работает не на каждом телефоне.
 */
object RootCam {
    /** Свойства, где перечисляются пакеты с доступом к скрытым камерам. */
    val PROPS = listOf("vendor.camera.aux.packagelist", "persist.vendor.camera.privapp.list")
    private val PKG = Regex("[A-Za-z0-9_.]{1,100}")
    private val VAL = Regex("[A-Za-z0-9_.,-]{0,400}")

    /** Только чтение: камеры по версии камерного сервиса, V4L2 / UVC-устройства, свойства доступа. */
    const val INFO = "echo '## camera service'; dumpsys media.camera 2>/dev/null | grep -E 'Camera ID|Device [0-9]+ is|Facing|[Hh]idden|Resource cost|Conflicting|Physical|Device version' | head -n 80; " +
        "echo '## v4l2'; for d in /sys/class/video4linux/video*; do [ -e \"\$d\" ] && echo \"\$(basename \$d): \$(cat \$d/name 2>/dev/null)\"; done; ls /dev/video* 2>/dev/null; " +
        "echo '## properties'; getprop | grep -iE 'camera.*(aux|privapp|packagelist)'; echo '## end'"

    /** Добавляет пакет в свойства и перезапускает камерный сервис; в выводе — прежние значения (строки OLD ключ=значение). null — пакет с лишними символами. */
    fun unhideScript(pkg: String): String? {
        if (!PKG.matches(pkg)) return null
        return "P='$pkg'; for K in ${PROPS.joinToString(" ")}; do C=\$(getprop \$K); echo \"OLD \$K=\$C\"; " +
            "case \",\$C,\" in *\",\$P,\"*) ;; *) setprop \$K \"\${C:+\$C,}\$P\" ;; esac; done; " +
            "pkill -f camera.provider 2>/dev/null; killall cameraserver 2>/dev/null; echo restarted"
    }

    /** Прежние значения свойств из вывода unhideScript. */
    fun parseOld(out: String): Map<String, String> {
        val m = LinkedHashMap<String, String>()
        for (l in out.lines()) {
            val r = Regex("OLD (\\S+)=(.*)").matchEntire(l.trim()) ?: continue
            if (r.groupValues[1] in PROPS) m[r.groupValues[1]] = r.groupValues[2].trim()
        }
        return m
    }

    /** Возвращает свойства к прежним значениям. null — в значениях лишнее. */
    fun restoreScript(old: Map<String, String>): String? {
        if (old.isEmpty() || old.any { it.key !in PROPS || !VAL.matches(it.value) }) return null
        return old.entries.joinToString("; ") { "setprop ${it.key} '${it.value}'" } + "; pkill -f camera.provider 2>/dev/null; killall cameraserver 2>/dev/null; echo restarted"
    }

    fun toJson(m: Map<String, String>) = JSONObject(m as Map<*, *>).toString()
    fun fromJson(s: String): Map<String, String> = try { val j = JSONObject(s); j.keys().asSequence().associateWith { j.getString(it) } } catch (e: Exception) { emptyMap() }
    fun clip(s: String, n: Int) = if (s.length <= n) s else s.take(n) + "\n… (+${s.length - n} chars)"
}
