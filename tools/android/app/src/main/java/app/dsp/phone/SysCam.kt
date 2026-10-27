package app.dsp.phone

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Looper

/**
 * Отдельный процесс от uid 1000 (system), запускаемый из root через `app_process` (см. RootCam.sysCamScript): список камер, которые
 * видит системное приложение. Часть камер помечена производителем как системные (ANDROID_REQUEST_AVAILABLE_CAPABILITIES_SYSTEM_CAMERA)
 * или защищённые — обычному приложению камерный сервис их не показывает и не открывает, системному uid — показывает.
 * Контекста у такого процесса нет, он собирается отражением (так же поступает scrcpy). Всё, что не получилось, печатается в вывод:
 * это разведка — по тексту видно, на каком шаге остановились.
 */
object SysCam {
    /** Имена возможностей камеры по номерам (CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES). */
    val CAPS = mapOf(0 to "BACKWARD_COMPATIBLE", 1 to "MANUAL_SENSOR", 2 to "MANUAL_POST_PROCESSING", 3 to "RAW", 4 to "PRIVATE_REPROCESSING", 5 to "READ_SENSOR_SETTINGS",
        6 to "BURST_CAPTURE", 7 to "YUV_REPROCESSING", 8 to "DEPTH_OUTPUT", 9 to "HIGH_SPEED_VIDEO", 10 to "MOTION_TRACKING", 11 to "LOGICAL_MULTI_CAMERA",
        12 to "MONOCHROME", 13 to "SECURE_IMAGE_DATA", 14 to "SYSTEM_CAMERA", 15 to "OFFLINE_PROCESSING", 16 to "ULTRA_HIGH_RES_SENSOR", 17 to "REMOSAIC_REPROCESSING")

    fun capNames(c: IntArray?): String = c?.joinToString(",") { CAPS[it] ?: "cap$it" } ?: "?"

    @JvmStatic
    fun main(args: Array<String>) {
        try {
            try { Looper.prepareMainLooper() } catch (e: Exception) { /* уже есть */ }
            println("uid=" + android.os.Process.myUid() + " sdk=" + android.os.Build.VERSION.SDK_INT)
            val ctx = systemContext()
            val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val ids = cm.cameraIdList
            println("cameraIdList: " + ids.joinToString(","))
            for (id in ids) {
                try {
                    val ch = cm.getCameraCharacteristics(id)
                    val facing = when (ch.get(CameraCharacteristics.LENS_FACING)) { 0 -> "front"; 1 -> "back"; 2 -> "external"; else -> "?" }
                    val phys = if (android.os.Build.VERSION.SDK_INT >= 28) ch.physicalCameraIds.joinToString(",") else ""
                    val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                    val big = map?.getOutputSizes(0x23)?.maxByOrNull { it.width * it.height }
                    println("  id $id: $facing caps=${capNames(ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES))}" +
                        " formats=${map?.outputFormats?.joinToString(",") { "0x" + Integer.toHexString(it) }} max=$big focal=${ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.joinToString("/")}" +
                        (if (phys.isNotEmpty()) " physical=$phys" else ""))
                } catch (e: Throwable) { println("  id $id: ${e.javaClass.simpleName}: ${e.message}") }
            }
            // ids, которых нет в списке, но могут существовать
            for (n in 0..9) if (n.toString() !in ids) try {
                cm.getCameraCharacteristics(n.toString()); println("  id $n: not listed, but has characteristics")
            } catch (e: Throwable) { /* нет такой — обычное дело */ }
        } catch (e: Throwable) {
            println("failed: $e")
            e.printStackTrace(System.out)
        }
        System.out.flush()
        System.exit(0)
    }

    /** Системный Context без системного сервера: ActivityThread создаётся отражением и объявляется системным потоком. */
    private fun systemContext(): Context {
        val atc = Class.forName("android.app.ActivityThread")
        val ctor = atc.getDeclaredConstructor().apply { isAccessible = true }
        val at = ctor.newInstance()
        atc.getDeclaredField("sCurrentActivityThread").apply { isAccessible = true }.set(null, at)
        atc.getDeclaredField("mSystemThread").apply { isAccessible = true }.setBoolean(at, true)
        return atc.getMethod("getSystemContext").invoke(at) as Context
    }
}
