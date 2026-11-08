package app.dsp.phone

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Пины наружу (узлы Pins Out / Pins In / Pins (custom) страницы DSP, modules/pins.js): ретранслятор кадров по имени пина.
 * То же, что tools/pin-bridge.mjs, на сокетах приложения — страницы на этом и других телефонах видят пины друг друга, внешние клиенты
 * (websocat, GNU Radio, скрипт) читают их и подают на входы. Кадры не разбираются: смотрим только имя пина в заголовке
 * (формат — modules/pins-kernels.js: [kind u8][длина имени u8][0 0][fc f64][sr f64][seq u32][имя, добор до кратного 4][данные]).
 *
 * Сообщения JSON с ключом "t" (датчики — "sub": […], команды — "cmd"; здесь они не пересекаются):
 *   {"t":"hello","role":"graph"}        страница с узлами Pins; ей шлют {"t":"want","names":[…]} — что просят остальные
 *   {"t":"sub","names":["a","*"]}       подписка (клиента или Pins In страницы)
 *   {"t":"pins","out":[…],"in":[…]}     страница объявляет свои имена; остальным уходит список {"t":"pins",…}
 *   {"t":"make","name":"x","dir":"pub"|"sub"}   клиент просит создать пин в узле Pins (custom)
 *   {"t":"set","name":"tune","v":100500000}     клиент подаёт значение на вход страницы
 * Двоичные кадры: от страницы — подписанным, от клиента — всем страницам (на их входы). /raw/ИМЯ — только данные пина, без заголовка.
 */
class PinRelay {
    class Peer(val text: (String) -> Unit, val bin: (ByteArray) -> Unit) {
        @Volatile var graph = false
        @Volatile var subs: Set<String> = emptySet()
        @Volatile var out: JSONArray = JSONArray()
        @Volatile var inn: JSONArray = JSONArray()
        /** Имя пина для /raw/ИМЯ; пусто — обычный клиент. */
        @Volatile var raw = ""
        @Volatile var greeted = false
    }

    private val peers = CopyOnWriteArraySet<Peer>()
    private fun graphs() = peers.filter { it.graph }

    fun add(p: Peer) {
        peers.add(p)
        if (p.raw.isNotEmpty()) { p.subs = setOf(p.raw); wantAll() } else p.text(listMsg(p))
    }

    fun remove(p: Peer) {
        if (!peers.remove(p)) return
        if (p.graph) announce()
        wantAll()                                              // его подписки ушли вместе с ним
    }

    /** Список пинов всех страниц, кроме `skip` (свои она знает). */
    fun list(skip: Peer?): JSONObject {
        val out = JSONArray(); val inn = JSONArray()
        for (g in graphs()) if (g !== skip) {
            for (i in 0 until g.out.length()) out.put(g.out.get(i))
            for (i in 0 until g.inn.length()) inn.put(g.inn.get(i))
        }
        return JSONObject().put("out", out).put("in", inn)
    }
    private fun listMsg(skip: Peer?) = list(skip).put("t", "pins").toString()

    private fun announce() { for (p in peers) if (p.raw.isEmpty()) p.text(listMsg(p)) }

    private fun wantNames(skip: Peer): List<String> {
        val s = LinkedHashSet<String>()
        for (p in peers) if (p !== skip) s.addAll(p.subs)
        return if ("*" in s) listOf("*") else s.toList()
    }
    private fun sendWant(g: Peer) { g.text(JSONObject().put("t", "want").put("names", JSONArray(wantNames(g))).toString()) }
    private fun wantAll() { for (g in graphs()) sendWant(g) }

    private fun take(a: JSONArray?): JSONArray {
        val r = JSONArray()
        if (a != null) for (i in 0 until minOf(a.length(), 256)) r.put(a.get(i))
        return r
    }

    fun text(p: Peer, j: JSONObject) {
        if (!p.greeted) { p.greeted = true; p.text(JSONObject().put("t", "bridge").put("ver", VER).put("impl", "android").toString()) }   // страница видит, что мост не старый
        when (j.optString("t")) {
            "hello" -> if (j.optString("role") == "graph" && p.raw.isEmpty()) {
                p.graph = true; p.out = JSONArray(); p.inn = JSONArray(); p.subs = emptySet()
                sendWant(p); announce()
            }
            "sub" -> {
                val a = j.optJSONArray("names") ?: return
                p.subs = (0 until minOf(a.length(), 256)).map { a.optString(it) }.filter { it.isNotEmpty() }.toSet()
                wantAll()
            }
            "pins" -> if (p.graph) { p.out = take(j.optJSONArray("out")); p.inn = take(j.optJSONArray("in")); announce() }
                      else p.text(listMsg(p))
            "make" -> {
                val name = j.optString("name"); val dir = j.optString("dir")
                if (!p.graph && name.isNotEmpty() && (dir == "pub" || dir == "sub")) {
                    val m = JSONObject().put("t", "make").put("name", name).put("dir", dir).toString()
                    for (g in graphs()) g.text(m)
                }
            }
            "set" -> {
                val name = j.optString("name")
                if (!p.graph && name.isNotEmpty() && p.raw.isEmpty()) { val f = jsonFrame(name, j.opt("v")); for (g in graphs()) g.bin(f) }
            }
        }
    }

    fun binary(p: Peer, f: ByteArray) {
        if (f.size < 24) return
        val nl = f[1].toInt() and 255
        val hl = 24 + ((nl + 3) and 3.inv())
        if (f.size < hl) return
        if (!p.graph) { for (g in graphs()) g.bin(f); return }          // от клиента — на входы страниц
        val name = String(f, 24, nl, Charsets.UTF_8)
        for (k in peers) {
            if (k === p || !(name in k.subs || "*" in k.subs)) continue
            k.bin(if (k.raw.isNotEmpty()) f.copyOfRange(hl, f.size) else f)
        }
    }

    companion object {
        const val MAX_NAME = 64
        /** 2: страницы получают пины друг друга (graph ↔ graph), {t:"make"}, версия в ответе (то же число у tools/pin-bridge.mjs). */
        const val VER = 2

        /** Кадр json (kind 5) с именем и значением — так {"t":"set"} доходит до Pins In страницы. */
        fun jsonFrame(name: String, v: Any?): ByteArray {
            val nb = name.take(MAX_NAME).toByteArray(Charsets.UTF_8)
            val arr = JSONArray().put(v ?: JSONObject.NULL).toString()
            val body = arr.substring(1, arr.length - 1).toByteArray(Charsets.UTF_8)
            val hl = 24 + ((nb.size + 3) and 3.inv())
            val out = ByteArray(hl + body.size)
            out[0] = 5; out[1] = nb.size.toByte()
            System.arraycopy(nb, 0, out, 24, nb.size); System.arraycopy(body, 0, out, hl, body.size)
            return out
        }
    }
}
