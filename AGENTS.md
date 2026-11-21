# AGENTS.md — как работать с DSP workbench

Браузерная DSP-лаборатория: граф модулей на канвасе, всё считается на клиенте, офлайн-PWA.
Ванильный JS, **без сборки и без npm-зависимостей**: файлы подключаются классическими
`<script>` в порядке массива `L` (`index.html`). Поэтому «проект» — это набор глобальных
`const/function` из нескольких сотен файлов, а не импортов.

`CLAUDE.md` — дополнительные заметки для Claude-сессий (git/PR, офлайн-данные, грабли полей
узла). Здесь они не дублируются; при расхождении истина — в коде.

## Первые 60 секунд

1. `git status --short` — не затереть чужую работу.
2. `docs/PROJECT_MAP.md` — архитектура и точки входа; `docs/HANDOFF.md` — что делалось
   в прошлой сессии и с чего продолжать. Карта может отставать: спорное проверяй `rg`.
3. Найди задачу поиском (ниже), прочитай только нужный диапазон строк.
4. После правки — `node --check`, профильный тест, `node tools/stamp.mjs`.

## Размеры (чтобы не читать лишнего)

- `modules/` — ~470 файлов, из них ~215 `*-kernels.js`; `presets.js` ~11 800 строк,
  `core-graph.js` ~3 700, `index.html` ~250, `sw.js` ~680, `tools/test-*.mjs` ~230.
- `vendor/` ~49 МБ, `data/` ~8,5 МБ — **не сканировать** без явной необходимости.
- Большие файлы читай диапазонами (`offset`/`limit`) после поиска по символу.

## Карта: что где искать

| Нужно | Где | Как найти |
|---|---|---|
| Узел/модуль | `modules/*.js` | `id:'имя'`, `title:'…'`, `cat:'…'`, ключевые слова в `kw` |
| Чистая логика, парсеры, кодеры | `modules/*-kernels.js` | имя функции/протокола; там же тестовые функции |
| Регистрация модулей, движок | `core-engine.js` | `def` (строка ~730), `MOD`, `portsOf`, топосортировка |
| Канвас, палитра, undo, хоткеи | `core-graph.js` | `addNode`, `addEdge`, `Undo`, `cmdk*`, `keydown` |
| Общие DSP/хелперы | `core-dsp.js` | `bytesHex`, `bytesFromBits`, `bitsMsb`, FFT, фильтры |
| Воркеры | `*-worker.js` | `importScripts(...)` — список ядер, доступных в воркере |
| Пресеты/патчи | `presets.js` | `preset('Имя'`, `PRESETS`, `openPatch`, `getPatch` |
| Справка | `help/*.md`, `README.md` | `help/README.md` — оглавление; `help/modules.md` — сгенерирован |
| Загрузка и кэш | `index.html`, `sw.js` | массив `L` (`index.html:56`), `SHELL` (`sw.js:19`) |
| Тесты | `tools/test-*.mjs` | имя протокола/модуля; загрузка ядер через `vm` |
| Генераторы/сборки | `tools/gen-*.mjs`, `tools/stamp.mjs`, `tools/*/build.sh` | по имени артефакта |
| Офлайн-данные | `modules/filestore.js`, `data/`, `vendor/` | `OfflineData.*` |

Модуль объявляется так (DOM — только в обычном `modules/*.js`, логика — в `*-kernels.js`):

```js
def({id, title, cat, kw, ins, outs, params, init(n){}, process(n,I){ return {...}; }, draw(n){}})
```

`process` получает узел `n` и входы `I`, возвращает объекты выходных пинов. Состояние — в своих
полях (`n.buf`, `n.sx`, …), **не** в `n.x/n.y/id/type/p/size/el/ports/out/b/lod` и не в `n.cv`.

## Рецепты поиска

В Kilo удобнее инструмент Grep (он на ripgrep) с `path`/`include`. По корню не искать —
исключай тяжёлое:

```sh
rg -n -g '!vendor/**' -g '!data/**' -g '!.git/**' 'id:'"'"'hexStruct'"'"'' .
```

Частые запросы:

