// Двоичный пакет прошивки радио-моста = то, что разбирает страница: printBinary / crc16ccitt вырезаются из .ino, собираются g++ с заглушкой Serial,
// их вывод идёт через radioDemux из radiobridge-kernels.js. Без g++ тест пропускается. node tools/test-radiobin-fw.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let gxx = ''; try { gxx = execFileSync('which', ['g++']).toString().trim(); } catch (e) {}
if (!gxx) { console.log('skip: no g++'); process.exit(0); }
const ino = fs.readFileSync(path.join(root, 'tools/radio-bridge-esp32c5/radio-bridge-esp32c5.ino'), 'utf8');
const cut = (a, b) => { const i = ino.indexOf(a), j = ino.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker not found: ' + a); return ino.slice(i, j); };
const main = `
int main() {
  Event e;
  memset(&e, 0, sizeof e); e.type = 0; e.proto = P_WIFI; e.ch = 36; e.rssi = -50; e.fmt = 4; e.mcs = 7; e.bw = 40; e.noise = -92; e.ts = 123456; e.len = 6; e.origLen = 9;
  for (int i = 0; i < 6; i++) e.data[i] = 0x40 + i;
  printBinary(e);
  memset(&e, 0, sizeof e); e.type = 4; e.proto = P_BLE; strcpy(e.addr, "11:22:33:44:55:66"); e.rssi = -91; e.atype = 1; e.x1 = 3; e.x2 = 3; e.ch = 5; e.lqi = 1; e.ts = 777;
  e.len = 4; e.origLen = 4; e.data[0] = 2; e.data[1] = 1; e.data[2] = 6; e.data[3] = 5;
  printBinary(e);
  memset(&e, 0, sizeof e); e.type = 0; e.proto = P_BLE; strcpy(e.addr, "aa:bb:cc:dd:ee:ff"); e.rssi = -60; e.evtype = 4; e.ts = 5; e.len = 2; e.origLen = 2; e.data[0] = 0xde; e.data[1] = 0xad;
  printBinary(e);
  memset(&e, 0, sizeof e); e.type = 0; e.proto = P_ZB; e.ch = 15; e.rssi = -60; e.lqi = 200; e.ts = 424242; e.len = 3; e.origLen = 3; e.data[0] = 0x61; e.data[1] = 0x88; e.data[2] = 5;
  printBinary(e);
  memset(&e, 0, sizeof e); e.type = 2; e.proto = P_WIFI; if (printBinary(e)) return 1;      // CSI stays text
}`;
const src = `#include <cstdio>\n#include <cstdint>\n#include <cstring>\n#include <cstddef>\n#define EV_MAX 640\nstatic char outBuf[EV_MAX * 2 + 80];\n` +
  `struct SerialStub { void write(const uint8_t *p, size_t n) { for (size_t i = 0; i < n; i++) printf("%02x", p[i]); putchar(10); } } Serial;\n` +
  `enum Proto { P_WIFI, P_BLE, P_ZB };\n` + cut('struct Event {', '#define EV_HDR') + cut('static uint16_t crc16ccitt', 'static void printEvent') + main + '\n';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiobin-'));
fs.writeFileSync(path.join(dir, 'a.cpp'), src);
execFileSync(gxx, ['-std=c++17', '-o', path.join(dir, 'a'), path.join(dir, 'a.cpp')]);
const out = execFileSync(path.join(dir, 'a')).toString().trim().split('\n');
const ctx = vm.createContext({Math, Uint8Array, Array, Map, Set, Error, String, Number, Object, Date, JSON, isNaN, parseInt, isFinite});
for (const f of ['hex-kernels.js', 'hex-formats.js', 'hex-gsm.js', 'wifisniff-kernels.js', 'radiobridge-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root, 'modules', f), 'utf8'), ctx, {filename: f});
ctx.all = Uint8Array.from(out.flatMap(l => l.match(/../g).map(h => parseInt(h, 16)))); ctx.st = {};
const r = vm.runInContext('radioDemux(st,all)', ctx), fr = r.frames;
let bad = 0;
const ok = (n, c) => { if (!c) bad++; console.log((c ? 'ok   ' : 'FAIL ') + n); };
ok('firmware packets: 4 frames, CRC fine, nothing broken', fr.length === 4 && r.bad === 0);
ok('wifi: channel, rssi, PHY meta, truncation, payload', fr[0].proto === 'wifi' && fr[0].chan === 36 && fr[0].rssi === -50 && fr[0].trunc === true && JSON.stringify(fr[0].meta) === '{"fmt":4,"mcs":7,"bw":40,"noise":-92,"ts":123456}' && fr[0].bytes.length === 6 && fr[0].bytes[5] === 0x45);
ok('ble extended: address, phys, sid, data status, timestamp', fr[1].addr === '11:22:33:44:55:66' && fr[1].rssi === -91 && fr[1].atype === 1 && JSON.stringify(fr[1].ext) === '{"props":0,"phy1":3,"phy2":3,"sid":5,"status":1}' && fr[1].ts === 777 && fr[1].bytes.length === 4);
ok('ble legacy: event type and payload', fr[2].addr === 'aa:bb:cc:dd:ee:ff' && fr[2].evtype === 4 && !fr[2].ext && fr[2].bytes[0] === 0xde && fr[2].ts === 5);
ok('zigbee: channel, rssi, lqi, timestamp', fr[3].proto === 'zb' && fr[3].chan === 15 && fr[3].rssi === -60 && fr[3].lqi === 200 && fr[3].ts === 424242);
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
