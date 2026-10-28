package app.dsp.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.security.MessageDigest

/**
 * Управление мостом из других приложений (Tasker, MacroDroid, adb): action app.dsp.phone.EXT, extras cmd = start | stop | emit.
 * emit отдаёт запись {src:'ext', name, value, text} подписчикам ext — патч видит событие. Выключено, пока не включено в Settings;
 * при заданном токене нужен extra token.
 */
class ExternalReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        val cfg = Config(ctx)
        if (!cfg.extIntents) return
        if (cfg.token.isNotEmpty() && !MessageDigest.isEqual(cfg.token.toByteArray(), (i.getStringExtra("token") ?: "").toByteArray())) return
        try {
            when (i.getStringExtra("cmd") ?: "emit") {
                "start" -> BridgeService.start(ctx)
                "stop" -> BridgeService.stop(ctx)
                else -> BridgeService.inst?.emitExt(i.getStringExtra("name") ?: "", i.getStringExtra("value"), i.getStringExtra("text"))
            }
        } catch (e: Exception) { /* из фона сервис иногда стартовать нельзя — не падаем */ }
    }
}
