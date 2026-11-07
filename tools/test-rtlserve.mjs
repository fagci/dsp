// Сервер rtl_tcp: заголовок, разбор команд, перевод IQ (modules/rtlserve-kernels.js): node tools/test-rtlserve.mjs
import { loadKernels } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['rtlserve-kernels.js'], 'rtlsHeader,rtlsTunerId,rtlsCmd,RtlsParser,rtlsNewState,rtlsApply,rtlsToU8,rtlsPick,rtlsHex,RTLS_CMDS');

const h = K.rtlsHeader(K.rtlsTunerId('R820T'), 29);
ok('header', K.rtlsHex(h) === '52 54 4C 30 00 00 00 05 00 00 00 1D', K.rtlsHex(h));

const p = new K.RtlsParser();
let r = p.feed(K.rtlsCmd(1, 100000000));
ok('freq hex', r.length === 1 && r[0].hex === '01 05 F5 E1 00' && r[0].k === 'freq' && r[0].val === 100000000, JSON.stringify(r));
// разрезанные пополам и склеенные команды
const two = new Uint8Array([...K.rtlsCmd(2, 2400000), ...K.rtlsCmd(4, 496)]);
r = p.feed(two.subarray(0, 3)); ok('partial waits', r.length === 0);
r = p.feed(two.subarray(3, 8)); ok('first done', r.length === 1 && r[0].k === 'sr' && r[0].val === 2400000);
r = p.feed(two.subarray(8)); ok('second done', r.length === 1 && r[0].k === 'gain' && r[0].val === 496);
r = p.feed(new Uint8Array([...K.rtlsCmd(5, -3 >>> 0), 0x77, 0, 0, 0, 1]));
ok('ppm signed + unknown', r[0].sval === -3 && r[1].k === 'unknown' && p.bad === 1);

const st = K.rtlsNewState();
for (const c of new K.RtlsParser().feed(new Uint8Array([...K.rtlsCmd(1, 433920000), ...K.rtlsCmd(4, 496), ...K.rtlsCmd(5, -3 >>> 0), ...K.rtlsCmd(0x0e, 1), ...K.rtlsCmd(0x41, 7)]))) K.rtlsApply(st, c);
ok('state', st.freq === 433920000 && Math.abs(st.gain - 49.6) < 1e-9 && st.ppm === -3 && st.bias === 1 && st.gainIdx === 7, JSON.stringify(st));

// IQ → u8
const raw = new Uint8Array([1, 2, 3, 4]);
const a = K.rtlsToU8({ raw, fmt: 'u8' });
ok('u8 copy', a.length === 4 && a[3] === 4 && a.buffer !== raw.buffer);
const f = K.rtlsToU8({ re: new Float32Array([0, 1, -1, 2]), im: new Float32Array([0, 0, 0.5, -3]) });
ok('float → u8', Array.from(f).join() === '128,128,255,128,0,191,255,0', Array.from(f).join());
ok('real stream', K.rtlsToU8({ re: new Float32Array([1]), im: null }).join() === '255,128');
ok('pick', K.rtlsPick(2500000, [250000, 1024000, 2048000, 2400000, 3200000]) === 2400000);
process.exit(bad ? 1 : 0);
