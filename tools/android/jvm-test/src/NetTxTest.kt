package app.dsp.phone.nettxtest

import app.dsp.phone.SerialTx
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** SerialTx (NetHub.kt): задачи одного соединения идут строго по порядку, даже при сотнях подряд и после простоя потока. */

private var fails = 0
private fun ok(name: String, cond: Boolean) { if (!cond) { fails++; println("FAIL $name") } else println("ok $name") }

fun main() {
    val tx = SerialTx()
    val seen = java.util.Collections.synchronizedList(ArrayList<Int>())
    val n = 2000
    val done = CountDownLatch(n)
    for (i in 0 until n) tx.execute(Runnable { if (i % 97 == 0) Thread.sleep(1); seen.add(i); done.countDown() })
    ok("all tasks ran", done.await(10, TimeUnit.SECONDS))
    ok("in submission order", seen == (0 until n).toList())

    Thread.sleep(6500)                                            // поток простоя ушёл — новая задача поднимает его снова
    val again = CountDownLatch(1)
    tx.execute(Runnable { again.countDown() })
    ok("worker restarts after idle", again.await(5, TimeUnit.SECONDS))

    val a = SerialTx(); val b = SerialTx()
    val order = java.util.Collections.synchronizedList(ArrayList<String>())
    val gate = CountDownLatch(1); val both = CountDownLatch(2)
    a.execute(Runnable { gate.await(5, TimeUnit.SECONDS); order.add("a"); both.countDown() })
    b.execute(Runnable { order.add("b"); gate.countDown(); both.countDown() })
    ok("connections do not block each other", both.await(10, TimeUnit.SECONDS) && order == listOf("b", "a"))
    if (fails > 0) { println("FAILED $fails"); System.exit(1) }
    println("all ok")
}
