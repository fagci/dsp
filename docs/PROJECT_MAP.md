# Карта проекта: DSP workbench

Браузерная DSP-лаборатория: граф из модулей на канвасе, всё считается на клиенте (AudioWorklet), офлайн-PWA. Деплой — GitHub Pages с `main`.

## Стек и архитектура

- Ванильный JS, **классические скрипты без бандлера** (порядок загрузки — массив `L` в `index.html`). Топ-уровневые `const/function` — общие глобальные между файлами.
- `*-kernels.js` — чистая логика (без DOM), общие функции поиска/протоколов; тестируются в Node через `vm`.
- Движок: `core-engine.js` (реестр `MOD`, вычисление графа), аудио — AudioWorklet + SharedArrayBuffer (при cross-origin isolated через sw.js).
- Пайплайн данных по графу: `def({ins,outs,params,init,process,draw})` в `modules/*.js`; `ins` может быть функцией от узла (динамические пины).

## Ключевые каталоги

- `index.html` — разметка + встроенный загрузчик (прогресс, откат версии через SW); массив `L` — ручной список скриптов.
- `core-graph.js` — UI канваса: узлы, провода, палитра, undo, хоткеи, **командная палитра/цепочки (cmdk\*)**.
- `modules/` — ~250 модулей (декодеры, SDR, телефон, сеть, медиа). `webusb-serial.js` — WebSerial поверх WebUSB (Android).
- `help/*.md` — **единый мануал**: GitHub + приложение (кнопка ?) + офлайн-кэш SW. Оглавление — `help/README.md`.
- `presets.js` — список патчей, `openPatch/insertPatch/buildDemo`, реестр пресетов `preset()`.
- `tools/` — `test-*.mjs` (тесты), `node/bridge.mjs` (TCP/прокси/TLS-мост), `android/` (приложение), `termux/`, прошивки.
- `vendor/` — wasm и библиотеки, ленивая загрузка (не трогать при сканировании).
- `sw.js` — service worker; `SHELL` — ручной список кэша; `H` — хэши (генерирует stamp.mjs).
- `styles.css` — вся стилизация (тёмная/светлая темы через CSS-переменные).

## Точки входа

- Страница: `index.html` → загрузчик `L` → `core-graph.js` инициализирует граф (конец файла: восстановление патча/демо, онбординг).
- Модули регистрируются через глобальный `def({...})` при загрузке своего файла.

## Основные символы (задача → путь → символы)

| Задача | Путь | Символы |
|---|---|---|
| Граф/узлы/провода | `core-graph.js` | `addNode/addNodeUI/delNode/addEdge/delEdge/connect` (автоадаптер iq↔sig `IQ_ADAPT`), `posNode`, `Sel/syncSel/delSel`, `Undo` (уважает `Undo.busy`) |
| Палитра модулей, поиск | `core-graph.js` | `modInfo/modScoreW/modRank/queryWords` (fuzzy), палитра `pal*` |
| Командная палитра, Emmet-цепочки | `core-graph.js` | `cmdkOpen/cmdkRender/cmdkPreview/cmdkChainDone/chainPins`; превью — реальные узлы под `Undo.busy` + `_frozen` + класс `cmdk-ghost`; `>` в запросе — цепочка, `>a>b` — от выделенного |
| Хоткеи | `core-graph.js` | `keydown`: Space (run/stop), Ctrl+S/A/K, стрелки (nudge), `+/-` зум, `?` шорткаты, `/` палитра, Delete, Ctrl+Z/Y |
| Fuzzy-поиск | `modules/help-kernels.js` | `fzDist` (Дамерау-Левенштейн), `fzWord` (1–2 правки), `fzAbbr` (PHone SEnsors), `fzScoreWords`, `fzTokens` |
| Справка в приложении | `modules/help.js` + `help-kernels.js` | `hpOpen/hpGo/hpLoad`; `hpLoad` собирает «абзацы модулей» (`hlpBullets`) со всех страниц `help/` — карточки модулей и поиск |
| Serial | `modules/sources.js` (`def id:'webserial'`), `modules/webusb-serial.js` | вход `text` шлёт по изменению; shim ставится, где нет `navigator.serial` (Android: Chrome WebUSB и приложение через `usb-bridge.js`) |
| Command Templates (команды с параметрами) | `modules/flow.js` (`def id:'cmds'`), логика `modules/flow-kernels.js` | `cmdTpls/cmdFields/cmdNames/cmdFmtVal/cmdFill`; шаблон `TUNE {f}` → пин `f`, кнопка ▶ + вход `gN`, выходы `text/go/rec` |
| Патчи/пресеты | `presets.js` | `readP/writeP/openPatch/insertPatch/buildPatchList/stashIfDirty`; `preset(name, fn)` |
| Версионирование | `tools/stamp.mjs` | пересчитывает `V`/`CACHE`/`H`; `--check` для CI |

## Связи

- `help-kernels.js` грузится раньше `core-graph.js` (fuzzy используется в обоих); `presets.js` раньше `core-graph.js`; `usb-bridge.js` раньше `webusb-serial.js`.
- Канвас-пан/зум — `vendor/panzoom.min.js` (`panzoom.zoomIn/zoomOut`); перетаскивание — `vendor/interact.min.js`.
- Модули телефона общаются с Android-приложением через мост (`phonelink-kernels.js`, `phoneact-kernels.js`, адреса `@имя` из Settings → Devices, `modules/gateways.js`).

## Команды

- Тесты: `node tools/test-help.mjs`, `tools/test-flow.mjs` и др. `tools/test-*.mjs` (некоторым нужны pip-пакеты: `pyftpdlib`, `tftpy`, `aiosmtpd`, `async-upnp-client`).
- Версия после правок: `node tools/stamp.mjs`.
- Справка модулей: `node tools/gen-modref.mjs` (**нужен playwright — не установлен**, на проверено).
- Сборки нет; деплой — push в `main` (GitHub Pages).

## Ограничения и подводные камни

- `Undo.push()` — no-op при `Undo.busy=true`: оборачивайте «черновые» мутации графа (превью, staging), иначе история и автосохранение засорятся.
- Превью цепочек создаёт реальные узлы: ставьте `_frozen` (движок пропускает — не дёргает микрофон/USB) и снимайте фриз на финализации. Узлы превью помечаются классом `cmdk-ghost` (полупрозрачность до Enter).
- Точное совпадение id модуля должно бить начало слова названия — в `modScoreW` есть бонус `(x.idl===w ? 1 : 0)`; при правке ранжирования не ломать (chain берёт топ-1).
- Загрузка тяжёлая: ~380 файлов/8,6 МБ JS последовательно (прогресс-бар есть; минификация/чанкинг — несделанная задача).
- `navigator.getBattery`, WebSerial/WebHID и др. — не везде; hostcaps скрывает модули без API (`hostcapsHidden`), проверять доступность.
- В этой среде push на GitHub периодически падает (`Permission denied`/`Internal Server Error`, транзиент): повторять с `GIT_SSH_COMMAND="ssh -o IdentitiesOnly=yes -i ~/.ssh/gh_rsa"` до успеха.
- Не проверено на реальном железе: Serial через Android-приложение (по коду работает через usb-bridge), большинство phone-модулей (помечено в README «not tried on real hardware»).
