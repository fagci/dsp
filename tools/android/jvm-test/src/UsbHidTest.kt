package app.dsp.phone.usbhidtest

import app.dsp.phone.Args
import app.dsp.phone.HidDesc
import app.dsp.phone.UsbHidScript
import org.json.JSONObject
import java.io.File

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    // справочник устройств страницы (data/hid-ref.json, tools/hid-ref.mjs): дескрипторы разбираются так же, как в modules/hid-kernels.js
    val ref = JSONObject(File("../../../data/hid-ref.json").readText()).getJSONObject("devices").getJSONArray("rows")
    val by = (0 until ref.length()).associate { ref.getJSONObject(it).getString("name") to ref.getJSONObject(it) }
    fun info(n: String) = HidDesc.info(Args.hex(by.getValue(n).getString("descriptor"))!!)
    ok("combo: report ids, longest report 8 + id byte", info("combo").ids && info("combo").maxLen == 9)
    ok("gamepad: 9 bytes + id", info("gamepad").ids && info("gamepad").maxLen == 10)
    ok("mouse 5 + id, media remote 2 + id", info("mouse").maxLen == 6 && info("remote").maxLen == 3)
    ok("keyboard: output report (LEDs) is shorter than input", info("keyboard").maxLen == 9)
    ok("every catalogue descriptor parses to a non-empty report", by.keys.all { info(it).maxLen > 1 })
    // дескриптор без report id (мышь из HidHub: кнопки, dx, dy, колесо — 4 байта): первый байт не id
    val boot = Args.hex("05010902a1010901a1000509190129031500250195037501810295017505810105010930093109381581257f750895038106c0c0")!!
    ok("no report id: not marked, 4 bytes", !HidDesc.info(boot).ids && HidDesc.info(boot).maxLen == 4)
    ok("junk and empty input do not crash", HidDesc.info(ByteArray(0)).maxLen == 0 && HidDesc.info(byteArrayOf(0xFE.toByte(), 0x7F)).maxLen == 0)

    // скрипты root: только числа и пути приложения, без подстановки из страницы
    val up = UsbHidScript.up("/data/user/0/app.dsp.phone/cache/usbhid-desc.bin", 1, 1, 9)
    ok("up: gadget, function, descriptor file, report length, UDC rebind", "/config/usb_gadget" in up && "functions/hid.dsp" in up && "cat /data/user/0/app.dsp.phone/cache/usbhid-desc.bin" in up && "report_length" in up && "echo 9 >" in up && "> \$G/UDC" in up)
    ok("up: tells a kernel without the HID function apart", "CONFIG_USB_F_HID" in up && "exit 4" in up)
    ok("down: removes the function and rebinds the controller", "rmdir" in UsbHidScript.down() && "hid.dsp" in UsbHidScript.down() && "> \$G/UDC" in UsbHidScript.down())
    ok("parse: node and controller", UsbHidScript.parse("noise\nOK node=/dev/hidg0 udc=a600000.dwc3\n") == ("/dev/hidg0" to "a600000.dwc3"))
    ok("parse: refusal / junk is null; error text is the ERR line", UsbHidScript.parse("ERR no gadget") == null && UsbHidScript.parse("OK node=/etc/passwd udc=x") == null &&
        UsbHidScript.error("x\nERR no USB gadget in configfs\n") == "no USB gadget in configfs" && UsbHidScript.error("boom\n") == "boom")
    fun syntax(script: String) = try { ProcessBuilder("sh", "-n", "-c", script).redirectErrorStream(true).start().let { p -> p.inputStream.readBytes(); p.waitFor() == 0 } } catch (e: Exception) { true }   // нет sh — пропуск
    ok("scripts are valid shell (sh -n)", syntax(up) && syntax(UsbHidScript.down()))
    ok("write: one cat into descriptor 3 (one write = one report)", UsbHidScript.write("/c/r.bin") == "cat /c/r.bin >&3")
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
