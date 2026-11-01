package app.dsp.phone

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView

/**
 * Место для картинки нативного плеера: на весь экран поверх страницы (системные панели скрыты) или окно поверх других приложений
 * (✥ двигает, ◢ меняет размер 16:9, ✕ закрывает; разрешение «Показ поверх других окон»). Не знает, что внутри — ExoPlayer, libVLC или что-то ещё.
 */
object PlayerOverlay {
    class Handle(private val closer: () -> Unit) {
        private var done = false
        fun close() { if (!done) { done = true; closer() } }
    }

    private fun handleView(ctx: Context, txt: String): TextView {
        val t = TextView(ctx)
        t.text = txt; t.textSize = 18f; t.setTextColor(Color.WHITE); t.setPadding(26, 12, 26, 12); t.setBackgroundColor(0x66000000)
        return t
    }

    /** На весь экран; onClosed вызывается, когда закрыл пользователь (✕). */
    fun fullscreen(act: Activity, content: View, onClosed: () -> Unit): Handle {
        val box = FrameLayout(act)
        box.setBackgroundColor(Color.BLACK)
        box.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val deco = act.window.decorView as ViewGroup
        var prev = 0
        val h = Handle {
            (box.parent as? ViewGroup)?.removeView(box)
            @Suppress("DEPRECATION")
            act.window.decorView.systemUiVisibility = prev
        }
        val x = handleView(act, "✕")
        x.setOnClickListener { h.close(); onClosed() }
        box.addView(x, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END))
        deco.addView(box, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        @Suppress("DEPRECATION")
        run {
            prev = deco.systemUiVisibility
            deco.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
        return h
    }

    /** Окно поверх других приложений; нужно разрешение (FloatWin.can). */
    @SuppressLint("ClickableViewAccessibility")
    fun floating(act: Activity, content: View, onClosed: () -> Unit): Handle {
        val app = act.applicationContext
        val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val dm = app.resources.displayMetrics
        val w0 = (dm.widthPixels * 0.62f).toInt().coerceAtLeast(360)
        val lp = WindowManager.LayoutParams(w0, w0 * 9 / 16, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT)
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = dm.widthPixels / 5; lp.y = dm.heightPixels / 6
        val box = FrameLayout(app)
        box.setBackgroundColor(Color.BLACK)
        box.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val h = Handle { try { wm.removeView(box) } catch (e: Exception) { } }
        fun add(txt: String, gravity: Int): TextView {
            val t = handleView(app, txt)
            box.addView(t, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, gravity))
            return t
        }
        val move = add("✥", Gravity.TOP or Gravity.START)
        val xBtn = add("✕", Gravity.TOP or Gravity.END)
        val grip = add("◢", Gravity.BOTTOM or Gravity.END)
        xBtn.setOnClickListener { h.close(); onClosed() }
        var sx = 0f; var sy = 0f; var ox = 0; var oy = 0; var ow = 0
        move.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { sx = e.rawX; sy = e.rawY; ox = lp.x; oy = lp.y }
                MotionEvent.ACTION_MOVE -> { lp.x = ox + (e.rawX - sx).toInt(); lp.y = oy + (e.rawY - sy).toInt(); try { wm.updateViewLayout(box, lp) } catch (x: Exception) { } }
            }
            true
        }
        grip.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { sx = e.rawX; ow = lp.width }
                MotionEvent.ACTION_MOVE -> {
                    lp.width = (ow + (e.rawX - sx).toInt()).coerceIn(300, dm.widthPixels); lp.height = lp.width * 9 / 16
                    try { wm.updateViewLayout(box, lp) } catch (x: Exception) { }
                }
            }
            true
        }
        wm.addView(box, lp)
        return h
    }
}
