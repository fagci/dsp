package app.dsp.phone

import android.app.Activity
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/** Настройки моста: порт, доступ из сети, токен, разрешённые сайты. */
class SettingsActivity : Activity() {
    private lateinit var cfg: Config
    private lateinit var info: TextView
    private lateinit var share: Switch
    private lateinit var strict: Switch
    private lateinit var port: EditText
    private lateinit var token: EditText
    private lateinit var origins: EditText

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        cfg = Config(this)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun text(t: String) = TextView(this).apply { text = t; setPadding(0, pad, 0, 0) }.also { root.addView(it) }
        fun edit(v: String, number: Boolean = false) = EditText(this).apply {
            setText(v); setSingleLine(); if (number) inputType = InputType.TYPE_CLASS_NUMBER
        }.also { root.addView(it) }

        info = text("")
        share = Switch(this).apply { text = "Allow other devices on the network (token required)"; isChecked = cfg.shareLan; setPadding(0, pad, 0, 0) }
        root.addView(share)
        strict = Switch(this).apply { text = "Require the token on this phone too"; isChecked = cfg.strict; setPadding(0, pad, 0, 0) }
        root.addView(strict)
        text("Port"); port = edit(cfg.port.toString(), true)
        text("Token"); token = edit(cfg.token)
        text("Sites allowed to connect (origins, comma separated; the app itself and localhost are always allowed)"); origins = edit(cfg.origins)
        root.addView(Button(this).apply {
            text = "New token"
            setOnClickListener { token.setText(cfg.newToken()) }
        })
        root.addView(Button(this).apply {
            text = "Save and restart the bridge"
            setOnClickListener { save() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(ScrollView(this).apply { addView(root) })
        show()
    }

    private fun save() {
        val p = port.text.toString().toIntOrNull()
        if (p == null || p < 1024 || p > 65535) { Toast.makeText(this, "Port: 1024–65535", Toast.LENGTH_SHORT).show(); return }
        val t = token.text.toString().trim()
        if (t.length < 8) { Toast.makeText(this, "Token: at least 8 characters", Toast.LENGTH_SHORT).show(); return }
        cfg.port = p; cfg.token = t; cfg.shareLan = share.isChecked; cfg.strict = strict.isChecked
        cfg.origins = origins.text.toString().trim()
        BridgeService.start(this, reload = true)
        show()
        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
    }

    private fun show() {
        val p = cfg.port
        val sb = StringBuilder("On this phone:\n  ws://127.0.0.1:$p\n  http://127.0.0.1:$p/camera.mjpg?cam=back&w=640&fps=10\n")
        if (cfg.shareLan) {
            sb.append("\nOn the network (the token is part of the address):\n")
            for (ip in BridgeService.lan()) sb.append("  ws://$ip:$p/?token=${cfg.token}\n  http://$ip:$p/camera.mjpg?cam=back&token=${cfg.token}\n")
        }
        info.text = sb.toString()
    }
}
