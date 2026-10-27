package app.dsp.phone

/**
 * Снятие запрета на скрытые (@hide) API процесса — нужно только для sms.send_raw (ISms.sendRawPdu — внутренний интерфейс
 * телефонии, публичного способа отправить готовый PDU в Android нет). Работает не везде: с Android 9 система проверяет вызовы
 * скрытых методов по спискам (light / dark greylist, blacklist); этот приём снимает только greylist-часть и только пока он
 * действует в данной версии Android — производители иногда закрывают его обновлениями. ServiceManager / ISms — не на нашем
 * greylist-списке исключений, которые мы просим снять, поэтому результат зависит от прошивки: где-то сработает, где-то нет.
 */
object HiddenApi {
    @Volatile private var tried = false
    fun exempt() {
        if (tried) return
        tried = true
        try {
            val vmRuntime = Class.forName("dalvik.system.VMRuntime")
            val get = vmRuntime.getDeclaredMethod("getRuntime"); get.isAccessible = true
            val rt = get.invoke(null)
            val setExemptions = vmRuntime.getDeclaredMethod("setHiddenApiExemptions", Array<String>::class.java)
            setExemptions.isAccessible = true
            setExemptions.invoke(rt, arrayOf("L"))   // "L" — все пакеты, т.е. снять запрет целиком, где это вообще возможно
        } catch (e: Throwable) { /* заблокировано на этой прошивке — следующий вызов упадёт со своим понятным сообщением */ }
    }
}
