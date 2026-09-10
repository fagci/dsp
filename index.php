<?php
// Путь до модулей — просто добавляй .js файл в modules/, index.php подхватит сам.
$modulesDir = __DIR__ . '/modules';
$moduleFiles = glob($modulesDir . '/*.js');
sort($moduleFiles);
?>
<!DOCTYPE html>
<html lang="ru"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' http: https: ws: wss: data: blob: 'unsafe-inline'">
<title>DSP</title>
<link rel="stylesheet" href="styles.css">
    <link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
</head>
<body>
<div id="app">
  <div id="side">
    <h1>DSP</h1>
    <div id="sideTabs">
      <button class="sidetab on" data-tab="modules">Модули</button>
      <button class="sidetab" data-tab="patches">Патчи</button>
    </div>
    <div id="panelModules" class="sidepanel on">
      <div id="paletteTools"><input id="paletteSearch" type="search" placeholder="Найти модуль… (Ctrl+K)" autocomplete="off"><button id="paletteClear" title="Очистить поиск">×</button></div>
      <div id="palette"></div>
    </div>
    <div id="panelPatches" class="sidepanel">
      <div id="patchTools">
        <input id="patchSearch" type="search" placeholder="Найти патч…" autocomplete="off">
        <button id="patchClear" title="Очистить поиск">×</button>
        <button id="psave" title="Сохранить текущий патч">💾</button>
      </div>
      <div id="patchList"></div>
    </div>
  </div>
  <div id="main">
    <div id="bar">
      <button id="menu" title="Меню">☰</button>
      <button id="run" title="Запустить / остановить">▶</button>
      <button id="panel" title="Приборный вид / граф">▤</button>
      <button id="fit" title="Вписать в экран">⤢</button>
      <button id="undo" title="Отменить (Ctrl+Z)" disabled>↶</button>
      <button id="redo" title="Повторить (Ctrl+Shift+Z)" disabled>↷</button>
      <span class="sep"></span>
      <button id="dup" title="Дублировать (D)">⧉ копия</button>
      <button id="save" title="Скачать в файл">⭳ файл</button>
      <button id="load" title="Открыть файл">⭱ открыть</button>
      <button id="clear" title="Очистить холст">✕ очистить</button>
      <span class="sep"></span>
      <select id="turbo" title="Скорость прогона">
        <option value="1">×1</option><option value="2">×2</option><option value="4">×4</option>
        <option value="8">×8</option><option value="16">×16</option><option value="32">×32</option>
      </select>
      <select id="blk" title="Размер блока">
        <option value="128">128</option><option value="256">256</option>
        <option value="512" selected>512</option><option value="1024">1024</option>
        <option value="2048">2048</option>
      </select>
      <select id="sr" title="Частота дискретизации">
        <option value="">по умолчанию</option>
        <option value="8000">8000 Гц</option>
        <option value="11025">11025 Гц</option>
        <option value="16000">16000 Гц</option>
        <option value="22050">22050 Гц</option>
        <option value="44100">44100 Гц</option>
        <option value="48000">48000 Гц</option>
        <option value="96000">96000 Гц</option>
        <option value="192000">192000 Гц</option>
      </select>
      <span class="sp"></span>
      <span id="stat">остановлено</span>
    </div>
    <div id="canvas" class="grab">
      <svg id="wires"></svg>
      <div id="content"></div>
      <div id="hint">Shift+клик — выделить несколько · D дублировать · Ctrl+Z отменить · Del удалить</div>
    </div>
  </div>
</div>
<div id="scrim"></div>
<input type="file" id="fpick" accept=".json" hidden>

<script src="https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4.6.2/dist/panzoom.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/interactjs@1.10.28/dist/interact.min.js"></script>
<script src="core-engine.js"></script>
<?php foreach ($moduleFiles as $file): ?>
<script src="modules/<?= basename($file) ?>"></script>
<?php endforeach; ?>
<script src="presets.js"></script>
<script src="core-graph.js"></script>
</body></html>
