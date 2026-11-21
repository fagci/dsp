# AGENTS.md — как работать с DSP workbench

Браузерная DSP-лаборатория: граф модулей на канвасе, всё на клиенте, офлайн-PWA. Ванильный JS,
**без сборки и npm**: файлы подключаются `<script>` в порядке массива `L` (`index.html`), поэтому
проект — глобальные `const/function` из сотен файлов, а не импорты. `CLAUDE.md` — доп. заметки
(git/PR, офлайн, поля узла); при расхождении истина в коде.

## Старт и размеры

1. `git status --short` — не затереть чужую работу.
2. `docs/PROJECT_MAP.md` (архитектура), `docs/HANDOFF.md` (что делали); карта может отставать — проверяй `rg`.
3. `modules/` ~470 файлов (~215 `*-kernels.js`); `presets.js` ~11 800 строк, `core-graph.js` ~3 700,
   `sw.js` ~680. `vendor/` ~49 МБ, `data/` ~8,5 МБ — не сканировать.
4. Большие файлы: `wc -l` → `rg -n` по символу → `Read` ±40 строк; шире — только если структура непонятна.

## Карта

| Нужно | Где | Искать |
|---|---|---|
| Узел/модуль | `modules/*.js` | `id:'имя'`, `title:'…'`, `cat:'…'`, `kw` |
| Логика, парсеры, кодеры | `modules/*-kernels.js` | имя функции/протокола (там же тесты) |
| Движок, регистрация | `core-engine.js` | `def` (~730), `MOD`, `portsOf`, топосортировка |
| Канвас, палитра, undo, хоткеи | `core-graph.js` | `addNode`, `addEdge`, `Undo`, `cmdk*`, `keydown` |
| DSP/хелперы | `core-dsp.js` | `bytesHex`, `bytesFromBits`, `bitsMsb`, FFT, фильтры |
| Воркеры | `*-worker.js` | `importScripts(...)` — ядра, доступные в воркере |
| Пресеты/патчи | `presets.js` | `preset('Имя'`, `PRESETS`, `openPatch`, `getPatch` |
| Справка | `help/*.md`, `README.md` | `help/README.md` — оглавление; `help/modules.md` — сгенерирован |
| Загрузка/кэш | `index.html`, `sw.js` | массив `L` (`index.html:56`), `SHELL` (`sw.js:19`) |
| Тесты | `tools/test-*.mjs` | имя протокола; ядра грузятся через `vm` |
| Генераторы | `tools/gen-*.mjs`, `tools/stamp.mjs`, `tools/*/build.sh` | по имени артефакта |
| Офлайн-данные | `modules/filestore.js`, `data/`, `vendor/` | `OfflineData.*` |

Модуль: `def({id, title, cat, kw, ins, outs, params, init(n){}, process(n,I){...}, draw(n){}})`
(DOM — только в `modules/*.js`, логика — в `*-kernels.js`). `process` берёт узел `n`, входы `I`,
возвращает пины. Состояние — в своих полях (`n.buf`, `n.sx`, …), **не** в
`n.x/n.y/id/type/p/size/el/ports/out/b/lod` и не в `n.cv`.
Категории `cat` для сужения: `Sources`, `Protocols`, `Decoders`, `Indicators`, `Analysis`, `Output`,
`IQ`, `Music`, `Processing`, `Data`, `Tools`, `Control`, `Geo`, `Radio`, `Video`, `Audio`, `Modulation`.

## Поиск

`rg` с `path`/`include`, по корню не искать; исключай `vendor/`, `data/`, `.git/`. `presets.js` —
одна строка на 1–2 КБ: сначала `-l`/`-c`/`-m`/`--max-columns 200`, не `rg -n` по частым словам.

```sh
rg -n "id:'fsk4'" modules                          # модуль; рядом *-kernels.js
rg -n "^(function|const|let|var|class) dmrDataDone\b" modules   # определение; без якоря — использования
rg -n "preset\('.*DMR|addNode\('dmr'" presets.js    # пресет и место модуля в графе
rg -n "dmr" tools/test-*.mjs help/*.md README.md    # тест, справка
rg -o "modules/x\.js" index.html                    # подключён? (L — одна длинная строка)
rg -n "modules/x\.js" iq-worker.js                  # доступно в воркере (importScripts)
```

Маршрут «найти фичу»: `id` → модуль → `process` → функции ядра → тест-векторы → пресет/справка.

## Как менять

