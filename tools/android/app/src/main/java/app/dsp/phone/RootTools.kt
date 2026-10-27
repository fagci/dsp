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
