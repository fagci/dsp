package app.dsp.phone

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * Окна поверх других приложений («Показ поверх других окон»): каждое показывает последний кадр холста узла страницы
 * (modules/floatwin.js шлёт кадры через DspApp.floatFrame). Окно двигается пальцем, ◢ в углу меняет ширину, × закрывает; в режиме touch
 * (кнопки, шкалы, клавиатуры узла) касания идут на узел, а окно двигается за ✥ в левом углу;
 * положение и ширина запоминаются по id узла. Нужно особое разрешение SYSTEM_ALERT_WINDOW (Settings.canDrawOverlays).
 */
object FloatWin {
    private class W(val root: FrameLayout, val img: ImageView, val lp: WindowManager.LayoutParams)

    private val wins = HashMap<String, W>()
    private val ui = Handler(Looper.getMainLooper())
    @Volatile var onClosed: ((String) -> Unit)? = null
    /** Касание внутри окна с opts.touch: (id, 0 — вниз / 1 — движение / 2 — вверх, x и y в долях окна 0…1, номер пальца — для щипка и других жестов в несколько пальцев). Страница превращает его в pointer-события узла. */
    @Volatile var onTouch: ((String, Int, Float, Float, Int) -> Unit)? = null
    /** Вызывается из основного потока каждые ~150 мс, пока есть окна: MainActivity просит страницу снять кадр (floatTick). */
    @Volatile var pump: (() -> Unit)? = null
    private var pumping = false
    private val pumpRun = object : Runnable {
        override fun run() {
            if (wins.isEmpty()) { pumping = false; return }
            try { pump?.invoke() } catch (e: Exception) { }
            ui.postDelayed(this, 150)
        }
    }
    private fun ensurePump() { if (!pumping) { pumping = true; ui.postDelayed(pumpRun, 150) } }

    fun can(ctx: Context): Boolean = Settings.canDrawOverlays(ctx)

    fun permissionIntent(ctx: Context): Intent =
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun show(ctx: Context, id: String, opts: JSONObject) { val app = ctx.applicationContext; ui.post { open(app, id, opts) } }

    fun frame(id: String, bmp: Bitmap) { ui.post { wins[id]?.img?.setImageBitmap(bmp) } }

    fun close(id: String) { ui.post { remove(id) } }

    fun closeAll() { ui.post { for (k in wins.keys.toList()) remove(k) } }

    private fun remove(id: String) {
        val w = wins.remove(id) ?: return
        try {
            val wm = w.root.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            wm.removeView(w.root)
        } catch (e: Exception) { }
    }

    private fun flagsFor(through: Boolean): Int {
        var f = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        if (through) f = f or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        return f
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun open(ctx: Context, id: String, opts: JSONObject) {
        val dm = ctx.resources.displayMetrics
        fun dp(v: Int) = (v * dm.density).toInt()
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val through = opts.optBoolean("through", false)
        val touch = opts.optBoolean("touch", false) && !through   // окно-пульт: касания уходят на узел, двигается за ✥
        val alpha = opts.optDouble("opacity", 0.85).toFloat().coerceIn(0.1f, 1f)
        val old = wins[id]
        if (old != null) {                                      // уже открыто — только новые параметры
            old.root.alpha = alpha
            old.lp.flags = flagsFor(through)
            try { wm.updateViewLayout(old.root, old.lp) } catch (e: Exception) { }
            return
        }
        val prefs = ctx.getSharedPreferences("float", Context.MODE_PRIVATE)
        val n = wins.size
        val lp = WindowManager.LayoutParams(
            prefs.getInt("$id.w", dp(opts.optInt("w", 220))), WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, flagsFor(through), PixelFormat.TRANSLUCENT)
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = prefs.getInt("$id.x", dp(12)); lp.y = prefs.getInt("$id.y", dp(80) + n * dp(60))
        val root = FrameLayout(ctx)
        root.setBackgroundColor(0x66000000)                     // полупрозрачная подложка: окно читается на любом фоне
        val img = ImageView(ctx)
        img.adjustViewBounds = true
        img.scaleType = ImageView.ScaleType.FIT_CENTER
        root.addView(img, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        val hs = dp(26)
        fun corner(text: String, g: Int): TextView {
            val t = TextView(ctx); t.text = text; t.setTextColor(0xFFFFFFFF.toInt()); t.setBackgroundColor(0x66000000)
            t.gravity = Gravity.CENTER; t.textSize = 13f
            root.addView(t, FrameLayout.LayoutParams(hs, hs, g)); return t
        }
        corner("×", Gravity.TOP or Gravity.END)
        corner("◢", Gravity.BOTTOM or Gravity.END)
        if (touch) corner("✥", Gravity.TOP or Gravity.START)
        root.alpha = alpha
        var mode = 0; var dx = 0f; var dy = 0f; var sx = 0; var sy = 0; var sw = 0; var moved = false
        fun touchOf(v: View, e: MotionEvent, act: Int, i: Int) =
            onTouch?.invoke(id, act, (e.getX(i) / v.width).coerceIn(0f, 1f), (e.getY(i) / v.height).coerceIn(0f, 1f), e.getPointerId(i))
        root.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dx = e.rawX; dy = e.rawY; sx = lp.x; sy = lp.y; sw = lp.width; moved = false
                    mode = when {
                        e.x > v.width - hs && e.y < hs -> 3
                        e.x > v.width - hs && e.y > v.height - hs -> 2
                        touch && e.x < hs && e.y < hs -> 1
                        touch -> 5
                        else -> 1
                    }
                    if (mode == 5) touchOf(v, e, 0, 0)
                    true
                }
                MotionEvent.ACTION_POINTER_DOWN -> { if (mode == 5) touchOf(v, e, 0, e.actionIndex); true }
                MotionEvent.ACTION_POINTER_UP -> { if (mode == 5) touchOf(v, e, 2, e.actionIndex); true }
                MotionEvent.ACTION_MOVE -> {
                    if (mode == 5) { for (i in 0 until e.pointerCount) touchOf(v, e, 1, i); return@setOnTouchListener true }
                    val ox = (e.rawX - dx).toInt(); val oy = (e.rawY - dy).toInt()
                    if (Math.abs(ox) > dp(4) || Math.abs(oy) > dp(4)) moved = true
                    if (mode == 1) { lp.x = sx + ox; lp.y = sy + oy; try { wm.updateViewLayout(root, lp) } catch (ex: Exception) { } }
                    else if (mode == 2) { lp.width = Math.max(dp(80), sw + ox); try { wm.updateViewLayout(root, lp) } catch (ex: Exception) { } }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (mode == 5) {                                    // UP — последний палец, CANCEL — отпускаем все
                        if (e.actionMasked == MotionEvent.ACTION_CANCEL) for (i in 0 until e.pointerCount) touchOf(v, e, 2, i) else touchOf(v, e, 2, e.actionIndex)
                        mode = 0; return@setOnTouchListener true
                    }
                    if (mode == 3 && !moved) { remove(id); onClosed?.invoke(id) }
                    else prefs.edit().putInt("$id.x", lp.x).putInt("$id.y", lp.y).putInt("$id.w", lp.width).apply()
                    mode = 0; true
                }
                else -> false
            }
        }
        try {
            wm.addView(root, lp)
            wins[id] = W(root, img, lp)
            ensurePump()
        } catch (e: Exception) {
            Toast.makeText(ctx, "Overlay: ${e.message}", Toast.LENGTH_LONG).show()
            onClosed?.invoke(id)
        }
    }
}
