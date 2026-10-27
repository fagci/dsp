package app.dsp.phone

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Surface
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Режим высокой скорости без кодека. Сессия constrained high-speed принимает поверхность предпросмотра (SurfaceTexture), а кодер → декодер
 * на этом телефоне не успевал дальше 10–15 к/с. Здесь каждый кадр рисуется видеокартой в крохотную картинку 32×18 (усреднение), второй проход сводит её
 * к одному числу — яркости — и пишет в текстуру-накопитель; с видеокарты данные читаются раз в ~50 мс (чтение на каждый кадр останавливало конвейер и
 * отбрасывало кадры: из 120 выходило 20–30). Для просмотра раз в ~250 мс рисуется картинка побольше (JPEG).
 */
class HsGl(
    private val w: Int, private val h: Int, private val rot: Int, private val quality: Int, private val fps: Int,
    private val onLum: (FloatArray, Int, Double) -> Unit,            // пачка яркостей (0…255), сколько, средний шаг между кадрами, мс
    private val onPic: (ByteArray) -> Unit,
    private val onFail: (String) -> Unit,
) {
    private val th = HandlerThread("dsp-hs-gl", android.os.Process.THREAD_PRIORITY_DISPLAY).also { it.start() }
    private val pic = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "dsp-hs-jpeg").also { it.isDaemon = true } }
    @Volatile private var picBusy = false
    private val hd = Handler(th.looper)
    lateinit var surface: Surface
        private set
    @Volatile private var alive = false

    private var dpy: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var ctx: EGLContext = EGL14.EGL_NO_CONTEXT
    private var sfc: EGLSurface = EGL14.EGL_NO_SURFACE
    private var st: SurfaceTexture? = null
    private var tex = 0
    private var prog = 0
    private var progB = 0
    private var aPos = 0; private var uCell = 0; private var uColor = 0; private var uTex = 0
    private var aPosB = 0; private var uSmall = 0
    private val fbo = IntArray(3); private val fbt = IntArray(3)       // 0 — малая картинка, 1 — для просмотра, 2 — накопитель яркостей (ACC×1)
    private val sw = 32; private val sh = 18                          // кадр для яркости
    private val acc = 256
    private val pw = if (w >= 240) 240 else w; private val ph = (pw * h / w).coerceAtLeast(2)    // кадр для просмотра
    private val accBuf = ByteBuffer.allocateDirect(acc * 4).order(ByteOrder.nativeOrder())
    private val tsBuf = LongArray(acc)
    private var nk = 0
    private val bigBuf = ByteBuffer.allocateDirect(pw * ph * 4).order(ByteOrder.nativeOrder())
    private val quad: FloatBuffer = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().also { it.put(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)); it.position(0) }

    private var lastFlush = 0L; private var lastPic = 0L

    fun start() {
        val latch = CountDownLatch(1)
        var err: String? = null
        hd.post {
            try { init() } catch (e: Throwable) { err = e.message ?: e.javaClass.simpleName }
            latch.countDown()
        }
        if (!latch.await(4, TimeUnit.SECONDS)) err = "OpenGL did not start"
        err?.let { release(); throw RuntimeException(it) }
        alive = true
    }

    private fun check(what: String) { val e = GLES20.glGetError(); if (e != 0) throw RuntimeException("$what: GL error $e") }

    private fun shader(type: Int, src: String): Int {
        val s = GLES20.glCreateShader(type)
        GLES20.glShaderSource(s, src); GLES20.glCompileShader(s)
        val ok = IntArray(1); GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
        if (ok[0] == 0) throw RuntimeException("shader: " + GLES20.glGetShaderInfoLog(s).take(120))
        return s
    }

    private fun init() {
        dpy = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val v = IntArray(2)
        if (!EGL14.eglInitialize(dpy, v, 0, v, 1)) throw RuntimeException("EGL init")
        val cfgs = arrayOfNulls<EGLConfig>(1); val n = IntArray(1)
        EGL14.eglChooseConfig(dpy, intArrayOf(EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8, EGL14.EGL_NONE), 0, cfgs, 0, 1, n, 0)
        val cfg = cfgs[0] ?: throw RuntimeException("EGL config")
        ctx = EGL14.eglCreateContext(dpy, cfg, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        sfc = EGL14.eglCreatePbufferSurface(dpy, cfg, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
        if (!EGL14.eglMakeCurrent(dpy, sfc, sfc, ctx)) throw RuntimeException("EGL context")

        val vs = shader(GLES20.GL_VERTEX_SHADER, "attribute vec4 p; varying vec2 uv; void main(){ gl_Position=p; uv=p.xy*0.5+0.5; }")
        val fs = shader(GLES20.GL_FRAGMENT_SHADER, """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            varying vec2 uv; uniform samplerExternalOES tex; uniform vec2 cell; uniform float color;
            void main(){
              vec3 s = vec3(0.0);
              for (int i = 0; i < 6; i++) for (int j = 0; j < 6; j++) s += texture2D(tex, uv + (vec2(float(i), float(j)) - 2.5) / 6.0 * cell).rgb;
              s /= 36.0;
              float y = dot(s, vec3(0.299, 0.587, 0.114));
              gl_FragColor = color > 0.5 ? vec4(s, 1.0) : vec4(y, y, y, 1.0);
            }""".trimIndent())
        prog = GLES20.glCreateProgram()
        GLES20.glAttachShader(prog, vs); GLES20.glAttachShader(prog, fs); GLES20.glLinkProgram(prog)
        val ok = IntArray(1); GLES20.glGetProgramiv(prog, GLES20.GL_LINK_STATUS, ok, 0)
        if (ok[0] == 0) throw RuntimeException("program: " + GLES20.glGetProgramInfoLog(prog).take(120))
        val fb = shader(GLES20.GL_FRAGMENT_SHADER, """
            precision highp float;
            uniform sampler2D small;
            void main(){
              float s = 0.0;
              for (int i = 0; i < $sw; i++) for (int j = 0; j < $sh; j++) s += texture2D(small, vec2((float(i) + 0.5) / ${sw}.0, (float(j) + 0.5) / ${sh}.0)).r;
              float v = floor(s / ${sw * sh}.0 * 65535.0 + 0.5);
              float hi = floor(v / 256.0);
              gl_FragColor = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
            }""".trimIndent())
        progB = GLES20.glCreateProgram()
        GLES20.glAttachShader(progB, vs); GLES20.glAttachShader(progB, fb); GLES20.glLinkProgram(progB)
        GLES20.glGetProgramiv(progB, GLES20.GL_LINK_STATUS, ok, 0)
        if (ok[0] == 0) throw RuntimeException("program B: " + GLES20.glGetProgramInfoLog(progB).take(120))
        aPosB = GLES20.glGetAttribLocation(progB, "p"); uSmall = GLES20.glGetUniformLocation(progB, "small")
        aPos = GLES20.glGetAttribLocation(prog, "p"); uCell = GLES20.glGetUniformLocation(prog, "cell")
        uColor = GLES20.glGetUniformLocation(prog, "color"); uTex = GLES20.glGetUniformLocation(prog, "tex")

        val t = IntArray(1)
        GLES20.glGenTextures(1, t, 0); tex = t[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, tex)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)

        GLES20.glGenFramebuffers(3, fbo, 0); GLES20.glGenTextures(3, fbt, 0)
        for (i in 0..2) {
            val ww = if (i == 0) sw else if (i == 1) pw else acc; val hh = if (i == 0) sh else if (i == 1) ph else 1
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fbt[i])
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, ww, hh, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[i])
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, fbt[i], 0)
            if (GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) != GLES20.GL_FRAMEBUFFER_COMPLETE) throw RuntimeException("framebuffer")
        }
        check("init")

        val s = SurfaceTexture(tex)
        s.setDefaultBufferSize(w, h)
        s.setOnFrameAvailableListener({ hd.post { frame() } }, hd)
        st = s
        surface = Surface(s)
    }

    /** Рисует кадр камеры в цель i (0 — малая, 1 — для просмотра): каждая точка цели — среднее по 16 отсчётам своего участка кадра. */
    private fun draw(i: Int, ww: Int, hh: Int) {
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[i])
        GLES20.glViewport(0, 0, ww, hh)
        GLES20.glUseProgram(prog)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, tex)
        GLES20.glUniform1i(uTex, 0)
        GLES20.glUniform2f(uCell, 1f / ww, 1f / hh)
        GLES20.glUniform1f(uColor, if (i == 1) 1f else 0f)
        GLES20.glEnableVertexAttribArray(aPos)
        GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, quad)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    }

    private fun frame() {
        val st0 = st ?: return
        if (!alive) return
        try {
            st0.updateTexImage()
            val ts = st0.timestamp
            draw(0, sw, sh)                                           // кадр камеры → 32×18
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[2])   // 32×18 → одно число в текстуру-накопитель, без чтения на CPU
            GLES20.glViewport(nk, 0, 1, 1)
            GLES20.glUseProgram(progB)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fbt[0])
            GLES20.glUniform1i(uSmall, 0)
            GLES20.glEnableVertexAttribArray(aPosB)
            GLES20.glVertexAttribPointer(aPosB, 2, GLES20.GL_FLOAT, false, 0, quad)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            tsBuf[nk++] = ts
            val now = SystemClock.elapsedRealtime()
            if (nk >= acc || now - lastFlush >= 50) flush(now)
            if (now - lastPic >= 250) { lastPic = now; picture() }
        } catch (e: Exception) { if (alive) { alive = false; onFail(e.message ?: e.javaClass.simpleName) } }
    }

    /** Читает накопленные яркости одним обращением к видеокарте. */
    private fun flush(now: Long) {
        lastFlush = now
        val n = nk; if (n == 0) return
        nk = 0
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[2])
        accBuf.rewind()
        GLES20.glReadPixels(0, 0, n, 1, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, accBuf)
        val v = FloatArray(n)
        for (i in 0 until n) v[i] = (((accBuf.get(i * 4).toInt() and 0xff) * 256 + (accBuf.get(i * 4 + 1).toInt() and 0xff)) / 65535f) * 255f
        val dt = if (n > 1 && tsBuf[n - 1] > tsBuf[0]) (tsBuf[n - 1] - tsBuf[0]) / 1e6 / (n - 1) else 1000.0 / fps
        onLum(v, n, dt)
    }

    /** Картинка для просмотра: рисуется и читается на потоке видеокарты, а поворот и JPEG — на отдельном (иначе они отнимали у яркости десятки кадров). */
    private fun picture() {
        if (picBusy) return
        draw(1, pw, ph)
        bigBuf.rewind()
        GLES20.glReadPixels(0, 0, pw, ph, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, bigBuf)
        bigBuf.rewind()
        val bmp = Bitmap.createBitmap(pw, ph, Bitmap.Config.ARGB_8888)
        bmp.copyPixelsFromBuffer(bigBuf)
        picBusy = true
        try {
            pic.execute {
                try {
                    val m = Matrix(); m.postRotate(rot.toFloat())
                    val r = Bitmap.createBitmap(bmp, 0, 0, pw, ph, m, false)
                    val bos = ByteArrayOutputStream(pw * ph / 4)
                    r.compress(Bitmap.CompressFormat.JPEG, quality, bos)
                    if (r !== bmp) r.recycle()
                    bmp.recycle()
                    onPic(bos.toByteArray())
                } catch (e: Exception) {} finally { picBusy = false }
            }
        } catch (e: Exception) { picBusy = false }
    }

    private fun release() {
        alive = false
        val done = CountDownLatch(1)
        hd.post {
            try { surface.release() } catch (e: Throwable) {}
            try { st?.release() } catch (e: Throwable) {}
            st = null
            try { if (dpy != EGL14.EGL_NO_DISPLAY) {
                EGL14.eglMakeCurrent(dpy, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                if (sfc != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(dpy, sfc)
                if (ctx != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(dpy, ctx)
                EGL14.eglTerminate(dpy)
            } } catch (e: Throwable) {}
            dpy = EGL14.EGL_NO_DISPLAY; ctx = EGL14.EGL_NO_CONTEXT; sfc = EGL14.EGL_NO_SURFACE
            done.countDown()
        }
        try { done.await(1, TimeUnit.SECONDS) } catch (e: Exception) {}
        th.quitSafely()
        pic.shutdownNow()
    }

    fun stop() = release()
}
