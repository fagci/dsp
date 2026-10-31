package app.dsp.phone

/** Чистая логика положения в записях сканов и диагностики «сканы стали редкими» (без Android — проверяется на JVM). */
object PosArgs {
    /** Фикс не старше этого — положение берётся в запись (раньше 30 с). */
    const val MAX_AGE_MS = 120_000L
    /** Фикс моложе считается свежим: acc не меняется, fixAge не пишется. */
    const val FRESH_MS = 5_000L

    /** Точность с поправкой на возраст фикса: старше FRESH_MS — прибавляется возможный уход (возраст × max(скорость, 1 м/с)). */
    fun accWithAge(acc: Double, ageMs: Long, speed: Double): Double =
        if (ageMs <= FRESH_MS) acc else acc + ageMs / 1000.0 * maxOf(speed, 1.0)
}

/** Почему сканы редкие: решение «пора предупредить» и подсказки по состоянию телефона. */
object ScanDiag {
    /** Wi-Fi: свежего скана нет дольше max(90 с, 6 периодов запроса); lastMs — когда пришёл последний или включили скан (0 — ещё не включали). */
    fun wifiStale(nowMs: Long, lastMs: Long, everySec: Int): Boolean = lastMs > 0 && nowMs - lastMs > maxOf(90_000L, everySec * 6_000L)

    /** GPS: фикса нет дольше 90 с (при включённой геолокации и запрошенном положении). */
    fun gpsStale(ageMs: Long): Boolean = ageMs > 90_000L

    /** Состояние телефона: экран, глубокий сон (Doze), исключение из оптимизации батареи, геолокация «всегда» (null — до Android 10 такого нет), экономия, троттлинг скана Wi-Fi (null — неизвестно). */
    class State(val screenOn: Boolean, val idle: Boolean, val optExempt: Boolean, val bgLocation: Boolean?, val saver: Boolean, val throttle: Boolean?)

    /** Что из этого могло замедлить сканы; what — «wifi» / «gps» / «ble». */
    fun hints(s: State, what: String): List<String> {
        val h = ArrayList<String>()
        if (s.bgLocation == false) h.add("Location is not «Allow all the time» for DSP (Settings → Apps → DSP → Permissions → Location): with the screen off Android gives the position to the app much more rarely")
        if (!s.optExempt) h.add("battery optimization is on for DSP (Settings of the app → «Battery optimization» button): the system may freeze the app on a locked screen")
        if (s.idle) h.add("the phone is in Doze (deep idle): the system stops scans and the GPS for apps")
        if (s.saver) h.add("battery saver is on: many phones turn the location off with the screen")
        if (what == "wifi" && s.throttle == true) h.add("«Wi-Fi scan throttling» is on: Android allows an app 4 scans in 2 minutes and 1 in 30 minutes in the background (Developer options → turn it off, or with root: settings put global wifi_scan_throttle_enabled 0)")
        if (what == "ble" && !s.screenOn) h.add("Android 8.1+ gives no results to a BLE scan without a filter while the screen is off: set a filter (name, address, service or manufacturer) in the node")
        if (h.isEmpty()) h.add(if (s.screenOn) "no obvious reason on the phone side — check the page (is the graph running?) and the radio" else "the screen is off: the vendor's power management (Xiaomi / Huawei / Samsung «background activity» limits) may be stopping the app")
        return h
    }
}
