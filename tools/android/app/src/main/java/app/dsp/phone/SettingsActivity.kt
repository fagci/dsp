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
    private lateinit var check: Switch
    private lateinit var sniff: Switch
    private lateinit var openc: Switch
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
        share = Switch(this).apply { text = "Allow other devices on the network"; isChecked = cfg.shareLan; setPadding(0, pad, 0, 0) }
        root.addView(share)
        strict = Switch(this).apply { text = "Require the token on this phone too (if a token is set)"; isChecked = cfg.strict; setPadding(0, pad, 0, 0) }
        root.addView(strict)
        check = Switch(this).apply { text = "Check the site of browsers (Origin); off — any page may connect"; isChecked = cfg.checkOrigin; setPadding(0, pad, 0, 0) }
        root.addView(check)
        sniff = Switch(this).apply { text = "Allow root features: packet capture (su + tcpdump), raw IP packets"; isChecked = cfg.sniffer; setPadding(0, pad, 0, 0) }
        root.addView(sniff)
        openc = Switch(this).apply { text = "Let any page use actions (network sockets, Bluetooth connections, speech, phone control); off — only the app's own page"; isChecked = cfg.openCmds; setPadding(0, pad, 0, 0) }
        root.addView(openc)
        root.addView(Button(this).apply {
            text = "Notification access (automation events)"
            setOnClickListener { try { startActivity(android.content.Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")) } catch (e: Exception) {} }
        })
        text("Port"); port = edit(cfg.port.toString(), true)
        text("Token (empty — no token, anyone who can reach the port gets in)"); token = edit(cfg.token)
        text("Sites allowed when the Origin check is on (origins, comma separated; the app itself and localhost are always allowed)"); origins = edit(cfg.origins)
        root.addView(Button(this).apply {
            text = "New token"
            setOnClickListener { token.setText(cfg.newToken()) }
        })
        root.addView(Button(this).apply {
            text = "Stop the bridge"
            setOnClickListener { BridgeService.stop(this@SettingsActivity); Toast.makeText(this@SettingsActivity, "Stopped. Open the app to start it again.", Toast.LENGTH_SHORT).show() }
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
        cfg.port = p; cfg.token = t; cfg.shareLan = share.isChecked; cfg.strict = strict.isChecked; cfg.checkOrigin = check.isChecked; cfg.sniffer = sniff.isChecked; cfg.openCmds = openc.isChecked
        cfg.origins = origins.text.toString().trim()
        BridgeService.start(this, reload = true)
        show()
        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
    }

    private fun show() {
        val p = cfg.port
        val sb = StringBuilder("On this phone:\n  ws://127.0.0.1:$p\n")
        if (cfg.shareLan) {
            val q = if (cfg.token.isEmpty()) "" else "token=${cfg.token}"
            sb.append(if (q.isEmpty()) "\nOn the network (no token — open to everyone on it):\n" else "\nOn the network (the token is part of the address):\n")
            for (ip in BridgeService.lan()) sb.append("  ws://$ip:$p/" + (if (q.isEmpty()) "" else "?$q") + "\n")
        }
        info.text = sb.toString()
    }
}
