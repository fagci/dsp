package app.dsp.phone

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.TelecomManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import org.json.JSONObject

/** Чистая проверка кодов и номеров (без Android — проверяется на JVM). */
object DialArgs {
    private val USSD = Regex("[*#0-9+]{2,64}")
    private val NUMBER = Regex("[+0-9*#,;]{1,32}")

    /** Сервисные коды набора, которые стирают данные или открывают инженерные меню: их не отправляем ни как USSD, ни номером. */
    private val SECRET = listOf("*#*#", "#*#*", "*2767*3855#", "*#7780#", "*#9900#", "*#0*#", "*#*#7780#*#*")

    fun secret(s: String): Boolean = SECRET.any { s.contains(it) }

    /** USSD-код: цифры, «*», «#», «+», заканчивается на «#», не служебный. null — отказ. */
    fun ussd(s: String?): String? = s?.trim()?.takeIf { USSD.matches(it) && it.endsWith("#") && it.count { c -> c == '*' || c == '#' } >= 2 && !secret(it) }

    /** Номер для набора: цифры, «+», «*», «#», пауза «,» / «;»; хотя бы одна цифра; не служебный код. null — отказ. */
    fun number(s: String?): String? = s?.trim()?.takeIf { NUMBER.matches(it) && it.any { c -> c.isDigit() } && !secret(it) }

    /** Слот SIM (с нуля) → идентификатор подписки; subs — пары (слот, id). null — такого слота нет. */
    fun subIdOf(slot: Int, subs: List<Pair<Int, Int>>): Int? = subs.firstOrNull { it.first == slot }?.second

    fun failureName(code: Int): String = when (code) { -1 -> "failure"; -2 -> "service unavailable"; else -> "error $code" }
}

/**
 * Звонки и USSD (только страница приложения — это деньги и личное): ussd.sims / ussd.send {code, sim} / call.dial {number, direct} / call.end / call.answer.
 * USSD — TelephonyManager.sendUssdRequest: один запрос — один ответ (меню с продолжением Android через этот API не ведёт: следующий шаг —
 * новый запрос, ответ придёт отдельной записью {src:'ussd'}). Коды, стирающие данные (*2767*3855#…), отклоняются. Не больше 5 запросов в минуту.
 */
class DialHub(private val ctx: Context, private val needs: Needs) {
    private val limiter = Cmd.Limiter(5, 60_000)
    private val main = Handler(Looper.getMainLooper())

    private fun subs(): List<Triple<Int, Int, String>> = try {
        (ctx.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager).activeSubscriptionInfoList
            ?.map { Triple(it.simSlotIndex, it.subscriptionId, (it.displayName ?: it.carrierName ?: "").toString()) } ?: emptyList()
    } catch (e: SecurityException) { emptyList() }

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        try {
            when (cmd) {
                "ussd.sims" -> {
                    if (!needs.need(c, id, cmd, listOf(Manifest.permission.READ_PHONE_STATE))) return
                    val rows = subs().map { Json.obj("src" to "\"sim\"", "slot" to it.first.toString(), "id" to it.second.toString(), "name" to Json.str(it.third)) }
                    if (rows.isNotEmpty()) c.send(Json.rows(rows))
                    Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString()))
                }
                "ussd.send" -> {
                    if (!needs.need(c, id, cmd, listOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE))) return
                    val code = DialArgs.ussd(j.optString("code")) ?: return Reply.done(c, id, cmd, "code: *100# style (digits, *, #), service codes are refused", "args")
                    if (!limiter.allow(System.currentTimeMillis())) return Reply.done(c, id, cmd, "too many requests (5 a minute)", "limit")
                    var tm = ctx.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
                    if (j.has("sim")) {
                        val sid = DialArgs.subIdOf(j.optInt("sim"), subs().map { it.first to it.second }) ?: return Reply.done(c, id, cmd, "no SIM in slot ${j.optInt("sim")} (ussd.sims lists them)", "args")
                        tm = tm.createForSubscriptionId(sid)
                    }
                    tm.sendUssdRequest(code, object : TelephonyManager.UssdResponseCallback() {
                        override fun onReceiveUssdResponse(t: TelephonyManager, request: String, response: CharSequence) {
                            c.send(Json.rows(listOf(Json.obj("src" to "\"ussd\"", "code" to Json.str(request), "ok" to "true", "text" to Json.str(response.toString())))))
                        }
                        override fun onReceiveUssdResponseFailed(t: TelephonyManager, request: String, failureCode: Int) {
                            c.send(Json.rows(listOf(Json.obj("src" to "\"ussd\"", "code" to Json.str(request), "ok" to "false", "failure" to Json.str(DialArgs.failureName(failureCode))))))
                        }
                    }, main)
                    Reply.done(c, id, cmd, null, extra = arrayOf("code" to Json.str(code)))       // ответ сети придёт отдельной записью
                }
                "call.dial" -> {
                    val number = DialArgs.number(j.optString("number")) ?: return Reply.done(c, id, cmd, "number: digits, +, *, # (service codes are refused)", "args")
                    val uri = Uri.parse("tel:" + Uri.encode(number))
                    if (j.optBoolean("direct", false)) {
                        if (!needs.need(c, id, cmd, listOf(Manifest.permission.CALL_PHONE))) return
                        if (!limiter.allow(System.currentTimeMillis())) return Reply.done(c, id, cmd, "too many calls (5 a minute)", "limit")
                        (ctx.getSystemService(Context.TELECOM_SERVICE) as TelecomManager).placeCall(uri, Bundle())
                    } else {
                        try { ctx.startActivity(Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        catch (e: Exception) { return Reply.done(c, id, cmd, "the dialer did not open — open the DSP app and repeat", "state") }
                    }
                    Reply.done(c, id, cmd, null, extra = arrayOf("number" to Json.str(number), "direct" to j.optBoolean("direct", false).toString()))
                }
                "call.end", "call.answer" -> {
                    if (Build.VERSION.SDK_INT < 28) return Reply.done(c, id, cmd, "needs Android 9+", "state")
                    if (!needs.need(c, id, cmd, listOf(Manifest.permission.ANSWER_PHONE_CALLS))) return
                    val tc = ctx.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
                    if (cmd == "call.end") { val ok = tc.endCall(); if (ok) Reply.done(c, id, cmd, null) else Reply.done(c, id, cmd, "no call to end", "state") }
                    else { tc.acceptRingingCall(); Reply.done(c, id, cmd, null) }
                }
                else -> Reply.done(c, id, cmd, "unknown call command", "args")
            }
        } catch (e: SecurityException) { Reply.done(c, id, cmd, "no permission: " + e.message, "permission") }
        catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: "call error", "error") }
    }
}
