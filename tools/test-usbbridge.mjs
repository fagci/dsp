// Проверка modules/usb-bridge.js: navigator.usb поверх USB-API моста (двоичный WebSocket), без Android и DOM.
// Мост подделан здесь же и говорит тем же протоколом, что UsbSession (tools/android).
import fs from 'node:fs';
import vm from 'node:vm';

let bad = 0;
const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };

const enc = new TextEncoder(), dec = new TextDecoder();
const pack = (h, payload) => {
  const hb = enc.encode(JSON.stringify(h)), n = payload ? payload.length : 0;
  const m = new Uint8Array(4 + hb.length + n);
  new DataView(m.buffer).setUint32(0, hb.length); m.set(hb, 4); if (n) m.set(payload, 4 + hb.length);
  return m.buffer;
};
const eps = [{ num: 1, in: true, type: 'bulk', size: 512 }, { num: 2, in: false, type: 'bulk', size: 512 }];
const devices = [
  { id: '/dev/bus/usb/001/002', perm: true, vid: 0x0bda, pid: 0x2838, cls: 0, sub: 0, proto: 0, ver: '1.00', mfr: 'Realtek', prod: 'RTL2838UHIDIR', serial: '00000001',
    configs: [{ value: 1, name: null, ifaces: [{ num: 0, alt: 0, cls: 255, sub: 255, proto: 255, name: null, eps }] }] },
  { id: '/dev/bus/usb/001/003', perm: false, vid: 0x1d50, pid: 0x6089, cls: 0, sub: 0, proto: 0, ver: '1.04', mfr: null, prod: null, serial: null,
    configs: [{ value: 1, name: null, ifaces: [{ num: 0, alt: 0, cls: 255, sub: 255, proto: 255, name: null, eps }, { num: 0, alt: 1, cls: 255, sub: 255, proto: 255, name: null, eps }] }] },
];
const state = { opened: new Set(), claimed: new Set(), log: [], sockets: [] };

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; state.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1); }
  send(m) {
    const hl = new DataView(m.buffer, m.byteOffset).getUint32(0);
    const h = JSON.parse(dec.decode(m.subarray(4, 4 + hl))), payload = m.subarray(4 + hl);
    const delay = h.op === 'in' ? 20 : 1;                       // чтение медленнее: ответы приходят не по порядку запросов
    setTimeout(() => this.onmessage({ data: this.reply(h, payload) }), delay);
  }
  reply(h, payload) {
    state.log.push(h.op);
    const fail = (err, msg) => pack({ id: h.id, ok: false, err, msg });
    const d = devices.find(x => x.id === h.dev);
    if (h.op === 'list') return pack({ id: h.id, ok: true, devices });
    if (h.op === 'perm') { d.perm = true; if (!d.prod) { d.prod = 'HackRF One'; d.serial = 'abc'; } return pack({ id: h.id, ok: true, granted: true }); }
    if (!d) return fail('NotFoundError', 'device is gone');
    if (h.op === 'open') {
      state.opened.add(h.dev);
      // сырые дескрипторы: у интерфейса 0 есть alt 3 с bulk IN 1 (в модели Android его не было)
      return d === devices[0] ? pack({ id: h.id, ok: true, usb: '2.00', speed: 'high-speed', mbps: 480, raw: '0102', configs: [{ value: 1, name: null, ifaces: [
        { num: 0, alt: 0, cls: 255, sub: 255, proto: 255, name: null, eps: [] },
        { num: 0, alt: 3, cls: 255, sub: 255, proto: 255, name: null, eps: [{ num: 1, in: true, type: 'bulk', size: 512 }] }] }] }) : pack({ id: h.id, ok: true });
    }
    if (!state.opened.has(h.dev)) return fail('InvalidStateError', 'the device must be opened first');
    switch (h.op) {
      case 'close': state.opened.delete(h.dev); return pack({ id: h.id, ok: true });
      case 'config': case 'release': case 'alt': case 'clear': case 'reset': return pack({ id: h.id, ok: true });
      case 'claim': state.claimed.add(h.num); return pack({ id: h.id, ok: true });
      case 'control': return (h.rt & 0x80)
        ? pack({ id: h.id, ok: true }, Uint8Array.from({ length: h.len }, (_, i) => (h.req + i) & 255))
        : pack({ id: h.id, ok: true, got: [...payload] });
      case 'in': return pack({ id: h.id, ok: true }, Uint8Array.from({ length: h.len }, (_, i) => i & 255));
      case 'out': return pack({ id: h.id, ok: true, written: payload.length });
    }
    return fail('NotSupportedError', 'unknown op');
  }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
  push(h) { this.onmessage({ data: pack(h) }); }
}

const ctx = vm.createContext({
  TextEncoder, TextDecoder, EventTarget, Event, DOMException, ArrayBuffer, Uint8Array, DataView, JSON, Promise, Map, Set, Object, TypeError, Error,
  setTimeout, navigator: {}, window: {}, WebSocket: FakeWS,
});
vm.runInContext(fs.readFileSync(new URL('../modules/usb-bridge.js', import.meta.url), 'utf8') + ';this.install=usbBridgeInstall;this.match=usbBridgeMatch;', ctx);

ok('no bridge address → navigator.usb stays unset (auto-install does nothing)', ctx.navigator.usb === undefined);
const picks = [];
const usb = ctx.install(ctx.navigator, 'ws://127.0.0.1:8765/usb?k=x', FakeWS, { choose: async lines => { picks.push(lines); return 1; } });
ok('install defines navigator.usb', ctx.navigator.usb === usb);

