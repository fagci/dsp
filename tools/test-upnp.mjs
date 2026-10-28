// UPnP / DLNA: устройство вывода (modules/upnp-kernels.js) против настоящего пульта (python async-upnp-client) и наш пульт против нашего устройства: node tools/test-upnp.mjs
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { loadKernels, mockSock } from './netmock.mjs';
let bad = 0; const ok = (n, c, x = '') => { if (!c) { bad++; console.log('FAIL', n, x); } else console.log('ok  ', n); };
const K = loadKernels(['netsock-kernels.js', 'http-kernels.js', 'upnp-kernels.js'], 'NetSock,UpnpRenderer,upnpScpd,upnpDeviceDesc,upnpTime,upnpParseTime,upnpDidl,upnpDidlItem,upnpLastChange,upnpSoapParse,upnpSoapResponse,upnpSoapFault,ssdpTargets,ssdpMatch,ssdpNotify,ssdpAnswer,UPNP_TABLES,UPNP_SERVICES,upnpFindService,upnpCall,httpFetch,HttpServer,nsEnc,nsDec,upnpUuid,xmlEsc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (f, ms = 4000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(30); return f(); };

// --- чистая логика ---
ok('time', K.upnpTime(3725) === '1:02:05' && K.upnpTime(NaN) === 'NOT_IMPLEMENTED' && K.upnpParseTime('0:01:30') === 90 && K.upnpParseTime('1:02:03.500') === 3723 && K.upnpParseTime('x') === null);
const didl = K.upnpDidlItem({ title: 'Cat & dog', uri: 'http://h/a.mp4?x=1&y=2', mime: 'video/mp4' });
const dd = K.upnpDidl(didl); ok('DIDL roundtrip', dd.title === 'Cat & dog' && dd.uri === 'http://h/a.mp4?x=1&y=2' && dd.mime === 'video/mp4' && dd.cls === 'object.item.videoItem', JSON.stringify(dd));
const call = K.upnpSoapParse(K.nsEnc('<?xml version="1.0"?><s:Envelope xmlns:s="x"><s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>http://a/b?c=1&amp;d=2</CurrentURI><CurrentURIMetaData>&lt;DIDL-Lite/&gt;</CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>'), '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"');
ok('SOAP parse', call.action === 'SetAVTransportURI' && call.service.endsWith('AVTransport:1') && call.args.CurrentURI === 'http://a/b?c=1&d=2' && call.args.CurrentURIMetaData === '<DIDL-Lite/>' && call.args.InstanceID === '0', JSON.stringify(call));
ok('SOAP response / fault', K.upnpSoapResponse('urn:x:1', 'Play', { A: 'x<y' }).includes('<u:PlayResponse xmlns:u="urn:x:1"><A>x&lt;y</A>') && K.upnpSoapFault(718).includes('<errorCode>718</errorCode>'));
const lc = K.upnpLastChange('rc', { Volume: { val: 30, channel: 'Master' }, Mute: { val: 0, channel: 'Master' } });
ok('LastChange', lc.includes('<Volume channel="Master" val="30"/>') && lc.includes('metadata-1-0/RCS/'));
ok('SCPD: every action has its variables', Object.entries(K.UPNP_TABLES).every(([k, [acts, vars]]) => Object.values(acts).every((a) => a.every(([, , v]) => v in vars))));
ok('SSDP: all → 6, rootdevice → 1, type → 1, unknown → 0', K.ssdpMatch('ssdp:all', 'abc').length === 6 && K.ssdpMatch('upnp:rootdevice', 'abc').length === 1 && K.ssdpMatch('urn:schemas-upnp-org:service:AVTransport:1', 'abc').length === 1 && K.ssdpMatch('urn:x', 'abc').length === 0);
ok('SSDP: messages', K.ssdpNotify('upnp:rootdevice', 'uuid:a::upnp:rootdevice', 'http://1.2.3.4:5/desc.xml', 'alive').includes('NTS: ssdp:alive') && !K.ssdpNotify('x', 'y', 'z', 'byebye').includes('LOCATION') && K.ssdpAnswer('st', 'usn', 'loc').startsWith('HTTP/1.1 200 OK'));

// --- устройство вывода с игрушечным плеером ---
const ns = mockSock(K);
const calls = []; let playing = false, pos = 0, uri = '', vol = 100, mute = false;
const player = {
  load: (u, meta) => { uri = u; pos = 0; playing = false; calls.push('load ' + u + ' ' + meta.title); },
  play: () => { playing = true; calls.push('play'); }, pause: () => { playing = false; calls.push('pause'); }, stop: () => { playing = false; pos = 0; calls.push('stop'); },
  seek: (t) => { pos = t; calls.push('seek ' + t); }, setVolume: (v) => { vol = v; calls.push('vol ' + v); }, setMute: (m) => { mute = m; calls.push('mute ' + m); },
  info: () => ({ pos, dur: 3600, paused: !playing }),
};
const uuid = K.upnpUuid();
const rend = new K.UpnpRenderer(ns, player, { name: 'DSP Test TV', uuid, host: '127.0.0.1', port: 0, every: 60000 });
const port = await rend.start();
const loc = 'http://127.0.0.1:' + port + '/desc.xml';
ok('renderer started', port > 0 && rend.on);

// наш SSDP-ответчик: M-SEARCH по юникасту на порт 1900
let answers = [];
const probe = dgram.createSocket('udp4'); probe.on('message', (b) => answers.push(b.toString()));
await new Promise((r) => probe.bind(0, '127.0.0.1', r));
const msearch = (st) => Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ' + st + '\r\n\r\n');
if (rend.udp) {
  probe.send(msearch('urn:schemas-upnp-org:device:MediaRenderer:1'), 1900, '127.0.0.1');
  ok('SSDP: M-SEARCH for the renderer gets LOCATION and USN', await wait(() => answers.length >= 1) && answers[0].includes('LOCATION: ' + loc) && answers[0].includes('USN: uuid:' + uuid + '::urn:schemas-upnp-org:device:MediaRenderer:1'), answers[0]);
  answers = []; probe.send(msearch('ssdp:all'), 1900, '127.0.0.1');
  ok('SSDP: ssdp:all gets six answers', await wait(() => answers.length >= 6), String(answers.length));
  answers = []; probe.send(msearch('urn:other:device:Thing:1'), 1900, '127.0.0.1'); await sleep(1200);
  ok('SSDP: a foreign ST gets no answer', answers.length === 0);
} else console.log('skip SSDP: ' + rend.ssdp);

// настоящий пульт
const py = `
import asyncio,sys,json
from datetime import timedelta
from async_upnp_client.aiohttp import AiohttpRequester, AiohttpNotifyServer
from async_upnp_client.client_factory import UpnpFactory
from async_upnp_client.profiles.dlna import DmrDevice
async def main(loc):
    req=AiohttpRequester(); f=UpnpFactory(req); dev=await f.async_create_device(loc)
    ns=AiohttpNotifyServer(requester=req,source=('127.0.0.1',0)); await ns.async_start_server()
    d=DmrDevice(dev,ns.event_handler); out={}
    out['name']=dev.friendly_name; out['type']=dev.device_type; out['services']=sorted(s.service_type.split(':')[-2] for s in dev.all_services)
    await d.async_subscribe_services(auto_resubscribe=False)
    await asyncio.sleep(0.6)
    out['state0']=str(d.transport_state)
    await d.async_set_transport_uri('http://127.0.0.1:1/movie.mp4','Movie & Co')
    await d.async_play(); await asyncio.sleep(0.5); await d.async_update()
    out['state1']=str(d.transport_state); out['title']=d.media_title; out['uri']=d.current_track_uri
    await d.async_seek_rel_time(timedelta(seconds=90)); await d.async_update(); out['pos']=d.media_position; out['dur']=d.media_duration
    await d.async_set_volume_level(0.3); await d.async_mute_volume(True); await asyncio.sleep(0.4); await d.async_update()
    out['vol']=round(d.volume_level,2); out['mute']=d.is_volume_muted
    await d.async_pause(); await asyncio.sleep(0.4); out['state2']=str(d.transport_state)
    await d.async_stop(); await asyncio.sleep(0.4); out['state3']=str(d.transport_state)
    try:
        await dev.service('urn:schemas-upnp-org:service:AVTransport:1').action('Seek').async_call(InstanceID=5,Unit='REL_TIME',Target='0:00:01')
        out['badinst']='accepted'
    except Exception as e: out['badinst']=str(e)[:300]
    await d.async_unsubscribe_services(); await ns.async_stop_server()
    print('RESULT '+json.dumps(out,default=str))
asyncio.run(main(sys.argv[1]))`;
const res = await new Promise((resolve) => { let o = '', e = ''; const p = spawn('python3', ['-I', '-c', py, loc], { stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', (d) => o += d); p.stderr.on('data', (d) => e += d); p.on('close', () => resolve({ o, e })); setTimeout(() => p.kill(), 25000); });
const m = /RESULT (.*)/.exec(res.o); let R = {}; try { R = JSON.parse(m[1]); } catch (e) { console.log(res.o, res.e.slice(-1500)); }
ok('pult: description and services', R.name === 'DSP Test TV' && R.type === 'urn:schemas-upnp-org:device:MediaRenderer:1' && R.services.join() === 'AVTransport,ConnectionManager,RenderingControl', JSON.stringify(R));
ok('pult: event on subscribe (STOPPED / NO_MEDIA)', /NO_MEDIA_PRESENT|STOPPED/.test(R.state0), R.state0);
ok('pult: SetAVTransportURI + Play → PLAYING, title and URI', /PLAYING/.test(R.state1) && R.title === 'Movie & Co' && R.uri === 'http://127.0.0.1:1/movie.mp4' && calls.some((c) => c === 'load http://127.0.0.1:1/movie.mp4 Movie & Co') && calls.includes('play'), JSON.stringify(R) + calls);
ok('pult: seek, position and duration', R.pos === 90 && R.dur === 3600 && calls.includes('seek 90'), JSON.stringify([R.pos, R.dur]));
ok('pult: volume and mute', R.vol === 0.3 && R.mute === true && vol === 30 && mute === true, JSON.stringify([R.vol, R.mute, vol, mute]));
ok('pult: pause and stop reach the player, state follows by events', /PAUSED/.test(R.state2) && /STOPPED/.test(R.state3) && calls.includes('pause') && calls.includes('stop'), JSON.stringify([R.state2, R.state3]));
ok('pult: InstanceID other than 0 refused (718)', /718/.test(R.badinst), R.badinst);
ok('renderer counted the actions and subscriptions', rend.stats.actions >= 8 && rend.stats.subs >= 2, JSON.stringify(rend.stats));

// наш пульт против нашего устройства
const desc = (await K.httpFetch(ns, loc)).text();
const avt = K.upnpFindService(desc, loc, 'AVTransport'), rc = K.upnpFindService(desc, loc, 'RenderingControl');
ok('our pult: finds the services in the description', avt && avt.control === 'http://127.0.0.1:' + port + '/ctl/avt' && rc.control.endsWith('/ctl/rc'), JSON.stringify(avt));
calls.length = 0;
await K.upnpCall(ns, avt, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: 'http://127.0.0.1:2/a.mp3', CurrentURIMetaData: K.upnpDidlItem({ title: 'Song', uri: 'http://127.0.0.1:2/a.mp3', mime: 'audio/mpeg', cls: 'object.item.audioItem' }) });
await K.upnpCall(ns, avt, 'Play', { InstanceID: 0, Speed: 1 });
const ti = await K.upnpCall(ns, avt, 'GetTransportInfo', { InstanceID: 0 }), pi = await K.upnpCall(ns, avt, 'GetPositionInfo', { InstanceID: 0 });
ok('our pult: transport and position', ti.CurrentTransportState === 'PLAYING' && pi.TrackURI === 'http://127.0.0.1:2/a.mp3' && pi.TrackDuration === '1:00:00', JSON.stringify([ti, pi]));
await K.upnpCall(ns, rc, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: 55 });
ok('our pult: volume', (await K.upnpCall(ns, rc, 'GetVolume', { InstanceID: 0, Channel: 'Master' })).CurrentVolume === '55' && vol === 55);
ok('our pult: errors have codes', await K.upnpCall(ns, avt, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: 'bad' }).then(() => false, (e) => e.upnp === 711) && await K.upnpCall(ns, rc, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: 500 }).then(() => false, (e) => e.upnp === 402));
const bad1 = await K.httpFetch(ns, 'http://127.0.0.1:' + port + '/ctl/avt', { method: 'POST', body: 'garbage', headers: { SOAPACTION: '"x#y"' } });
ok('garbage SOAP → 500 with a fault', bad1.status === 500 && /UPnPError/.test(bad1.text()));
ok('unknown path → 404', (await K.httpFetch(ns, 'http://127.0.0.1:' + port + '/nope')).status === 404);
rend.playerEvent('ended'); ok('player event: end of media → STOPPED', rend.st.state === 'STOPPED');

await rend.stop(); probe.close();
ok('stopped: port closed', await K.httpFetch(ns, loc, { connectTimeout: 500 }).then(() => false, () => true));
ns.app.stop();
console.log(bad ? 'FAILED ' + bad : 'all ok');
process.exit(bad ? 1 : 0);
