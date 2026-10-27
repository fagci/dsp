// modules/pip-kernels.js: пропорции окна PiP; плюс модуль pip.js — выбор пути (браузер / приложение) на заглушках.
import fs from 'node:fs'; import vm from 'node:vm';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const log = [];
const ctx = vm.createContext({ Math, Number, Promise, setTimeout, console, window: {}, document: { pictureInPictureEnabled: true }, HTMLCanvasElement: function () {}, navigator: {} });
ctx.HTMLCanvasElement.prototype.captureStream = () => ({});
ctx.window = ctx;
for (const f of ['pip-kernels.js', 'pip.js']) vm.runInContext(fs.readFileSync(new URL('../modules/' + f, import.meta.url), 'utf8'), ctx);
vm.runInContext('this.K={pipRatio,pipFit,pipSupported,nodePip}', ctx);
const K = ctx.K;
const near = (a, b) => Math.abs(a - b) < 2e-3;       // отношение округляется до тысячных
ok('ratio 16:9 stays', near(K.pipRatio(1280, 720)[0] / K.pipRatio(1280, 720)[1], 16 / 9));
ok('ratio is clamped to Android limits (1:2.39 … 2.39:1)', near(K.pipRatio(3000, 100)[0] / 1000, 2.39) && near(K.pipRatio(100, 3000)[0] / 1000, 1 / 2.39));
ok('ratio: bad sizes → 16:9, result is integers', K.pipRatio(0, 0).join() === '16,9' && K.pipRatio(NaN, 5).join() === '16,9' && Number.isInteger(K.pipRatio(333, 222)[0]));
ok('fit: contain without distortion, integers, bad input safe', K.pipFit(640,360,300,300).join()==='300,168' && K.pipFit(100,400,300,200).join()==='50,200' && K.pipFit(0,0,300,200).join()==='300,200' && K.pipFit(10,10,0,0).every(v=>v>=1));
ok('supported in a browser with PiP + captureStream', K.pipSupported() === true);
ctx.document.pictureInPictureEnabled = false;
ok('not supported without PiP', K.pipSupported() === false);
ctx.DspApp = { pip: () => true, pipOff: () => log.push('off') };
ok('supported in the app (DspApp.pip)', K.pipSupported() === true);
// приложение: зеркало холста и вызов DspApp.pip с пропорциями
const els = [];
ctx.document.getElementById = id => ({ style: {} });
ctx.document.createElement = tag => { const e = { tag, style: {}, children: [], append(...c) { this.children.push(...c); }, remove() { this.gone = true; }, getContext: () => ({ drawImage() { log.push('draw'); } }), appendChild() {}, clientWidth: 300, clientHeight: 170 }; els.push(e); return e; };
ctx.document.body = { appendChild(e) { log.push('body+' + e.tag); } };
ctx.requestAnimationFrame = f => 1; ctx.cancelAnimationFrame = () => {};
let asked = null; ctx.DspApp.pip = (w, h) => { asked = [w, h]; return true; };
const n = { cv: { width: 640, height: 360 } };
await K.nodePip(n);
ok('app: the mirror appears and PiP is requested with the ratio of the canvas', log.includes('body+div') && asked && near(asked[0] / asked[1], 640 / 360), JSON.stringify(asked));
const mir = els.find(e => e.tag === 'canvas');
ok('app: the mirror is sized to the window (contain) and the node is pinned while it is open', mir && mir.style.width === '300px' && mir.style.height === '168px' && n._pip === true, mir && mir.style.width + 'x' + mir.style.height);
await K.nodePip(n);
ok('app: a second press closes it, unpins the node and tells the app', log.includes('off') && els.find(e => e.tag === 'div').gone === true && n._pip === false);
ctx.DspApp.pip = () => false;
await K.nodePip({ cv: { width: 10, height: 10 } });
ok('app: PiP refused → no crash', true);
await K.nodePip({});                                          // у узла нет холста — ничего не делаем
console.log(bad ? bad + ' FAILED' : 'all ok'); process.exit(bad ? 1 : 0);