```sh
# модуль по id / названию / категории
rg -n "id:'fsk4'" modules
rg -n "title:'Digital Voice|cat:'Decoders'" modules

# определение символа и все использования
rg -n "^(function|const|let|var|class) dmrDataDone\b" modules
rg -n "\bdmrDataDone\s*\(" modules

# параметр или порт узла
rg -n "n:'hexcol'|n:'rec'" modules/hex.js
rg -n "t:'rec'" modules/*.js

# где файл подключён и где ещё используется
rg -n "modules/dmr-kernels.js" index.html sw.js iq-worker.js
rg -n "\bFSK4\.protos\.dmr\b" modules

# пресет, справка, тест
rg -n "preset\('.*DMR" presets.js
rg -n "addNode\('dmr'" presets.js        # где модуль уже стоит в пресетах
rg -n "DMR|SMS" help/radio.md README.md
rg -n "dmr" tools/test-*.mjs
```

Категории модулей (`cat`) для быстрого сужения: `Sources` (108), `Protocols` (65),
`Decoders` (54), `Indicators`, `Analysis`, `Output`, `IQ`, `Music`, `Processing`, `Data`,
`Tools`, `Control`, `Geo`, `Radio`, `Video`, `Audio`, `Modulation`.

Если точного символа нет — ищи по описанию: `rg -n "kw:'[^']*(dmr|sms)" modules`,
`rg -n "title:'…'" modules`, затем `rg -n "…" help/*.md README.md` (в справке часто есть
имя файла/узла). `help/modules.md` — сгенерированный справочник, по нему можно искать,
но править его нельзя.

Проверить, что файл вообще загружается: `rg -o "modules/dmr-kernels\.js" index.html`
(`L` — одна длинная строка, поэтому `-o`) и `rg -n "modules/dmr-kernels\.js" iq-worker.js`
(в воркер попадают только ядра из `importScripts`).

Правило: сначала `rg` по точному символу/строке, потом `Read` нужного диапазона ±40 строк,
и только если структура непонятна — читай файл шире. Перед чтением большого файла полезно
`wc -l`: читать 200 строк вокруг совпадения дешевле, чем 4 000 строк целиком.

## Маршрут «найти фичу за 5 шагов»

1. `rg -n "id:'<id>'" modules` → файл модуля; рядом ищи одноимённый `*-kernels.js`.
2. Найди `def({id:...})`, прочитай `process` — он показывает, какие функции ядра вызываются.
3. `rg -n "<функция>" modules` → определение и соседние хелперы; читай только их.
4. `rg -n "<протокол>|<id>" tools/test-*.mjs` → тест даёт векторы, ожидаемые поля и зеркальный кодер.
5. `rg -n "<id>|<название>" presets.js help/*.md README.md` → рабочий пресет и описание.

Пример (DMR/SMS): `modules/fsk4.js` (`id:'fsk4'`, Digital Voice Decoder) → `modules/dmr-kernels.js`
(`FSK4.protos.dmr`, `dmrDataDone`, `dmrPayload`) → `help/radio.md` (раздел DMR) →
`tools/test-hexdec.mjs` (векторы LC/CSBK/CRC).

## Как менять

- Логика — в `*-kernels.js` (без DOM, её гоняют тесты); оболочка/UI — в `modules/*.js`.
- Новый файл: добавить **в оба** списка — `L` в `index.html` и `SHELL` в `sw.js`. Порядок в `L`
  важен: `*-kernels.js` раньше своего модуля, `usb-bridge.js` раньше `webusb-serial.js`,
  `presets.js` и `modules/help.js` раньше `core-graph.js`, `help-kernels.js` раньше `core-graph.js`.
- Декодер и кодер — зеркальные (`…Parse`/`…Build`), с round-trip тестом и пресетом-«Loopback».
- Встроенный пресет — это код: `preset(имя, fn)` строит граф через `addNode`/`addEdge`; копий
  в `localStorage` нет, ищи использование модуля как `addNode('<id>'` в `presets.js`.
- Новая фича = код + тест + пресет + запись в `README.md`/`help/`; иначе не считается готовой.
- Внешние данные — офлайн (см. `CLAUDE.md`, раздел «Офлайн»); не тянуть с CDN.
- Зависимости не добавлять; тесты — Node без пакетов.

