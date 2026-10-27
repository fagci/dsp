package app.dsp.phone

import android.app.PendingIntent
import android.telephony.SmsManager

/**
 * Отправка готового TPDU «как по воздуху» — публичного API у Android для этого нет (SmsManager строит PDU сам из текста).
 * Единственный путь — внутренний AIDL-интерфейс телефонии (ISms.sendRawPdu), который Android с версии 9 прячет от приложений
 * (HiddenApi.exempt снимает часть запрета, но не везде — см. её комментарий). Сигнатура метода менялась от версии к версии
 * (callingPackage, attributionTag, абонентский subId на двух-SIM телефонах…), поэтому пробуем КАЖДЫЙ метод с именем
 * sendRawPdu* на интерфейсе и расставляем аргументы по типам, а не по жёстко прописанной сигнатуре одной версии Android.
 */
object RawPdu {
    /** true — нашёлся и не бросил на вызове подходящий метод (это не означает, что сеть приняла SMS — ответ придёт в ACTION_SMS_SENT). */
    fun send(pkg: String, smsc: ByteArray?, pdu: ByteArray, sentIntent: PendingIntent): Boolean {
        HiddenApi.exempt()
        val isms = try {
            val sm = Class.forName("android.os.ServiceManager")
            val getService = sm.getDeclaredMethod("getService", String::class.java).also { it.isAccessible = true }
            val binder = getService.invoke(null, "isms") as? android.os.IBinder ?: return false
            val stub = Class.forName("com.android.internal.telephony.ISms\$Stub")
            val asInterface = stub.getDeclaredMethod("asInterface", android.os.IBinder::class.java).also { it.isAccessible = true }
            asInterface.invoke(null, binder) ?: return false
        } catch (e: Throwable) { return false }

        val subId = try { SmsManager.getDefaultSmsSubscriptionId() } catch (e: Exception) { -1 }
        val methods = isms.javaClass.methods.filter { it.name.startsWith("sendRawPdu") && it.parameterTypes.any { t -> t == ByteArray::class.java } }
        for (m in methods) {
            try {
                var bytes = 0; var pis = 0
                val args = m.parameterTypes.map { t ->
                    when (t) {
                        ByteArray::class.java -> { val v = if (bytes == 0) smsc else pdu; bytes++; v }
                        PendingIntent::class.java -> { val v = if (pis == 0) sentIntent else null; pis++; v }
                        String::class.java -> pkg
                        Int::class.javaPrimitiveType, Integer::class.java -> subId
                        Boolean::class.javaPrimitiveType, java.lang.Boolean::class.java -> false
                        else -> null
                    }
                }
                m.isAccessible = true
                m.invoke(isms, *args.toTypedArray())
                return true
            } catch (e: Exception) { /* эта перегрузка не подошла — пробуем следующую */ }
        }
        return false
    }
}