- Логика — в `*-kernels.js` (без DOM, гоняют тесты); UI — в `modules/*.js`.
- Новый файл — **в оба** списка: `L` (`index.html`) и `SHELL` (`sw.js`). В `L` порядок важен:
  `*-kernels.js` раньше своего модуля; `usb-bridge.js` раньше `webusb-serial.js`; `presets.js`,
  `modules/help.js`, `help-kernels.js` раньше `core-graph.js`.
- Декодер/кодер зеркальны (`…Parse`/`…Build`), с round-trip тестом и пресетом-«Loopback».
- Встроенный пресет — код `preset(имя, fn)` с `addNode`/`addEdge`; копий в `localStorage` нет,
  использование модуля — `addNode('<id>'` в `presets.js`. Builder сам вызывает `clearAll()` и заканчивает
  `markWiresDirty()`: первое открытие `openPatch` строит его прямо в живом графе, без `serialize`/`deserialize` —
  не рассчитывай на пост-обработку `deserialize` (migrate/размеры).
- Новая фича = код + тест + пресет + запись в `README.md`/`help/`. Внешние данные — офлайн (см. `CLAUDE.md`,
  «Офлайн»), без CDN; зависимости не добавлять, тесты — Node без пакетов.
- После правок `index.html`, `styles.css`, `sw.js`, `help/*.md`, `core-*.js`, `modules/*`,
  `presets.js` — `node tools/stamp.mjs` (версия и хэши для SW).

## Проверка

```sh
node --check modules/x.js
node tools/check-globals.mjs modules/x-kernels.js modules/x.js   # новый файл: коллизии имён (иначе SyntaxError)
node tools/test-<протокол>.mjs                                  # профильный тест
timeout 120 node tools/test-kernels.mjs                          # снимок ядер — один раз в конце
node tools/stamp.mjs && git diff --stat                          # полный diff — только по мелким файлам
```

- `check-globals.mjs` — только для новых файлов: на пачке старых он даёт сотни ложных коллизий.
- Нет Playwright — пресеты гоняй через `tools/lab-chrome.mjs` (CDP: `serve` + `openApp` + `openPatch`),
  не через `vm` с DOM-заглушками; разовый скрипт — в `/tmp/kilo/`. После `clearAll` проверяй, что осталось
  `Graph.nodes`/DOM/`HiDPICanvases.size` = 0 и нет живых таймеров/сокетов.
- Упавший тест сначала сверь с `HEAD` (`git show HEAD:<файл>`): в репо есть устаревшие тесты и заглушки.
- Node 22+ (в контейнере бывает 20 — часть тестов не запустится; `node -v`).
- Ядра грузятся в `vm` из списка `iq-worker.js`; разовый скрипт — в `/tmp/kilo/`, та же загрузка.
- Браузер: сначала `node -p "require.resolve('playwright')"`. Есть — статику `python3 -m http.server`,
  дождись `window.crossOriginIsolated === true`; `MOD` — глобальная `const`, не `window.MOD`.
- WebUSB: grant привязан к origin — не меняй порт 8124 без `--grant`. После правок `presets.js`/`modules/*`
  снимай старый SW и чисти `caches`, иначе `openApp` отдаёт старый код (`bandscan` вместо `chanscan`).
- Lab-скрипт закрывает CDP и убивает Chrome в `finally`; при внешнем `timeout` проверь
  `~/.cache/dsp-lab/chrome/SingletonLock` и процессы — lock удаляй только если Chrome мёртв.

## Экономия вывода

- `rg` — сначала `-l`/`-c`, `-m`, `--max-columns 200`; `find` — только по проекту с `-maxdepth`;
  `ps` — без `args` (`ps -o pid=,stat=,comm= -C chrome`).
- Не читать `git diff` по `index.html`/`sw.js` (`const H={...}` — строка на десятки КБ): `--stat`/`--numstat`,
  содержимое — `node tools/stamp.mjs` и точечный `rg`.
- Live-сканы (SDR/GSM): не печатай каждый тик/канал; полные записи — в `/tmp/kilo/*.jsonl`, в конце один
  `UNIQUE`/итог; `background_process` — `lines` 20–50, разбор через `rg 'UNIQUE|CELL|error'`.
- Тяжёлые тесты — `timeout 120`, вывод в `/tmp/kilo/*.log` + `tail -3`. Свои скрипты — в `/tmp/kilo/`,
  печатай сводку (`length`, `Object.keys`, 3 строки, `UNIQUE`), не полный JSON/CSV/лог.
