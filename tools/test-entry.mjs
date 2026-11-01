// Проверка modules/entry-kernels.js: разбор выражений калькулятора, автомат кнопок, цифровой ввод (Number Pad), разряды частоты, форматы вывода.
import fs from 'node:fs';
import vm from 'node:vm';
let bad = 0;
const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const ctx = vm.createContext({ Math, Number, String, Object, Array, JSON, RegExp, Error, isFinite, parseFloat });
vm.runInContext(fs.readFileSync(new URL('../modules/entry-kernels.js', import.meta.url), 'utf8'), ctx);
vm.runInContext('this.K={ceEval,ceFmt,calcNew,calcPress,calcPreview,npNew,npPress,keyName,fdStep,fdDigits,fmtNum}', ctx);
const K = ctx.K, near = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
const ev = (s, v, o) => { try { return K.ceEval(s, v, o); } catch (e) { return 'ERR:' + e.message; } };

ok('precedence', ev('2+3*4') === 14 && ev('(2+3)*4') === 20 && ev('10-4-3') === 3 && ev('8/2/2') === 2);
ok('power is right-assoc, unary minus below it', ev('2^3^2') === 512 && ev('-2^2') === -4 && ev('2^-1') === .5);
ok('unicode operators and comma', ev('6×7') === 42 && ev('9÷3') === 3 && ev('5−2') === 3 && ev('1,5+1') === 2.5);
ok('percent, factorial', near(ev('50%'), .5) && ev('5!') === 120 && ev('(-1)!').startsWith('ERR'));
ok('unclosed parens are closed', ev('(2+3') === 5 && ev('sqrt(16') === 4 && ev('2)').startsWith('ERR'));
ok('constants and implicit multiply', near(ev('2pi'), 2 * Math.PI) && ev('2(3+4)') === 14 && near(ev('e'), Math.E));
ok('functions', ev('sqrt(81)') === 9 && ev('ln(e)') === 1 && ev('log(1000)') === 3 && ev('abs(-3)') === 3 && near(ev('db(100)'), 40));
ok('degrees / radians', near(ev('sin(30)', {}, { deg: true }), .5) && near(ev('sin(pi/2)'), 1) && near(ev('asin(1)', {}, { deg: true }), 90));
ok('variables (case-insensitive), unknown refused', ev('a*2+B', { A: 3, B: 1 }) === 7 && ev('A', { A: null }).startsWith('ERR') && ev('foo(1)').startsWith('ERR') && ev('zz').startsWith('ERR'));
ok('errors: division by zero, garbage, incomplete', ev('1/0') === 'ERR:division by zero' && ev('1+').startsWith('ERR') && ev('2 $ 3').startsWith('ERR') && ev('').startsWith('ERR'));
ok('exponent literal', ev('1e3+2.5e-1') === 1000.25);
ok('format: trimmed, exponent for extremes', K.ceFmt(0.1 + 0.2) === '0.3' && K.ceFmt(1234.5) === '1234.5' && K.ceFmt(1e20) === '1e20' && K.ceFmt(0) === '0' && K.ceFmt(NaN) === '');

const press = (keys, ext) => { const st = K.calcNew(); for (const k of keys.split(' ')) K.calcPress(st, k, ext, 12); return st; };
ok('keys: 12 + 30 =', press('1 2 + 3 0 =').res === 42);
ok('keys: result then operator continues from result', press('7 × 6 = + 8 =').res === 50);
ok('keys: result then digit starts a new expression', press('7 × 6 = 5 =').res === 5);
ok('keys: operator replaced, not doubled', press('5 + × 3 =').res === 15);
ok('keys: single decimal point per number', press('1 . 5 . 5').expr === '1.55' && press('1 . 5 + 2 . 5 . 5').expr === '1.5+2.55');
ok('keys: . alone makes 0.', press('.').expr === '0.' && press('5 + .').expr === '5+0.');
ok('keys: backspace and clear', press('1 2 3 ⌫').expr === '12' && press('1 2 C').expr === '' && press('sin').expr === 'sin(');
ok('keys: sign toggle', press('5 ±').expr === '-5' && press('5 ± ±').expr === '5' && press('3 + 5 ±').expr === '3+-5');
ok('keys: sign of a result', press('5 = ±').res === -5);
ok('keys: square, reciprocal, root', press('3 x² =').res === 9 && press('4 1/x =').res === .25 && press('√ 9 =').res === 3);
ok('keys: percent', near(press('2 0 0 × 1 5 % =').res, 30));
ok('keys: error is reported, state survives', (() => { const s = press('1 ÷ 0 ='); return s.err === 'division by zero' && s.expr === '1÷0'; })());
ok('keys: ANS and memory', press('6 = ANS × 2 =').res === 12 && press('5 = M+ C MR + 1 =').res === 6 && press('5 = M+ M+ MC MR =').res === 0);
ok('keys: A / B inputs', press('A × B =', { A: 4, B: 2.5 }).res === 10);
ok('keys: deg toggle', (() => { const s = K.calcNew(); K.calcPress(s, 'DEG'); return s.deg === false; })());
ok('preview without committing', (() => { const s = press('2 + 2'); return K.calcPreview(s) === 4 && s.res === null; })());

