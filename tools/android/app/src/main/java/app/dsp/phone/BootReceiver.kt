package app.dsp.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Старт моста при загрузке телефона, если включено в Settings («Start automatically when the phone boots»). Поднимает только
 * сервис (сенсоры/радио начинают буферизоваться, уведомление в строке состояния готово) — страница приложения (где живёт сам
 * патч и Rule-автоматизация) при этом не открывается: Android с некоторых версий не даёт стартовать окно из фонового ресивера,
 * только сервис. Открыть приложение и подключить узел моста один раз после перезагрузки всё равно нужно, чтобы граф снова тикал.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        when (i.action) {
            Intent.ACTION_BOOT_COMPLETED, "android.intent.action.QUICKBOOT_POWERON" -> {
                Alarms.rescheduleAll(ctx)
                val cfg = Config(ctx)
                val patches = BootPatches.parse(cfg.bootPatches).isNotEmpty()       // патчи без окна (HeadlessHub) тоже поднимают мост
                if (cfg.autoStart || patches) BridgeService.start(ctx, boot = patches)
            }
            Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_MY_PACKAGE_REPLACED -> Alarms.rescheduleAll(ctx)    // будильники привязаны к часам и сбрасываются при обновлении
        }
    }
}
