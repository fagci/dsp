package app.dsp.phone

/** Параметры нативного микрофона (чистая логика — проверяется на JVM). Числа — константы MediaRecorder.AudioSource / AudioDeviceInfo. */
object MicArgs {
    /** Имя источника → MediaRecorder.AudioSource; null — «auto» или неизвестное имя. */
    fun source(name: String?): Int? = when ((name ?: "").trim().lowercase()) {
        "unprocessed", "raw" -> 9          // без шумодава, АРУ и эквалайзера — то, что нужно для измерений
        "mic" -> 1
        "camcorder" -> 5                   // «видеозапись»: часто другой микрофон / настройка
        "voice_recognition", "recognition" -> 6
        "voice_comm", "voice_communication" -> 7
        "performance" -> 10                // малая задержка, Android 11+
        "voice_call", "call" -> 4          // оба направления разговора; root
        "downlink" -> 3                    // собеседник; root
        "uplink" -> 2                      // свой голос в разговоре; root
        "submix" -> 8                      // звук, который играет телефон; root
        else -> null
    }

    /** Источники, недоступные обычному приложению (CAPTURE_AUDIO_OUTPUT): только через root. */
    fun rootOnly(name: String?): Boolean = (name ?: "").trim().lowercase() in setOf("voice_call", "call", "downlink", "uplink", "submix")

    fun sourceName(id: Int): String = when (id) {
        9 -> "unprocessed"; 1 -> "mic"; 5 -> "camcorder"; 6 -> "voice_recognition"; 7 -> "voice_comm"; 10 -> "performance"
        4 -> "voice_call"; 3 -> "downlink"; 2 -> "uplink"; 8 -> "submix"; else -> "src$id"
    }

    /** Частота дискретизации: 8000 … 192000 (что поддержит звуковая подсистема, решает AudioRecord — при отказе пробуем ближайшие стандартные). */
    fun rate(hz: Int): Int = if (hz <= 0) 16000 else hz.coerceIn(8000, 192000)

    /** Частоты, которые пробуем по порядку, если запрошенная не открылась: сначала она, потом стандартные не выше и не ниже по убыванию близости. */
    fun fallbackRates(want: Int): List<Int> {
        val std = listOf(192000, 96000, 48000, 44100, 32000, 22050, 16000, 8000)
        return (listOf(want) + std.sortedBy { Math.abs(it - want) }).distinct()
    }

    /** Желаемое устройство: имя → типы AudioDeviceInfo по предпочтению (USB-микрофон / гарнитура, проводная, Bluetooth, встроенный). */
    fun deviceTypes(name: String?): List<Int> = when ((name ?: "").trim().lowercase().substringBefore(':')) {
        "usb" -> listOf(11, 22)            // TYPE_USB_DEVICE, TYPE_USB_HEADSET
        "wired" -> listOf(3, 4)            // TYPE_WIRED_HEADSET, TYPE_WIRED_HEADPHONES
        "bluetooth", "bt" -> listOf(7, 26) // TYPE_BLUETOOTH_SCO, TYPE_BLE_HEADSET
        "builtin", "internal" -> listOf(15)// TYPE_BUILTIN_MIC
        else -> emptyList()
    }

    /** Каналов: stereo / 2 → 2 (оба микрофона одним AudioRecord — отсчёты каналов из одного кадра АЦП, сдвига между ними нет), иначе 1. */
    fun channels(name: String?): Int = when ((name ?: "").trim().lowercase()) { "stereo", "2" -> 2; else -> 1 }

    /** Адрес / имя устройства после двоеточия: «builtin:bottom», «any:back» (any — любой тип). Пусто — не задан. */
    fun deviceAddr(name: String?): String = (name ?: "").substringAfter(':', "").trim()

    /**
     * Какое из устройств ввода брать: devs — (тип, адрес, имя). Тип из deviceTypes — по предпочтению; адрес (если задан) должен совпасть с
     * AudioDeviceInfo.address или быть частью имени без учёта регистра. Только адрес («any:bottom») — любой тип. Индекс или null.
     */
    fun pickDevice(devs: List<Triple<Int, String, String>>, name: String?): Int? {
        val types = deviceTypes(name); val addr = deviceAddr(name).lowercase()
        if (types.isEmpty() && addr.isEmpty()) return null
        fun addrOk(d: Triple<Int, String, String>) = addr.isEmpty() || d.second.lowercase() == addr || d.second.lowercase().contains(addr) || d.third.lowercase().contains(addr)
        if (types.isEmpty()) return devs.indexOfFirst { addrOk(it) }.takeIf { it >= 0 }
        for (t in types) { val i = devs.indexOfFirst { it.first == t && addrOk(it) }; if (i >= 0) return i }
        return null
    }

    /** Размер порции — 20 мс; в режиме низкой задержки — 10 мс (порций вдвое больше, зато каждая уходит на страницу раньше). */
    fun chunk(rate: Int, low: Boolean = false): Int = if (low) rate / 100 else rate / 50

    /** Буфер AudioRecord: запас на 8 порций (устойчиво к задержкам чтения) или, в режиме низкой задержки, на 2 — по размеру близко к минимуму, который просит звуковая подсистема (так открывается быстрый путь без лишней буферизации). */
    fun bufferBytes(min: Int, chunk: Int, low: Boolean): Int = maxOf(min, chunk * 2 * (if (low) 2 else 8))
}
