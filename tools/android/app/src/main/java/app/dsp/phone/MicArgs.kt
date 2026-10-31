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
    fun deviceTypes(name: String?): List<Int> = when ((name ?: "").trim().lowercase()) {
        "usb" -> listOf(11, 22)            // TYPE_USB_DEVICE, TYPE_USB_HEADSET
        "wired" -> listOf(3, 4)            // TYPE_WIRED_HEADSET, TYPE_WIRED_HEADPHONES
        "bluetooth", "bt" -> listOf(7, 26) // TYPE_BLUETOOTH_SCO, TYPE_BLE_HEADSET
        "builtin", "internal" -> listOf(15)// TYPE_BUILTIN_MIC
        else -> emptyList()
    }

    /** Размер порции — 20 мс. */
    fun chunk(rate: Int): Int = rate / 50
}