После правки любого файла оболочки (`index.html`, `styles.css`, `sw.js`, `help/*.md`,
`core-*.js`, `modules/*`, `presets.js`) — `node tools/stamp.mjs` (версия и хэши для SW).

## Проверка

```sh
node --check modules/<файл>.js
node tools/test-<протокол>.mjs       # профильный тест
node tools/test-kernels.mjs          # общий снимок ядер
node tools/stamp.mjs                 # после правок
git diff --stat && git diff          # что именно уходит
```

- Нужен Node 22+ (в контейнере бывает 20 — часть тестов тогда не запустится; проверь `node -v`).
- Ядра грузятся в `vm` из списка `iq-worker.js`; для разовой проверки пиши скрипт в
  `/tmp/kilo/` и повторяй ту же загрузку (`importScripts` → массив файлов).
- Браузер: Playwright/Chromium установлены; статику отдавай `python3 -m http.server`,
  дождись `window.crossOriginIsolated === true`; `MOD` — глобальная `const`, а не `window.MOD`.

## Экономия вывода инструментов

Длинный вывод инструмента — главный расход контекста. На практике больше всего съедают
`ps ... args` (километровые командные строки Chrome), `find /` (тысячи `Permission denied`)
и repo-wide `grep` по частым словам вроде `localhost:` / `WebSocket` (строки из `presets.js`
по 1–2 КБ). Правила:

- `ps` — только нужные колонки, без `args`: `ps -o pid=,stat=,comm= -C chrome`; не `ps aux` и не
  `ps -eo ... args`, если не нужна именно командная строка одного процесса.
- `find` — только по проекту и с `-maxdepth`; никогда `find /`. Пакет ищи через `which`,
  `npm root -g`, `node -p "require.resolve('...')"`, а не сканом диска.
- `rg`/grep — сначала `-l` (только файлы) или `-c`, потом точный символ; ставь `--max-count`/`-m`,
  `--max-columns 200`, исключай `presets.js`, `vendor/`, `data/`, `.git/`.
- `Read` — только диапазоном (`offset`/`limit`) после `wc -l` и `rg -n`; не `cat` большой файл
  и не дампить `/proc/*/status` целиком (`rg '^Groups|^Uid|^Gid' /proc/self/status`).
- `xwininfo -root -children`, `tree`, `lsusb -t` — только при отладке X11/USB; для одного окна
  `xprop -id`.
- Свои скрипты — в `/tmp/kilo/`, не в репозиторий; вывод скрипта — сводкой, не дампом.
- Ревью небольших инструментов — `quick`: три суб-агента на 300 строк дороже самого кода.

## Не трогать и не читать целиком

- `vendor/` (wasm/модели), `.git/`, `data/` (крупные данные), `*.min.js`.
- `presets.js`, `core-graph.js`, `modules/*` — только по символу и диапазону строк.
- `help/modules.md` — генерируется (`node tools/gen-modref.mjs`, нужен Playwright).
- `const H={...}` в `sw.js` и `V` в `index.html` — генерирует `tools/stamp.mjs`; руками не править.
- `docs/PROJECT_MAP.md` обновляй при структурных изменениях (новые файлы, переезды, переименования).

## Грабли

- Дублирующийся `id` модуля молча перезаписывается (`def` пишет warning) — проверяй `rg "id:'..."
  modules | wc -l`, если поведение «не то».
- `Undo.push()` — no-op при `Undo.busy=true`; превью цепочек создаёт реальные узлы, ставь `_frozen`.
- Точное совпадение `id` модуля должно бить начало слова названия в `modScoreW` — не ломай
  ранжирование палитры/цепочек.
- Тяжёлая загрузка: сотни файлов последовательно; не добавляй лишних синхронных зависимостей.
- Push в этой среде бывает транзиентно падает; повторяй с
  `GIT_SSH_COMMAND="ssh -o IdentitiesOnly=yes -i ~/.ssh/gh_rsa"`.

## Git

Без явной просьбы пользователя не коммить, не пушить и не создавать PR. Правило из
`CLAUDE.md` «после пуша всегда PR и сразу merge» относится к Claude-сессиям; в Kilo действует
текущее правило: изменения остаются в рабочем дереве, пока их не попросят закоммитить.
