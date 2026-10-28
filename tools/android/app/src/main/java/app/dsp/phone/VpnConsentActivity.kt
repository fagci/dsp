package app.dsp.phone

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle

/**
 * Прозрачное окно разрешения на сам VPN — системный диалог («Запрос на подключение», список «Разрешить» / «Отмена»),
 * мы его не рисуем, только запускаем. Аналог PermissionActivity, но под отдельный механизм VpnService.prepare().
 */
class VpnConsentActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val prep = VpnService.prepare(this)
        if (prep == null) { startForegroundService(Intent(this, DspVpnService::class.java)); finish() }
        else startActivityForResult(prep, REQ)
    }

    override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        if (result == RESULT_OK) startForegroundService(Intent(this, DspVpnService::class.java))
        finish()
    }

    companion object { private const val REQ = 1 }
}
