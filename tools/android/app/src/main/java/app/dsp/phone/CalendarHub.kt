package app.dsp.phone

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.provider.CalendarContract
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.TimeZone

/** Чистая логика календаря (без Android — проверяется на JVM). */
object CalArgs {
    const val DAY = 86_400_000L

    /** Окно списка в мс: from по умолчанию «сейчас», to — через 7 суток; не длиннее 366 суток. */
    fun window(from: Long, to: Long, now: Long): Pair<Long, Long> {
        val f = if (from > 0) from else now
        var t = if (to > f) to else f + 7 * DAY
        if (t - f > 366 * DAY) t = f + 366 * DAY
        return f to t
    }

    /** Напоминания в минутах до начала: 0…40320 (4 недели), без повторов, не больше 5. */
    fun reminders(a: List<Int>): List<Int> = a.filter { it in 0..40320 }.distinct().take(5)

    /** «10, 60;1440» → [10, 60, 1440]. */
    fun reminders(s: String?): List<Int> = reminders((s ?: "").split(',', ';', ' ').mapNotNull { it.trim().toIntOrNull() })

    /** Событие на весь день хранится по UTC: [полночь UTC даты начала (в поясе телефона), не меньше суток]. */
    fun allDay(startMs: Long, endMs: Long, zone: ZoneId): Pair<Long, Long> {
        fun utcMidnight(ms: Long) = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val s = utcMidnight(startMs)
        var e = if (endMs > startMs) utcMidnight(endMs - 1) + DAY else s + DAY      // конец включительно: 23:59 ещё тот же день
        if (e <= s) e = s + DAY
        return s to e
    }
}

/**
 * Календарь телефона (CalendarContract): cal.calendars / cal.list {from, to, q, calendar, limit} / cal.add {title, start, end, allDay, where, note,
 * remind:[минуты], calendar} / cal.remove {id}. Напоминание — запись Reminders события: показывает его приложение «Календарь». Только страница
 * приложения (личные данные); разрешения READ_CALENDAR / WRITE_CALENDAR спрашиваются при первой команде.
 */
