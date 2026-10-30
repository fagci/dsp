package app.dsp.phone

import android.content.Context
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.os.SystemClock

/**
 * Фиктивное местоположение для разработчика: тестовые провайдеры LocationManager (gps / network / passive).
 * Работает, только если приложение выбрано в Настройки → Для разработчиков → «Выбрать приложение для фиктивных местоположений»
 * (иначе addTestProvider бросает SecurityException). Другие приложения и наш собственный источник gps при этом видят подставленную точку.
 */
class MockGps(ctx: Context) {
    private val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var provs: List<String> = emptyList()

    val on: Boolean get() = provs.isNotEmpty()
    fun names(): String = provs.joinToString(",")

    @Throws(SecurityException::class)
    fun start(names: List<String>) {
        stop()
        val ok = setOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
        val list = names.filter { it in ok }.ifEmpty { listOf(LocationManager.GPS_PROVIDER) }
        val done = ArrayList<String>()
        try {
            for (p in list) {
                try { lm.removeTestProvider(p) } catch (e: Exception) { /* такого тестового провайдера ещё нет */ }
                @Suppress("DEPRECATION")
                lm.addTestProvider(p, false, false, false, false, true, true, true, Criteria.POWER_LOW, Criteria.ACCURACY_FINE)
                lm.setTestProviderEnabled(p, true)
                done.add(p)
            }
        } catch (e: Exception) {
            for (p in done) { try { lm.removeTestProvider(p) } catch (e2: Exception) { } }
            throw e
        }
        provs = done
    }

    fun set(lat: Double, lon: Double, alt: Double?, speed: Float?, bearing: Float?, acc: Float) {
        check(provs.isNotEmpty()) { "start first" }
        for (p in provs) {
            val l = Location(p)
            l.latitude = lat; l.longitude = lon; l.accuracy = acc
            if (alt != null) l.altitude = alt
            if (speed != null) l.speed = speed
            if (bearing != null) l.bearing = bearing
            l.time = System.currentTimeMillis()
            l.elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
            lm.setTestProviderLocation(p, l)
        }
    }

    fun stop() {
        for (p in provs) {
            try { lm.setTestProviderEnabled(p, false) } catch (e: Exception) { }
            try { lm.removeTestProvider(p) } catch (e: Exception) { }
        }
        provs = emptyList()
    }
}
