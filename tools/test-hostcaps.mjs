// modules/hostcaps-kernels.js: что прячется там, где нет Web Bluetooth / HID / NFC / USB.
import fs from 'node:fs'; import vm from 'node:vm';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const ctx = vm.createContext({ navigator: {}, Array, Object });
vm.runInContext(fs.readFileSync(new URL('../modules/hostcaps-kernels.js', import.meta.url), 'utf8') + ';this.K={hostcapsEnv,hostcapsHidden,hostcapsPatchHidden,HOSTCAPS_NEEDS}', ctx);
const K = ctx.K;
const none = { bluetooth: false, hid: false, nfc: false, usb: false }, all = { bluetooth: true, hid: true, nfc: true, usb: true };
ok('without the APIs the modules that need them are hidden', ['bleUart', 'bleGatt', 'bleAdv', 'hid', 'funcube', 'nfc', 'dvbUsb'].every(id => K.hostcapsHidden(id, none)));
ok('with the APIs nothing is hidden', ['bleUart', 'hid', 'nfc', 'dvbUsb'].every(id => !K.hostcapsHidden(id, all)));
ok('other modules are never hidden', !K.hostcapsHidden('osc', none) && !K.hostcapsHidden('rtlsdr', none) && !K.hostcapsHidden('termux', none));
ok('partial: only what is missing', K.hostcapsHidden('hid', { ...all, hid: false }) && !K.hostcapsHidden('bleUart', { ...all, hid: false }));
ok('a preset with a hidden module is hidden, others stay', K.hostcapsPatchHidden({ nodes: [{ type: 'osc' }, { type: 'nfc' }] }, none) && !K.hostcapsPatchHidden({ nodes: [{ type: 'osc' }, { type: 'dac' }] }, none) &&
  !K.hostcapsPatchHidden(null, none) && !K.hostcapsPatchHidden({}, none) && !K.hostcapsPatchHidden({ nodes: [null, { type: 'osc' }] }, none));
ok('environment: the real checks', JSON.stringify(K.hostcapsEnv()) === JSON.stringify(none));
ctx.navigator = { usb: {}, hid: {}, bluetooth: {} };
ok('environment: APIs present', K.hostcapsEnv().usb && K.hostcapsEnv().hid && K.hostcapsEnv().bluetooth && !K.hostcapsEnv().nfc);
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