class CalendarHub(private val ctx: Context, private val needs: Needs) {
    private val read = listOf(Manifest.permission.READ_CALENDAR)
    private val write = listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)

    fun exec(c: BridgeServer.Client, j: JSONObject) {
        val cmd = j.optString("cmd"); val id = j.opt("id")
        if (!c.trusted) return Reply.done(c, id, cmd, "only the page of the DSP app may use it", "forbidden")
        try {
            when (cmd) {
                "cal.calendars" -> {
                    if (!needs.need(c, id, cmd, read)) return
                    val rows = calendars().map { Json.obj("src" to "\"cal\"", "kind" to Json.str("calendar"), "id" to it.id.toString(), "name" to Json.str(it.name), "account" to Json.str(it.account),
                        "writable" to it.writable.toString(), "visible" to it.visible.toString()) }
                    if (rows.isNotEmpty()) c.send(Json.rows(rows))
                    Reply.done(c, id, cmd, null, extra = arrayOf("n" to rows.size.toString()))
                }
                "cal.list" -> {
                    if (!needs.need(c, id, cmd, read)) return
                    val (from, to) = CalArgs.window(j.optLong("from"), j.optLong("to"), System.currentTimeMillis())
                    val lim = Cmd.limit(j.optInt("limit"), 50, 500); val q = j.optString("q").trim().lowercase(); val cal = j.optLong("calendar", -1)
                    val out = ArrayList<String>()
                    val p = arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
                        CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.DESCRIPTION, CalendarContract.Instances.CALENDAR_ID)
                    CalendarContract.Instances.query(ctx.contentResolver, p, from, to)?.use { cur ->
                        while (cur.moveToNext() && out.size < lim) {
                            val title = cur.getString(1) ?: ""; val where = cur.getString(5) ?: ""; val note = cur.getString(6) ?: ""
                            if (cal >= 0 && cur.getLong(7) != cal) continue
                            if (q.isNotEmpty() && !(title + " " + where + " " + note).lowercase().contains(q)) continue
                            out.add(Json.obj("src" to "\"cal\"", "kind" to Json.str("event"), "id" to cur.getLong(0).toString(), "title" to Json.str(title), "start" to cur.getLong(2).toString(), "end" to cur.getLong(3).toString(),
                                "allDay" to (cur.getInt(4) != 0).toString(), "where" to Json.str(where), "note" to Json.str(note.take(500)), "calendar" to cur.getLong(7).toString()))
                        }
                    }
                    if (out.isNotEmpty()) c.send(Json.rows(out))
                    Reply.done(c, id, cmd, null, extra = arrayOf("n" to out.size.toString()))
                }
                "cal.add" -> {
                    if (!needs.need(c, id, cmd, write)) return
                    val title = j.optString("title").trim()
                    val start = j.optLong("start")
                    if (title.isEmpty() || start <= 0) return Reply.done(c, id, cmd, "title and start (ms) are required", "args")
                    val all = j.optBoolean("allDay", false)
                    val (s, e) = if (all) CalArgs.allDay(start, j.optLong("end"), ZoneId.systemDefault()) else start to (if (j.optLong("end") > start) j.optLong("end") else start + 3_600_000L)
                    val cal = if (j.has("calendar")) j.optLong("calendar") else calendars().firstOrNull { it.writable && it.visible }?.id ?: -1L
                    if (cal < 0) return Reply.done(c, id, cmd, "no writable calendar on the phone (add an account in the Calendar app)", "state")
                    val rem = if (j.has("remind")) (j.optJSONArray("remind")?.let { a -> (0 until a.length()).map { a.optInt(it, -1) } } ?: CalArgs.reminders(j.optString("remind"))).let { CalArgs.reminders(it) } else emptyList()
                    val v = ContentValues().apply {
                        put(CalendarContract.Events.CALENDAR_ID, cal); put(CalendarContract.Events.TITLE, title.take(200))
                        put(CalendarContract.Events.DTSTART, s); put(CalendarContract.Events.DTEND, e)
                        put(CalendarContract.Events.EVENT_TIMEZONE, if (all) "UTC" else TimeZone.getDefault().id)
                        put(CalendarContract.Events.ALL_DAY, if (all) 1 else 0)
                        put(CalendarContract.Events.HAS_ALARM, if (rem.isNotEmpty()) 1 else 0)
                        j.optString("where").takeIf { it.isNotEmpty() }?.let { put(CalendarContract.Events.EVENT_LOCATION, it.take(200)) }
                        j.optString("note").takeIf { it.isNotEmpty() }?.let { put(CalendarContract.Events.DESCRIPTION, it.take(2000)) }
                    }
                    val u = ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, v) ?: return Reply.done(c, id, cmd, "the calendar refused the event", "state")
                    val eid = ContentUris.parseId(u)
                    for (m in rem) ctx.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, ContentValues().apply {
                        put(CalendarContract.Reminders.EVENT_ID, eid); put(CalendarContract.Reminders.MINUTES, m); put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
                    })
                    Reply.done(c, id, cmd, null, extra = arrayOf("event" to eid.toString(), "calendar" to cal.toString(), "reminders" to rem.size.toString()))
                }
                "cal.remove" -> {
                    if (!needs.need(c, id, cmd, write)) return
                    val eid = j.optLong("event", j.optLong("id_event", -1))
                    if (eid < 0) return Reply.done(c, id, cmd, "event: the id from cal.list", "args")
                    val n = ctx.contentResolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eid), null, null)
                    if (n == 0) Reply.done(c, id, cmd, "no such event", "state") else Reply.done(c, id, cmd, null)
                }
                else -> Reply.done(c, id, cmd, "unknown calendar command", "args")
            }
        } catch (e: SecurityException) { Reply.done(c, id, cmd, "no calendar permission: " + e.message, "permission") }
        catch (e: Exception) { Reply.done(c, id, cmd, e.message ?: "calendar error", "error") }
    }

    private class Cal(val id: Long, val name: String, val account: String, val writable: Boolean, val visible: Boolean)

    private fun calendars(): List<Cal> {
        val out = ArrayList<Cal>()
        val p = arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.VISIBLE)
        ctx.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, p, null, null, CalendarContract.Calendars.IS_PRIMARY + " DESC")?.use { cur ->
            while (cur.moveToNext()) out.add(Cal(cur.getLong(0), cur.getString(1) ?: "", cur.getString(2) ?: "", cur.getInt(3) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR, cur.getInt(4) != 0))
        }
        return out
    }
}