- `Read` — диапазоном после `wc -l`/`rg -n`; не дампить `/proc/*/status`. `tree`/`lsusb -t`/`xwininfo`
  — только при отладке X11/USB (для одного окна `xprop -id`).
- Ревью небольших инструментов — `quick`: три суб-агента на 300 строк дороже самого кода.

## Не повторять / не трогать

- `index.html` (`const L=[...]`) и `sw.js` (`const H={...}`) — однострочные гиганты: никаких `rg -n`/`cat`/
  `git diff`, только узкий `-o` или `node -e` (`rg -o 'modules/ledger[^"]*' index.html`).
- `node --check` — только `.js`; версия/хэши — `node tools/stamp.mjs --check`, наличие в загрузке — `rg -o`.
- Пресеты не проверяй `vm` с DOM-заглушками (`ST_EXAMPLES` и десятки глобал): есть Playwright —
  `node tools/e2e-presets.mjs "Finance:"`, нет — `node --check presets.js` + тест ядра.
- Smoke нового узла без браузера: ядро + модуль в `vm` с заглушками `def`/`defGroups`, `init`/`process`
  на 2–3 записях — DOM не нужен. Полный `test-kernels.mjs` — раз в конце, в цикле — профильный.
- Сначала ищи готовое (`PROJECT_MAP`/`HANDOFF`, Table templates, `recEnt`, calc-поля, `recCsv`,
  `rowplayer`); не пиши второй CSV-импортёр, если хватает Table + маппинга.
- Table: не ищи общие `type`/`format`/`fmt`/`date`/`money` (цепляют `hex-proto`, `timecode`, `tblchart`);
  точки входа — `TC_TYPES` (`table-cards.js`, начало), `tblType`/`tcText`/`tcFormField`/`tcValue`,
  `tblCell`/`TBL_FMTS` (`table.js` ~1538–1610), панель полей ~1920–2040; тесты `tools/test-table*.mjs`.
- `help/*.md` — строка на несколько КБ: не `cat`; для правки вытащи фрагмент `rg -o` и вставь в `edit`.
  `help/modules.md` генерируется (`gen-modref.mjs`, нужен Playwright).
- `V` в `index.html` и `H` в `sw.js` — только `tools/stamp.mjs`; `vendor/`, `.git/`, `data/`, `*.min.js`
  не читать целиком; `presets.js`/`core-graph.js`/`modules/*` — только по символу и диапазону.
- `docs/PROJECT_MAP.md` обновляй при структурных изменениях (новые файлы, переезды, переименования).

## Грабли

- Дублирующийся `id` модуля молча перезаписывается (`def` warning) — проверяй `rg -c "id:'..." modules`.
- `Undo.push()` — no-op при `Undo.busy=true`; превью цепочек создаёт реальные узлы, ставь `_frozen`.
- Точное совпадение `id` модуля должно бить начало слова названия в `modScoreW` — не ломай ранжирование.
- `n.out` перезаписывается результатом `process` после каждого такта, `n.b` сбрасывается при смене block
  size, `n.cv` подменяется движком у узлов с `view`, `n.size` ломает раскладку и сохранение (`w/h` → null).
  `makeNode` проверяет `n.out`/`n.size` только в `init` — ищи записи `rg -n "n\.(out|size|b|cv)\s*=" modules`.
- Свои канвы создавай через `hiDPICanvas(cv,cx,n)` — движок удалит их из `HiDPICanvases` вместе с узлом
  (`n._cvs`); большие буферы (IQ/аудио/история) выделяй при Connect/старте и освобождай в `dispose`.
- rAF/`setInterval`/WebSocket в модуле останавливай в `dispose`; после `clearAll` не должно оставаться
  живых таймеров и отсоединённых канвасов.
- Корреляции/matched filter не считай O(N·M) на каждом блоке: FFT или символьная частота. Бюджет блока —
  `BLOCK/Eng.sr` (512 @ 48 кГц ≈ 10,7 мс).
- Тяжёлая загрузка — сотни файлов последовательно; не добавляй лишних синхронных зависимостей.

## Git

Без явной просьбы не коммить, не пушить, не создавать PR: изменения остаются в рабочем дереве.
Правило `CLAUDE.md` «после пуша всегда PR и сразу merge» — для Claude; в Kilo действует это.
Push бывает транзиентно падает: повторяй с `GIT_SSH_COMMAND="ssh -o IdentitiesOnly=yes -i ~/.ssh/gh_rsa"`.
