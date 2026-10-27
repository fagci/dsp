package app.dsp.phone

import android.app.Activity
import android.app.NotificationManager
import android.os.Bundle

/** Прозрачное окно запроса разрешений для источников, которые выбрали на странице. */
class PermissionActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val want = intent.getStringArrayExtra(EXTRA)?.filter { !granted(it) } ?: emptyList()
        if (want.isEmpty()) { finish(); return }
        requestPermissions(want.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(BridgeService.PERM_ID)
        BridgeService.start(this)             // типы foreground-сервиса зависят от разрешений; источники включатся заново
        finish()
    }

    companion object { const val EXTRA = "perms" }
}
