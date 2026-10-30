// Список устройств (Settings → Devices): имя → адрес + токен. node tools/test-gateways.mjs
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({URL, URLSearchParams, JSON, Array, Object, String, Set, encodeURIComponent});
vm.runInContext(fs.readFileSync(path.join(root, 'modules/gateways-kernels.js'), 'utf8'), ctx);
const G = vm.runInContext('({gwRef,gwFind,gwAddToken,gwResolve,gwProxyTemplate,gwKind,gwClean,GW_NAME})', ctx);
let bad = 0; const eq = (n, a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) { bad++; console.log('FAIL', n, x, '!=', y); } else console.log('ok  ', n); };

eq('reference: @name', [G.gwRef('@phone'), G.gwRef(' @Pi-3.lab '), G.gwRef('ws://x'), G.gwRef('@'), G.gwRef('@a b'), G.gwRef('@'+'x'.repeat(25))], ['phone', 'Pi-3.lab', null, null, null, null]);
const list = [{name: 'phone', url: 'ws://192.168.0.101:8765'}, {name: 'Pi', url: 'wss://pi.lan:8777/path?x=1'}, {name: 'tm', url: 'ws://10.0.0.5:8765/?token=inurl'}];
const tokens = {phone: 'sec ret&1', pi: 'tk'};
eq('resolve: the token is appended (encoded), not kept in the node', G.gwResolve(list, tokens, '@phone').url, 'ws://192.168.0.101:8765/?token=sec+ret%261');
eq('resolve: case-insensitive name, existing query kept', G.gwResolve(list, tokens, '@PI').url, 'wss://pi.lan:8777/path?x=1&token=tk');
eq('resolve: a token already in the address wins', G.gwResolve(list, {tm: 'other'}, '@tm').url, 'ws://10.0.0.5:8765/?token=inurl');
eq('resolve: no token → plain address', G.gwResolve(list, {}, '@phone').url, 'ws://192.168.0.101:8765');
eq('resolve: an ordinary address is untouched', G.gwResolve(list, tokens, 'ws://127.0.0.1:8765'), {url: 'ws://127.0.0.1:8765'});
const un = G.gwResolve(list, tokens, '@nobody'); eq('resolve: unknown device is explained', [un.url, /«nobody» is not in Settings → Devices/.test(un.err)], ['', true]);
eq('proxy template: ws → http, wss → https, token encoded', [G.gwProxyTemplate(list[0], 'a b'), G.gwProxyTemplate(list[1], ''), G.gwProxyTemplate({url: 'ws://h:1/?token=fromurl'}, '')],
  ['http://192.168.0.101:8765/proxy?token=a%20b&url={url}', 'https://pi.lan:8777/proxy?url={url}', 'http://h:1/proxy?token=fromurl&url={url}']);
eq('proxy template: not a ws address', G.gwProxyTemplate({url: 'http://x'}, ''), '');
eq('hello classification', [G.gwKind({ev: 'hello'}), G.gwKind({src: 'bridge', level: 'hello', app: 'dsp-android'}), G.gwKind({src: 'bridge', level: 'hello', ver: 1}), G.gwKind({src: 'gps'}), G.gwKind(null)], ['node', 'phone', 'termux', '', '']);
eq('clean: bad names, duplicates (any case) and junk are dropped', G.gwClean([{name: 'a', url: 'ws://1'}, {name: 'A', url: 'ws://2'}, {name: 'bad name', url: 'ws://3'}, {name: '', url: 'x'}, null, {name: 'b'}, {name: ' c ', url: ' ws://4 '}]), [{name: 'a', url: 'ws://1'}, {name: 'c', url: 'ws://4'}]);
eq('clean: not a list', G.gwClean('x'), []);

// токены не должны уезжать в бэкап
const bk = fs.readFileSync(path.join(root, 'modules/backup.js'), 'utf8');
eq('backup: the token key is kept out of the export and the import', [/k!=='dsp\.gwtok'/.test(bk), /k==='dsp\.gwtok'/.test(bk)], [true, true]);
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
