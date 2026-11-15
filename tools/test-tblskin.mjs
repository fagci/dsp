// Скины Table: набор переменных, разбор своих значений, защита от лишнего: node tools/test-tblskin.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({String, Array, Object, RegExp, Math});
vm.runInContext(fs.readFileSync(path.join(root, 'modules/tblskin-kernels.js'), 'utf8'), ctx, {filename: 'tblskin-kernels.js'});
vm.runInContext('this.K={TBL_SKINS,TBL_SKIN_VARS,tblSkin,tblSkinValue,tblSkinParse,tblSkinVars,tblAgo}', ctx);
const K = ctx.K;
let bad = 0;
const eq = (n, a, b) => { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) { bad++; console.log('FAIL', n, sa, '!=', sb); } else console.log('ok  ', n); };
eq('skins: every id is unique and the first is the default', [new Set(K.TBL_SKINS.map(s => s.id)).size === K.TBL_SKINS.length, K.TBL_SKINS[0].id], [true, '']);
eq('skins: every skin uses only known variables with safe values', K.TBL_SKINS.every(s => Object.entries(s.vars).every(([k, v]) => k in K.TBL_SKIN_VARS && K.tblSkinValue(v) === v)), true);
eq('skin: unknown id falls back to the default', K.tblSkin('nope').id, '');
eq('value: sizes and colours', ['14px', '0 2px 8px rgba(0,0,0,.28)', '#aabbcc', 'transparent', 'color-mix(in srgb,var(--panel) 90%,#fff)', '8px 10px 10px', 'calc(var(--av) * 2)'].map(K.tblSkinValue), ['14px', '0 2px 8px rgba(0,0,0,.28)', '#aabbcc', 'transparent', 'color-mix(in srgb,var(--panel) 90%,#fff)', '8px 10px 10px', 'calc(var(--av) * 2)']);
eq('value: url, expressions, braces, comments, imports are refused', ['url(http://x/a.png)', 'expression(alert(1))', '1px}body{x:y', '1px /* x */', '1px !important', 'red;color:blue', '</style>', 'javascript:1', '\\31 px', '@import'].map(K.tblSkinValue), Array(10).fill(''));
eq('value: unknown function and unbalanced brackets', [K.tblSkinValue('foo(1)'), K.tblSkinValue('calc(1px'), K.tblSkinValue('1px)')], ['', '', '']);
eq('value: too long / empty', [K.tblSkinValue('1'.repeat(200)), K.tblSkinValue('  '), K.tblSkinValue(null)], ['', '', '']);
eq('parse: known variables only', K.tblSkinParse('--tk-r:14px; --tk-av : 48px ;--evil:1px;color:red;--tk-bg:url(x)'), {'--tk-r': '14px', '--tk-av': '48px'});
eq('parse: case of the name, junk, empty', [K.tblSkinParse('--TK-R:2px'), K.tblSkinParse('nonsense'), K.tblSkinParse('')], [{'--tk-r': '2px'}, {}, {}]);
eq('vars: the custom ones win over the skin', K.tblSkinVars('soft', '--tk-r:2px')['--tk-r'], '2px');
eq('vars: the skin without custom', K.tblSkinVars('dense', '')['--tk-av'], '24px');
// формат ago: «сколько назад» от метки времени (мс или секунды Unix)
{ const N = 1.7e12, A = (d, v) => K.tblAgo(v === undefined ? N - d : v, N);
  eq('ago: now / seconds', [A(0), A(900), A(5000), A(59000)], ['now', 'now', '5 s ago', '59 s ago']);
  eq('ago: minutes, hours, days', [A(65000), A(3600000 + 125000), A(2 * 86400000 + 5 * 3600000)], ['1 min 05 s ago', '1 h 02 min ago', '2 d 5 h ago']);
  eq('ago: Unix seconds are accepted', K.tblAgo(N / 1000 - 30, N), '30 s ago');
  eq('ago: future, text, empty', [A(-60000), K.tblAgo('x', N), K.tblAgo(null, N), K.tblAgo(12, N)], ['', '', '', '']); }
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
