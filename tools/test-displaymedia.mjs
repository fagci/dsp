// getDisplayMedia в приложении: разбор ограничений. node tools/test-displaymedia.mjs
import fs from 'node:fs';
import vm from 'node:vm';
let bad = 0;
const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
// без DspApp подмена не ставится — модуль грузится как есть
const ctx = vm.createContext({ Math, Number, String, Object, Array, JSON, RegExp, navigator: { mediaDevices: {} } });
vm.runInContext(fs.readFileSync(new URL('../modules/displaymedia-app.js', import.meta.url), 'utf8') + ';this.K={dmOptions};', ctx);
const K = ctx.K;
ok('not the app: getDisplayMedia is left alone', ctx.navigator.mediaDevices.getDisplayMedia === undefined);
ok('defaults: 8 fps, 1280 px', JSON.stringify(K.dmOptions({ video: true })) === '{"fps":8,"maxSide":1280}' && JSON.stringify(K.dmOptions()) === '{"fps":8,"maxSide":1280}' && JSON.stringify(K.dmOptions(null)) === '{"fps":8,"maxSide":1280}');
ok('frameRate: number, ideal, max; clamped 1…15', K.dmOptions({ video: { frameRate: 5 } }).fps === 5 && K.dmOptions({ video: { frameRate: { ideal: 12 } } }).fps === 12 &&
  K.dmOptions({ video: { frameRate: { max: 30 } } }).fps === 15 && K.dmOptions({ video: { frameRate: 0 } }).fps === 8 && K.dmOptions({ video: { frameRate: { ideal: 0.4 } } }).fps === 1);
ok('size: the long side of width / height, clamped 320…1920', K.dmOptions({ video: { width: 800, height: 1600 } }).maxSide === 1600 && K.dmOptions({ video: { width: { ideal: 4000 } } }).maxSide === 1920 &&
  K.dmOptions({ video: { height: { max: 100 } } }).maxSide === 320 && K.dmOptions({ video: { width: 0 } }).maxSide === 1280);
ok('junk constraints do not break it', K.dmOptions({ video: 'yes' }).fps === 8 && K.dmOptions('x').maxSide === 1280 && K.dmOptions({ video: { frameRate: 'fast' } }).fps === 8);
console.log(bad ? bad + ' FAILED' : 'all ok');
process.exit(bad ? 1 : 0);