const np = (keys, o) => { const s = K.npNew(); for (const k of keys.split(' ')) K.npPress(s, k, o); return s; };
ok('pad: digits then unit key commits Hz', np('1 4 . 2 MHz', { mode: 'frequency' }).out === 14.2e6);
ok('pad: ENT uses the default unit', np('9 9 . 5 ENT', { mode: 'frequency', unit: 'MHz' }).out === 99.5e6 && np('7 0 0 ENT', { mode: 'frequency', unit: 'kHz' }).out === 700e3);
ok('pad: number mode suffixes', np('2 . 5 k', { mode: 'number' }).out === 2500 && np('4 7 µ', { mode: 'number' }).out === 47e-6 && np('3 ENT', { mode: 'number' }).out === 3);
ok('pad: clamped to min / max', np('9 9 9 GHz', { mode: 'frequency', min: 0, max: 6e9 }).out === 6e9 && np('1 Hz', { mode: 'frequency', min: 1e3 }).out === 1e3);
ok('pad: buffer cleared after commit, pulse set', (() => { const s = np('5 ENT', { mode: 'number' }); return s.buf === '' && s.pulse === 2; })());
ok('pad: empty commits nothing, lone dot is 0', np('ENT', { mode: 'number' }).out === null && np('. ENT', { mode: 'number' }).out === 0 && np('±', {}).buf === '-' && np('± ENT', { mode: 'number' }).out === null);
ok('pad: leading zero, one dot, sign, backspace', np('0 0 5', {}).buf === '5' && np('1 . . 2', {}).buf === '1.2' && np('5 ±', {}).buf === '-5' && np('5 ± ±', {}).buf === '5' && np('1 2 ⌫', {}).buf === '1');
ok('pad: negative number mode', np('5 ± ENT', { mode: 'number' }).out === -5);
ok('pad: length limit', np('1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7', {}).buf.length === 15);
ok('keyboard names', K.keyName({ key: '7' }) === '7' && K.keyName({ key: 'Enter' }) === 'ENT' && K.keyName({ key: 'Backspace' }) === '⌫' && K.keyName({ key: '*' }) === '×' && K.keyName({ key: 'q' }) === null);

ok('VFO step: decade, clamp', K.fdStep(14200000, 3, 1, 0, 3e10) === 14201000 && K.fdStep(14200000, 6, -1, 0, 3e10) === 13200000 && K.fdStep(500, 3, -1, 0, 1e9) === 0 && K.fdStep(999999000, 3, 1, 0, 1e9) === 1e9);
ok('VFO digits: zero padded and clamped', K.fdDigits(14200000, 9) === '014200000' && K.fdDigits(-5, 4) === '0000' && K.fdDigits(99999, 3) === '999');

const f = (x, o) => K.fmtNum(x, o);
ok('freq format: auto unit, significant digits', f(14.2e6).text === '14.2000' && f(14.2e6).unit === 'MHz' && f(433.92e6, { digits: 5 }).text === '433.92' && f(1500).unit === 'kHz' && f(50).unit === 'Hz' && f(2.4e9).unit === 'GHz');
ok('SI format: prefixes', f(0.0047, { mode: 'si', unit: 'F' }).unit === 'mF' && f(2.2e-6, { mode: 'si', unit: 'F', digits: 3 }).text === '2.20' && f(4700, { mode: 'si', unit: 'Ω' }).unit === 'kΩ' && f(0, { mode: 'si', unit: 'V' }).text === '0');
ok('groups format', f(14200000, { mode: 'groups' }).text === '14.200.000' && f(999, { mode: 'groups' }).text === '999' && f(1234567, { mode: 'groups', sep: ' ' }).text === '1 234 567' && f(-1000, { mode: 'groups' }).text === '-1.000');
ok('plain format and non-numbers', f(3.14159, { mode: 'plain', decimals: 2 }).text === '3.14' && f(null).text === '—' && f(NaN).text === '—');
console.log(bad ? 'FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
