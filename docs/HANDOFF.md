# Handoff (2026-11-05)

## Контекст

Сессия: мониторинг расхода заряда и использования приложений в Android-приложении (источники `bstat` / `usage`). **Всё запушено в `main`, рабочее дерево чистое.**

## Что сделано (этой сессией, в main)

- Приложение (`tools/android`): новый хаб `StatsHub.kt` — источник `bstat` (ток/напряжение/µAh/ёмкость каждую секунду через `BatteryManager`, fallback на `/sys/class/power_supply/battery` через root) и `usage` (топ-10 приложений по времени в foreground за день + последнее foreground-приложение через `UsageStatsManager`; мА·ч по приложениям из `dumpsys batterystats` — через DUMP по adb или root; чистый парсер `Batts`). Подключено в `BridgeService` (создание, `refresh()`, `hello` sources, закрытие), `BridgeServer` — новое поле подписки `statEvery`. Манифест: `PACKAGE_USAGE_STATS` + `DUMP`. jvm-тест `StatsTest.kt`, задача `gradle runStatsTest` (в `runTests`).
- Страница: узел Phone sensors (`modules/termux.js`, `modules/termux-kernels.js`) — пины `bstat`/`usage`, выходы `cur volt uah bcap umin` (+`utop` в readout), параметр *poll every*, строки в readout, подсказка про Usage access. Тесты в `tools/test-termux.mjs`.
- Доки: `tools/android/README.md` (протокол + раздел Power), `help/sources.md`.

## Проверено

- `node --check` тронутых JS; термиксовая логика — ad-hoc прогоном (8/8 ок); логика `Batts` — транслитерацией на JS (ок). `node tools/stamp.mjs` выполнен.
- `node tools/test-termux.mjs` зелёный до WebSocket-части — в окружении Node 20, а нужен Node 22+ (`WebSocket`); добавленные мной кейсы лежат за этой точкой и локально не выполнялись (проверены ad-hoc).

## Не проверено

- **Kotlin не компилировался** — в контейнере нет JDK/Gradle. Прогнать `gradle -p tools/android/jvm-test runStatsTest` и `gradle -p tools/android :app:assembleDebug` на машине с JDK 17 + SDK.
- На живом телефоне не щупалось: знак/наличие `current_now`, экран Usage access, `dumpsys` под DUMP/root.

## Осталось / идеи (не начато)

- Preset «расход батареи»: Tank из `bcap`, график `cur` (Scope), Table по `drain`.
- Команда `usage.grant` для открытия экрана Usage access из патча (сейчас — только подсказка в warn).
- Возможное: собственная атрибуция мА·ч (UsageStats-события × ток), если DUMP/root нет.

## С чего начать продолжение

1. `docs/PROJECT_MAP.md` → разделы «Связи»/«Ключевые каталоги» (android упомянут обобщённо, файлы не перечислены).
2. Хаб: `tools/android/app/src/main/java/app/dsp/phone/StatsHub.kt`; подписка: `BridgeServer.kt` (`statEvery` рядом с `cellEvery`).
3. Узел: `modules/termux.js` (пины/параметры/readout), `modules/termux-kernels.js` (`TERMUX_SUBS`, `termuxApply`, `termuxLine`, `termuxSubMsg`).
4. После правок — `node tools/stamp.mjs` и тесты (см. AGENTS.md).
