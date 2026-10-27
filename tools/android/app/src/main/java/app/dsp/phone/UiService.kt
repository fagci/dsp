package app.dsp.phone

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

/**
 * Управление интерфейсом без root: нажатия и свайпы жестами, кнопки Назад / Домой / Недавние / шторка, нажатие по тексту, ввод текста в поле,
 * чтение видимого текста экрана. Включается пользователем в Settings → Accessibility → DSP (приложение само включить сервис не может).
 * События смены окна уходят в источник sys: {ev:'window', pkg, cls}.
 */
class UiService : AccessibilityService() {
    override fun onServiceConnected() { inst = this }
    override fun onUnbind(i: android.content.Intent?): Boolean { if (inst === this) inst = null; return super.onUnbind(i) }
    override fun onInterrupt() {}

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        if (e.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val s = sink ?: return
        s(Json.obj("src" to "\"sys\"", "ev" to "\"window\"", "t" to System.currentTimeMillis().toString(), "pkg" to Json.str(e.packageName?.toString()), "cls" to Json.str(e.className?.toString())))
    }

    private fun gesture(c: BridgeServer.Client, id: Any?, cmd: String, p: Path, ms: Long) {
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(p, 0, ms.coerceIn(1, 60_000))).build()
        val ok = dispatchGesture(g, object : GestureResultCallback() {
            override fun onCompleted(d: GestureDescription?) { Reply.done(c, id, cmd, null) }
            override fun onCancelled(d: GestureDescription?) { Reply.done(c, id, cmd, "gesture cancelled") }
        }, null)
        if (!ok) Reply.done(c, id, cmd, "gesture refused")
    }

    private fun clickable(n: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        var x = n
        while (x != null && !x.isClickable) x = x.parent
        return x
    }

    private fun dump(n: AccessibilityNodeInfo?, out: MutableList<String>, depth: Int) {
        if (n == null || out.size >= 300 || depth > 40) return
        val t = n.text?.toString() ?: n.contentDescription?.toString()
        if (!t.isNullOrBlank() && n.isVisibleToUser) {
            val r = android.graphics.Rect(); n.getBoundsInScreen(r)
            out.add(Json.obj("text" to Json.str(t.take(200)), "id" to Json.str(n.viewIdResourceName), "x" to r.centerX().toString(), "y" to r.centerY().toString(),
                "click" to if (n.isClickable) "1" else "0", "edit" to if (n.isEditable) "1" else "0"))
        }
        for (i in 0 until n.childCount) dump(n.getChild(i), out, depth + 1)
    }

    fun exec(c: BridgeServer.Client, id: Any?, cmd: String, j: JSONObject) {
        when (cmd) {
            "ui.tap" -> gesture(c, id, cmd, Path().apply { moveTo(j.optDouble("x").toFloat(), j.optDouble("y").toFloat()) }, j.optLong("ms", 60))
            "ui.swipe" -> gesture(c, id, cmd, Path().apply { moveTo(j.optDouble("x").toFloat(), j.optDouble("y").toFloat()); lineTo(j.optDouble("x2").toFloat(), j.optDouble("y2").toFloat()) }, j.optLong("ms", 300))
            "ui.global" -> {
                val a = when (j.optString("action")) {
                    "back" -> GLOBAL_ACTION_BACK; "home" -> GLOBAL_ACTION_HOME; "recents" -> GLOBAL_ACTION_RECENTS
                    "notifications" -> GLOBAL_ACTION_NOTIFICATIONS; "settings" -> GLOBAL_ACTION_QUICK_SETTINGS
                    "lock" -> GLOBAL_ACTION_LOCK_SCREEN; "screenshot" -> GLOBAL_ACTION_TAKE_SCREENSHOT
                    else -> return Reply.done(c, id, cmd, "action: back, home, recents, notifications, settings, lock or screenshot")
                }
                Reply.done(c, id, cmd, if (performGlobalAction(a)) null else "refused")
            }
            "ui.click" -> {
                val t = j.optString("text"); if (t.isEmpty()) return Reply.done(c, id, cmd, "text")
                val hit = rootInActiveWindow?.findAccessibilityNodeInfosByText(t)?.firstNotNullOfOrNull { clickable(it) }
                Reply.done(c, id, cmd, if (hit?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) null else "no clickable «$t» on the screen")
            }
            "ui.text" -> {
                val f = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return Reply.done(c, id, cmd, "no focused text field")
                val b = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, j.optString("text")) }
                Reply.done(c, id, cmd, if (f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b)) null else "refused")
            }
            "ui.screen" -> {
                val rows = ArrayList<String>(); dump(rootInActiveWindow, rows, 0)
                if (rows.isNotEmpty()) c.send(Json.rows(rows.map { it.replaceFirst("{", "{\"src\":\"uitext\",") }))
                Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString(), "pkg" to Json.str(rootInActiveWindow?.packageName?.toString())))
            }
        }
    }

    companion object {
        @Volatile var inst: UiService? = null
        @Volatile var sink: ((String) -> Unit)? = null
    }
}
