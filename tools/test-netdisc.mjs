// Обнаружение устройств (modules/netdisc-kernels.js): SSDP / UPnP и mDNS: node tools/test-netdisc.mjs
import http from 'node:http';
import dgram from 'node:dgram';
import { loadKernels, mockSock } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'http-kernels.js', 'netscan-kernels.js', 'netdisc-kernels.js'], 'NetSock,ssdpSearch,ssdpParse,upnpParseDesc,discKind,discRun');

const sr = K.ssdpSearch('upnp:rootdevice', 3);
ok('M-SEARCH', sr.startsWith('M-SEARCH * HTTP/1.1\r\n') && sr.includes('MAN: "ssdp:discover"') && sr.includes('ST: upnp:rootdevice') && sr.includes('MX: 3') && sr.endsWith('\r\n\r\n'));
const p = K.ssdpParse('HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://10.0.0.5:49152/desc.xml\r\nSERVER: Linux UPnP/1.0 Foo/2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n');
ok('parse response', p.kind === 'response' && p.location === 'http://10.0.0.5:49152/desc.xml' && p.server.startsWith('Linux') && p.st.endsWith('MediaRenderer:1'));
ok('parse notify and own search', K.ssdpParse('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nNTS: ssdp:alive\r\n\r\n').kind === 'notify' && K.ssdpParse('M-SEARCH * HTTP/1.1\r\n\r\n').kind === 'search' && K.ssdpParse('garbage') === null);
const xml = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Living &amp; Room TV</friendlyName>
<manufacturer>Acme</manufacturer><modelName>TV-9</modelName><UDN>uuid:1234</UDN>
<iconList><icon><mimetype>image/png</mimetype><url>/i.png</url></icon></iconList>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><serviceId>urn:upnp-org:serviceId:AVTransport</serviceId><controlURL>/ctl/avt</controlURL><eventSubURL>/evt/avt</eventSubURL><SCPDURL>/avt.xml</SCPDURL></service>
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/ctl/rc</controlURL></service></serviceList>
<deviceList><device><friendlyName>Embedded</friendlyName></device></deviceList></device></root>`;
const d = K.upnpParseDesc(xml);
ok('UPnP description', d.name === 'Living & Room TV' && d.manufacturer === 'Acme' && d.model === 'TV-9' && d.udn === 'uuid:1234' && d.services.length === 2 && d.services[0].control === '/ctl/avt', JSON.stringify(d));
ok('kinds', K.discKind('urn:schemas-upnp-org:device:MediaRenderer:1') === 'media renderer' && K.discKind('_ipp._tcp') === 'printer' && K.discKind('_googlecast._tcp') === 'cast'
  && K.discKind('urn:schemas-upnp-org:device:InternetGatewayDevice:1') === 'router' && K.discKind('_raop._tcp') === 'speaker' && K.discKind('urn:x:device:MediaServer:1') === 'media server' && K.discKind('zzz') === '');

// --- SSDP-«устройство» и описание на настоящих сокетах ---
const web = http.createServer((q, s) => { if (q.url === '/desc.xml') { s.setHeader('content-type', 'text/xml'); s.end(xml); } else { s.statusCode = 404; s.end(); } });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const loc = 'http://127.0.0.1:' + web.address().port + '/desc.xml';
const dev = dgram.createSocket('udp4'); let got = 0;
dev.on('message', (b, i) => {
  got++;
  const reply = (st) => dev.send(Buffer.from('HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: ' + loc + '\r\nSERVER: TestOS UPnP/1.0\r\nST: ' + st + '\r\nUSN: uuid:1234::' + st + '\r\n\r\n'), i.port, i.address);
  reply('urn:schemas-upnp-org:device:MediaRenderer:1'); reply('upnp:rootdevice'); reply('urn:schemas-upnp-org:device:MediaRenderer:1');   // повтор — не должен дублироваться
});
await new Promise((r) => dev.bind(0, '127.0.0.1', r));
const ns = mockSock(K, {
  extra: (j, reply, ev) => {
    if (j.cmd === 'nsd.discover') {
      reply(j.id, j.cmd, null, { type: j.type });
      if (j.type === '_ipp._tcp') setTimeout(() => { ev({ ev: 'nsd', kind: 'found', name: 'Office Printer', type: '_ipp._tcp' }); ev({ ev: 'nsd', kind: 'resolved', name: 'Office Printer', type: '_ipp._tcp', host: '10.0.0.7', port: 631, txt: { ty: 'LaserJet' } }); }, 50);
      return true;
    }
    if (j.cmd === 'nsd.stop') { reply(j.id, j.cmd, null); return true; }
    return false;
  },
});
const recs = [];
const r = await K.discRun(ns, { targets: ['127.0.0.1:' + dev.address().port], wait: 1200, mdns: ['_ipp._tcp', '_raop._tcp'], mdnsWait: 300, onRec: (x) => recs.push(x) });
const ssdp = recs.filter((x) => x.via === 'ssdp'), up = recs.filter((x) => x.via === 'upnp'), md = recs.filter((x) => x.via === 'mdns');
ok('SSDP: two distinct entries, repeats dropped', ssdp.length === 2 && ssdp.every((x) => x.ip === '127.0.0.1' && x.server === 'TestOS UPnP/1.0'), JSON.stringify(ssdp.map((x) => x.st)));
ok('search is sent twice (UDP may lose one)', got >= 2, String(got));
ok('UPnP description fetched once for the LOCATION', up.length === 1 && up[0].name === 'Living & Room TV' && up[0].kind === 'media renderer' && /AVTransport/.test(up[0].services), JSON.stringify(up));
ok('mDNS: printer found and resolved', md.some((x) => x.state === 'found' && x.name === 'Office Printer') && md.some((x) => x.state === 'resolved' && x.ip === '10.0.0.7' && x.port === 631 && x.kind === 'printer'), JSON.stringify(md));
ok('summary', r.found === ssdp.length + md.length);
let cnt = 0; const r2 = await K.discRun(ns, { targets: ['127.0.0.1:' + dev.address().port], wait: 5000, mdns: [], stop: () => ++cnt > 3 });
ok('stop ends the wait early', r2.ms < 3000, String(r2.ms));
dev.close(); web.close(); ns.app.stop();
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
