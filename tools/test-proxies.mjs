// Список прокси (Settings → Network): cors / bridge / socks, общий прокси, выбор в узле. node tools/test-proxies.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({URL, URLSearchParams, JSON, Array, Object, String, Set, encodeURIComponent});
for (const f of ['gateways-kernels.js', 'proxy-kernels.js']) vm.runInContext(fs.readFileSync(path.join(root, 'modules', f), 'utf8'), ctx);
const P = vm.runInContext('({pxClean,pxFind,pxTemplate,pxProblem,pxMigrate,pxSel,pxChoices,pxApply,pxNameOk})', ctx);
let bad = 0; const eq = (n, a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) { bad++; console.log('FAIL', n, x, '!=', y); } else console.log('ok  ', n); };

eq('clean: types, fields, junk, duplicates, reserved names', P.pxClean([
  {name: 'nginx', type: 'cors', url: ' https://p.example/?u={url} '}, {name: 'NGINX', type: 'cors', url: 'x'}, {name: 'auto', type: 'cors', url: 'x'}, {name: 'Off'},
  {name: 'phone', type: 'bridge', dev: '@phone'}, {name: 'tor', type: 'socks', dev: 'pi', cred: 'tor'}, {name: 'weird', type: 'ftp', url: 'u'}, {name: 'bad name'}, null, {type: 'cors'}]),
  [{name: 'nginx', type: 'cors', url: 'https://p.example/?u={url}'}, {name: 'phone', type: 'bridge', dev: '@phone'}, {name: 'tor', type: 'socks', dev: 'pi', cred: 'tor'}, {name: 'weird', type: 'cors', url: 'u'}]);
eq('clean: not a list', P.pxClean('x'), []);

const devs = [{name: 'phone', url: 'ws://192.168.0.101:8765'}, {name: 'pi', url: 'wss://pi.lan:8777'}, {name: 'bad', url: 'http://x'}], tokens = {phone: 'tk'};
eq('template: cors is the address as typed', P.pxTemplate({type: 'cors', url: 'https://p/?u={url}'}, devs, tokens), 'https://p/?u={url}');
eq('template: bridge → /proxy of the device with its token (leading @ allowed)', [P.pxTemplate({type: 'bridge', dev: 'phone'}, devs, tokens), P.pxTemplate({type: 'bridge', dev: '@pi'}, devs, tokens)],
  ['http://192.168.0.101:8765/proxy?token=tk&url={url}', 'https://pi.lan:8777/proxy?url={url}']);
eq('template: socks goes through its bridge, unknown device / not ws → empty', [P.pxTemplate({type: 'socks', dev: 'pi', cred: 'tor'}, devs, {}), P.pxTemplate({type: 'bridge', dev: 'nobody'}, devs, {}), P.pxTemplate({type: 'bridge', dev: 'bad'}, devs, {}), P.pxTemplate(null, devs, {})],
  ['https://pi.lan:8777/proxy?url={url}', '', '', '']);

const creds = [{name: 'tor'}];
eq('problems are explained', [P.pxProblem({type: 'cors', url: 'https://x/{url}'}, devs, creds), P.pxProblem({type: 'cors', url: 'proxy.lan'}, devs, creds), P.pxProblem({type: 'bridge', dev: ''}, devs, creds),
  P.pxProblem({type: 'bridge', dev: 'zz'}, devs, creds), P.pxProblem({type: 'bridge', dev: 'bad'}, devs, creds), P.pxProblem({type: 'bridge', dev: 'phone'}, devs, creds),
  P.pxProblem({type: 'socks', dev: 'pi', cred: ''}, devs, creds), P.pxProblem({type: 'socks', dev: 'pi', cred: 'zz'}, devs, creds), P.pxProblem({type: 'socks', dev: 'pi', cred: 'TOR'}, devs, creds)].map(s => s.slice(0, 18)),
  ['', 'the address must s', 'choose a bridge fr', 'device «zz» is not', 'the address of «ba', '', 'choose a proxy cre', 'credential «zz» is', '']);

eq('migrate: the old «CORS proxy» line becomes a list entry', [P.pxMigrate(''), P.pxMigrate('https://p/?u={url}'), P.pxMigrate('@phone'), P.pxMigrate('@bad name')],
  [{list: [], def: ''}, {list: [{name: 'proxy', type: 'cors', url: 'https://p/?u={url}'}], def: 'proxy'}, {list: [{name: 'phone', type: 'bridge', dev: 'phone'}], def: 'phone'}, {list: [], def: ''}]);

eq('node value: auto / off / name; the old tick keeps its meaning', [P.pxSel('', 'p', 'always'), P.pxSel(undefined, 'p', 'always'), P.pxSel(false, 'p', 'always'), P.pxSel('auto', 'p', 'always'), P.pxSel('OFF', 'p', 'always'), P.pxSel('tor', 'p', 'always'),
  P.pxSel(true, 'p', 'always'), P.pxSel(true, 'p', 'auto'), P.pxSel(true, '', 'always')],
  [{mode: 'auto'}, {mode: 'auto'}, {mode: 'auto'}, {mode: 'auto'}, {mode: 'off'}, {mode: 'name', name: 'tor'}, {mode: 'name', name: 'p'}, {mode: 'auto'}, {mode: 'auto'}]);
eq('choices: auto and off come first', P.pxChoices([{name: 'a'}, {name: 'b'}]), ['auto', 'off', 'a', 'b']);
eq('apply: {url} is encoded, a prefix gets the address as is', [P.pxApply('https://p/?u={url}', 'https://x/y?a=1&b=2'), P.pxApply('https://p/', 'https://x/y')], ['https://p/?u=https%3A%2F%2Fx%2Fy%3Fa%3D1%26b%3D2', 'https://p/https://x/y']);
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
