// Схемы HEX Structure для rtl_tcp (modules/hex-formats.js): node tools/test-rtlhex.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({ Math, Uint8Array, DataView, ArrayBuffer, TextEncoder, TextDecoder, Array, Map, Set, Error, String, Number, BigInt, Object, Date, JSON, isNaN, parseInt });
for (const f of ['hex-kernels.js', 'hex-formats.js']) vm.runInContext(fs.readFileSync(path.join(root, 'modules', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.H={hexParse,hexBuild,hexFromHex,hexToHex,hexDetect,HEX_LIB}', ctx);
const H = ctx.H;
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n, x); };

const fld = (r, n) => r.fields.find((f) => f.n === n);
let r = H.hexParse('rtltcp-header', H.hexFromHex('52544C30000000050000001D'));
ok('header: RTL0 / R820T / 29 gains', fld(r, 'magic').value === 'RTL0' && fld(r, 'tuner').value === 5 && fld(r, 'gains').value === 29, JSON.stringify(r.fields.map((f) => [f.n, f.value, f.text])));
r = H.hexParse('rtltcp-cmd', H.hexFromHex('0105F5E100'));
ok('cmd: set frequency 100 MHz', fld(r, 'cmd').value === 1 && fld(r, 'param').value === 100000000, JSON.stringify(r.fields.map((f) => [f.n, f.value, f.text])));
r = H.hexParse('rtltcp-cmd', H.hexFromHex('05FFFFFFFD'));
ok('cmd: ppm param is raw u32', fld(r, 'param').value === 0xFFFFFFFD);
const built = H.hexBuild('rtltcp-cmd', { cmd: 1, param: 433920000 });
ok('cmd builds 01 19 DD 18 00', Array.from(built.bytes).map((x) => x.toString(16).padStart(2, '0')).join('') === '0119dd1800');
ok('auto-detect picks rtltcp-cmd', (() => { try { const d = H.hexDetect(H.hexFromHex('0105F5E100')); return JSON.stringify(d).includes('rtltcp-cmd'); } catch (e) { return false; } })());
process.exit(bad ? 1 : 0);
