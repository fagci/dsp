package app.dsp.phone.fstest

import app.dsp.phone.BridgeServer
import app.dsp.phone.FsArgs

var bad = 0
fun ok(name: String, cond: Boolean) { if (!cond) { bad++; println("FAIL $name") } else println("ok   $name") }

fun main() {
    ok("kind: names", FsArgs.kind("video") == "video" && FsArgs.kind("Music") == "audio" && FsArgs.kind("files") == "files" && FsArgs.kind("") == "images" && FsArgs.kind(null) == "images" && FsArgs.kind("photos") == "images")
    ok("safeSegments: traversal and junk dropped", FsArgs.safeSegments("../a/./b//c") == listOf("a", "b", "c") && FsArgs.safeSegments("\\x\\..\\y") == listOf("x", "y") && FsArgs.safeSegments("") == emptyList<String>() && FsArgs.safeSegments(null) == emptyList<String>())
    ok("safeSegments: bad characters replaced, at most 4 levels", FsArgs.safeSegments("a:b/c*d") == listOf("a_b", "c_d") && FsArgs.safeSegments("1/2/3/4/5/6").size == 4)
    ok("safeSegments: letters of any language kept", FsArgs.safeSegments("Фото 2026/Берлин") == listOf("Фото 2026", "Берлин"))
    ok("relPath: always inside a standard folder", FsArgs.relPath("images", null) == "Pictures/DSP" && FsArgs.relPath("video", "walks/2026") == "Movies/walks/2026" && FsArgs.relPath("audio", "") == "Music/DSP" &&
        FsArgs.relPath("files", "../../etc") == "Download/etc" && FsArgs.relPath("images", "..") == "Pictures/DSP")
    ok("safeName", FsArgs.safeName("a/b\\c:d.jpg") == "a_b_c_d.jpg" && FsArgs.safeName("") == "file" && FsArgs.safeName(null) == "file" && FsArgs.safeName("x".repeat(300)).length == 120)
    ok("window: default and cap", FsArgs.window(0, 0, -1) == (0L to FsArgs.MAX_CHUNK) && FsArgs.window(0, 10_000_000, -1) == (0L to FsArgs.MAX_CHUNK) && FsArgs.window(5, 100, -1) == (5L to 100))
    ok("window: not past the end", FsArgs.window(900, 500, 1000) == (900L to 100) && FsArgs.window(1000, 500, 1000) == (1000L to 0) && FsArgs.window(2000, 500, 1000) == (2000L to 0) && FsArgs.window(-5, 10, 100) == (0L to 10))
    ok("when_: taken date first, else added (s → ms)", FsArgs.when_(1700000000000, 5) == 1700000000000 && FsArgs.when_(0, 100) == 100000L)
    ok("readPerms: Android 13+ separate, before — one", FsArgs.readPerms("images", 34, false) == listOf("android.permission.READ_MEDIA_IMAGES") && FsArgs.readPerms("video", 33, false) == listOf("android.permission.READ_MEDIA_VIDEO") &&
        FsArgs.readPerms("audio", 33, false) == listOf("android.permission.READ_MEDIA_AUDIO") && FsArgs.readPerms("images", 30, false) == listOf("android.permission.READ_EXTERNAL_STORAGE"))
    ok("readPerms: EXIF position asks for ACCESS_MEDIA_LOCATION on Android 10+", FsArgs.readPerms("images", 34, true).contains("android.permission.ACCESS_MEDIA_LOCATION") && !FsArgs.readPerms("images", 28, true).contains("android.permission.ACCESS_MEDIA_LOCATION"))
    ok("dataUri", FsArgs.dataUri("image/jpeg", "AAA") == "data:image/jpeg;base64,AAA")
    ok("file commands need the app page", BridgeServer.powerCmd("media.list") && BridgeServer.powerCmd("fs.read") && BridgeServer.powerCmd("fs.pick"))
    println(if (bad == 0) "all ok" else "$bad FAILED")
    if (bad != 0) System.exit(1)
}