const got = await usb.getDevices();
ok('getDevices: only devices that have access', got.length === 1 && got[0].vendorId === 0x0bda && got[0].productName === 'RTL2838UHIDIR' && got[0].serialNumber === '00000001');
const d = got[0];
ok('device model: version, configuration, interfaces, endpoints', d.deviceVersionMajor === 1 && d.configurations[0].configurationValue === 1 &&
  d.configurations[0].interfaces[0].alternates[0].endpoints[0].direction === 'in' && d.configurations[0].interfaces[0].alternates[0].endpoints[1].direction === 'out' && d.opened === false && d.configuration === null);
ok('same object on the next call', (await usb.getDevices())[0] === d);

let e1; try { await d.transferIn(1, 4); } catch (e) { e1 = e; }
ok('InvalidStateError before open', e1 && e1.name === 'InvalidStateError', e1 && e1.name);

await d.open();
ok('open: opened, first configuration selected', d.opened && d.configuration === d.configurations[0]);
const alts = d.configuration.interfaces[0].alternates;
ok('open: descriptors replaced by the raw ones (alt 3 with a bulk endpoint appears)', alts.length === 2 && alts[1].alternateSetting === 3 && alts[1].endpoints[0].type === 'bulk' && alts[1].endpoints[0].packetSize === 512 && d.speed === 'high-speed' && d.usbVersionMajor === 2 && d.mbps === 480 && d.rawHex === '0102');
await d.claimInterface(0); await d.selectAlternateInterface(0, 3);
ok('selectAlternateInterface to the raw-only setting', d.configuration.interfaces[0].alternate.alternateSetting === 3 && state.log.includes('alt'));
await d.selectConfiguration(1); await d.claimInterface(0);
ok('claim', d.configuration.interfaces[0].claimed && state.claimed.has(0));
let e2; try { await d.selectConfiguration(9); } catch (e) { e2 = e; }
ok('NotFoundError for an unknown configuration', e2 && e2.name === 'NotFoundError');

const ci = await d.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 5, value: 0, index: 0 }, 4);
ok('controlTransferIn: data and status', ci.status === 'ok' && [...new Uint8Array(ci.data.buffer)].join() === '5,6,7,8');
const co = await d.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 1, value: 2, index: 3 }, new Uint8Array([9, 8]));
ok('controlTransferOut: bytes written', co.bytesWritten === 2 && co.status === 'ok');

// два чтения подряд и быстрая запись между ними: ответы по id, а не по порядку
const [a, w, b] = await Promise.all([d.transferIn(1, 8), d.transferOut(2, new Uint8Array([1, 2, 3])), d.transferIn(1, 4)]);
ok('concurrent transfers resolve by id', a.data.byteLength === 8 && b.data.byteLength === 4 && w.bytesWritten === 3 && new DataView(a.data.buffer).getUint8(7) === 7);
await d.clearHalt('in', 1); await d.reset();
ok('clearHalt and reset reach the bridge', state.log.includes('clear') && state.log.includes('reset'));

let e3; try { await d.isochronousTransferIn(1, [64]); } catch (e) { e3 = e; }
ok('isochronous: NotSupportedError', e3 && e3.name === 'NotSupportedError');

// requestDevice: фильтры, выбор из нескольких, доступ
let e4; try { await usb.requestDevice({ filters: [{ vendorId: 0x1234 }] }); } catch (e) { e4 = e; }
ok('requestDevice: no match → NotFoundError', e4 && e4.name === 'NotFoundError');
const hk = await usb.requestDevice({ filters: [{ vendorId: 0x1d50 }] });
ok('requestDevice: single match → access asked, names appear', hk.vendorId === 0x1d50 && hk.productName === 'HackRF One' && hk.serialNumber === 'abc' && picks.length === 0 && state.log.includes('perm'));
ok('alternate settings are grouped under one interface', hk.configurations[0].interfaces.length === 1 && hk.configurations[0].interfaces[0].alternates.length === 2);
devices[0].perm = true; devices[1].perm = false;
const any = await usb.requestDevice({ filters: [] });
ok('requestDevice: several matches → the chooser decides', picks.length === 1 && picks[0].length === 2 && any.vendorId === 0x1d50);

ok('filters: class code matches an interface', ctx.match({ classCode: 255 }, d) && !ctx.match({ classCode: 8 }, d) && ctx.match({ vendorId: 0x0bda, productId: 0x2838 }, d) && !ctx.match({ productId: 1 }, d));

// отключение
let seen = null; usb.ondisconnect = ev => { seen = ev.device; };
state.sockets.at(-1).push({ ev: 'disconnect', id: d._id });
ok('disconnect: event with the device, closed', seen === d && d.opened === false);
let e5; try { await d.transferIn(1, 1); } catch (e) { e5 = e; }
ok('after disconnect: InvalidStateError', e5 && e5.name === 'InvalidStateError');
let conn = null; usb.onconnect = ev => { conn = ev.device; };
state.sockets.at(-1).push({ ev: 'connect', id: d._id, perm: true, vid: 1, pid: 2, cls: 0, sub: 0, proto: 0, ver: '1.00', configs: [] });
ok('connect event carries a device', conn && conn.vendorId === 1);

// обрыв сокета: ожидающие запросы падают, следующий запрос открывает соединение заново
const n0 = state.sockets.length;
const pending = usb.getDevices();
state.sockets.at(-1).close();
let e6; try { await pending; } catch (e) { e6 = e; }
const again = await usb.getDevices();
ok('socket loss rejects pending, then reconnects', (e6 === undefined || e6.name === 'NetworkError') && state.sockets.length === n0 + 1 && again.length >= 1);

console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
