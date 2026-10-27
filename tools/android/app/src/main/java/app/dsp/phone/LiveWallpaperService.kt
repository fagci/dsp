package app.dsp.phone

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.service.wallpaper.WallpaperService
import android.view.SurfaceHolder

/**
 * Живые обои из кадров, которые присылает страница (DspApp.wallpaper, из modules/wallpaper.js): последний полученный Bitmap
 * рисуется заново на каждое изменение видимости / размера поверхности и раз в секунду, пока обои видны (центр-кроп, без
 * искажений). Кадры идут, пока приложение на экране (или в плавающем PiP) — иначе страница не рисуется и не шлёт новых,
 * как и с микрофоном / камерой; фон просто остаётся на последнем кадре, не ломается.
 */
class LiveWallpaperService : WallpaperService() {
    override fun onCreateEngine(): Engine = DspEngine()

    private inner class DspEngine : Engine() {
        private val handler = Handler(Looper.getMainLooper())
        private var visible = false
        private val tick = object : Runnable {
            override fun run() { draw(); if (visible) handler.postDelayed(this, 400) }
        }

        override fun onVisibilityChanged(v: Boolean) {
            visible = v
            handler.removeCallbacks(tick)
            if (v) handler.post(tick)
        }

        override fun onSurfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) { draw() }

        private fun draw() {
            val holder = surfaceHolder
            val bmp = frame ?: return
            var canvas: Canvas? = null
            try {
                canvas = holder.lockCanvas() ?: return
                val dst = canvas.clipBounds.takeIf { !it.isEmpty } ?: Rect(0, 0, canvas.width, canvas.height)
                canvas.drawColor(Color.BLACK)
                val k = maxOf(dst.width().toFloat() / bmp.width, dst.height().toFloat() / bmp.height)   // center-crop
                val w = bmp.width * k; val h = bmp.height * k
                val left = dst.centerX() - w / 2; val top = dst.centerY() - h / 2
                canvas.drawBitmap(bmp, null, android.graphics.RectF(left, top, left + w, top + h), Paint(Paint.FILTER_BITMAP_FLAG))
            } catch (e: Exception) { /* поверхность отвалилась между проверками — следующий кадр нарисует заново */ }
            finally { try { canvas?.let { holder.unlockCanvasAndPost(it) } } catch (e: Exception) {} }
        }

        override fun onDestroy() { handler.removeCallbacks(tick) }
    }

    companion object {
        @Volatile var frame: android.graphics.Bitmap? = null
        /** Новый кадр: рисуется на ближайшем тике всех живых движков (один процесс — одна активная поверхность обычно). */
        fun push(b: android.graphics.Bitmap) { frame = b }
    }
}
