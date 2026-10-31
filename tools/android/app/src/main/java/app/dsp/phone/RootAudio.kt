package app.dsp.phone

import android.media.AudioFormat
import android.media.AudioRecord
import android.os.Looper

/**
 * Помощник, который запускается от root: `su -c "CLASSPATH=<apk> app_process /system/bin app.dsp.phone.RootAudio <источник> <частота>"`.
 * Процесс root обходит проверку разрешения CAPTURE_AUDIO_OUTPUT, поэтому открывает источники, закрытые для приложений (VOICE_CALL / DOWNLINK / UPLINK,
 * REMOTE_SUBMIX). PCM 16 бит моно уходит в stdout, текст ошибки (ERR: …) — в stderr; читает их MicHub. Работает не на каждом телефоне:
 * аудио-HAL производителя может не отдавать звонок вовсе.
 */
object RootAudio {
    @JvmStatic
    fun main(a: Array<String>) {
        val src = a.getOrNull(0)?.toIntOrNull() ?: run { System.err.println("ERR: source"); System.exit(2); return }
        val rate = a.getOrNull(1)?.toIntOrNull() ?: 16000
        try { Looper.prepareMainLooper() } catch (e: Exception) { }
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) { System.err.println("ERR: $rate Hz is not supported"); System.exit(3); return }
        val chunk = MicArgs.chunk(rate)
        val rec = try { AudioRecord(src, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, chunk * 2 * 8)) }
        catch (e: Throwable) { System.err.println("ERR: " + e.javaClass.simpleName + ": " + e.message); System.exit(4); return }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { System.err.println("ERR: the source " + MicArgs.sourceName(src) + " did not open (the phone's audio HAL does not give it, or it is busy)"); System.exit(5); return }
        val s = ShortArray(chunk); val b = ByteArray(chunk * 2)
        try {
            rec.startRecording()
            val out = java.io.FileOutputStream(java.io.FileDescriptor.out)          // обрыв канала (страница / служба ушла) — IOException, а не молчание PrintStream
            while (true) {
                var n = 0
                while (n < chunk) { val k = rec.read(s, n, chunk - n); if (k <= 0) { System.err.println("ERR: read error ($k)"); System.exit(6); return }; n += k }
                for (i in 0 until chunk) { b[2 * i] = s[i].toInt().toByte(); b[2 * i + 1] = (s[i].toInt() shr 8).toByte() }
                out.write(b)
            }
        } catch (e: Throwable) { System.err.println("ERR: " + e.message); System.exit(7) }
    }
}
