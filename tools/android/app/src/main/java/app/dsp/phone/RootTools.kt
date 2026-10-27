package app.dsp.phone

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

    // § в шаблонах — знак доллара оболочки (чтобы не экранировать его в строках Kotlin)
    private fun tpl(t: String, pkg: String) = t.replace("@PKG@", pkg).replace("@PROPS@", PROPS.joinToString(" ")).replace('§', '$')

    // Перезапуск камерного сервиса. pkill -f сверяет шаблон с командной строкой процессов, в том числе с самой этой оболочкой
    // (в её команде есть слово camera.provider), поэтому шаблон — с классом символов: camera[.]provider в тексте скрипта не совпадает с собой.
    private const val RESTART = "pkill -f 'camera[.]provider' 2>/dev/null; killall camerahalserver cameraserver 2>/dev/null; echo restarted"

    /** Метка в выводе: свойства выставлены (дальше оболочку может убить перезапуск сервиса — код выхода тогда не показатель). */
    const val DONE = "propsset"
    fun done(out: String) = DONE in out

    /** Добавляет пакет в оба свойства (если его там нет) и перезапускает камерный сервис. null — пакет с лишними символами. */
    fun unhideScript(pkg: String): String? {
        if (!PKG.matches(pkg)) return null
        return tpl("P='@PKG@'; for K in @PROPS@; do C=§(getprop §K); echo \"OLD §K=§C\"; " +
            "case \",§C,\" in *\",§P,\"*) ;; *) setprop §K \"§{C:+§C,}§P\" ;; esac; done; echo $DONE; $RESTART", pkg)
    }

    /** Убирает пакет из обоих свойств, остальные пакеты в них остаются; перезапускает камерный сервис. Прежних значений помнить не нужно. */
    fun restoreScript(pkg: String): String? {
        if (!PKG.matches(pkg)) return null
        return tpl("P='@PKG@'; for K in @PROPS@; do C=§(getprop §K); N=§(echo \",§C,\" | sed \"s/,§P,/,/g;s/^,//;s/,\\§//\"); " +
            "echo \"WAS §K=§C\"; setprop §K \"§N\"; done; echo $DONE; $RESTART", pkg)
    }

    fun clip(s: String, n: Int) = if (s.length <= n) s else s.take(n) + "\n… (+${s.length - n} chars)"
}
