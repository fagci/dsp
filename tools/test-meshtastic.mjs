// Разбор Meshtastic: node tools/test-meshtastic.mjs
// Кадры собраны по mesh.proto / portnums.proto / telemetry.proto, не сняты с реальной ноды.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,DataView,ArrayBuffer,Object,Array,Error,TextDecoder,TextEncoder,parseInt,String,isFinite});
vm.runInContext(fs.readFileSync(path.join(root,'modules/meshtastic-kernels.js'),'utf8')+';this.M={pbRead,mshFromRadio,mshWantConfig,mshTextPacket,mshParseNode,mshNodeId,mshFrameWrap,mshFrameStream,mshFramePush};',ctx);
const M=ctx.M;
let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const near=(n,a,b,e=1e-4)=>{ if(!(Math.abs(a-b)<=e)){ bad++; console.log('FAIL',n,a,'≉',b); } else console.log('ok  ',n); };
const vr=v=>{ const o=[]; v>>>=0; while(v>0x7f){ o.push((v&0x7f)|0x80); v>>>=7; } o.push(v); return o; };
const tag=(n,w)=>vr((n<<3)|w), wv=(n,v)=>[...tag(n,0),...vr(v)], wl=(n,b)=>[...tag(n,2),...vr(b.length),...b];
const wf=(n,v)=>[...tag(n,5),v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
const f32=v=>{ const d=new DataView(new ArrayBuffer(4)); d.setFloat32(0,v); return d.getUint32(0); };
const utf=s=>[...new TextEncoder().encode(s)];

eq('want_config',[...M.mshWantConfig(1)],[0x18,1]);
eq('parse node !hex',M.mshParseNode('!A1B2C3D4'),0xA1B2C3D4);
eq('parse node all',M.mshParseNode('^all'),0xFFFFFFFF);
eq('parse node bad',M.mshParseNode('zz'),null);
eq('node id',M.mshNodeId(0x1234),'!00001234');

const mkPkt=(from,port,payload,extra=[])=>wl(2,[...wf(1,from),...wf(2,0xFFFFFFFF),...wl(4,[...wv(1,port),...wl(2,payload)]),...wf(6,77),...extra]);
// текст
let r=M.mshFromRadio(Uint8Array.from(mkPkt(0xA1B2C3D4,1,utf('привет mesh'),[...wf(8,f32(-7.5)),...wv(12,(-95)>>>0)])));
eq('text kind',r.kind,'packet'); eq('text from',r.pkt.from,0xA1B2C3D4); eq('text',r.pkt.data.text,'привет mesh');
near('snr',r.pkt.snr,-7.5); eq('rssi',r.pkt.rssi,-95); eq('port name',r.pkt.data.portName,'text');
// позиция (отрицательная долгота — sfixed32)
const pos=[...wf(1,Math.round(55.0415e7)),...wf(2,(Math.round(-82.9346e7))>>>0),...wv(3,180),...wv(19,9)];
r=M.mshFromRadio(Uint8Array.from(mkPkt(5,3,pos)));
near('lat',r.pkt.data.lat,55.0415); near('lon',r.pkt.data.lon,-82.9346); eq('alt',r.pkt.data.alt,180); eq('sats',r.pkt.data.sats,9);
// телеметрия: батарея, напряжение
const tel=[...wf(1,1000),...wl(2,[...wv(1,87),...wf(2,f32(4.05)),...wv(5,3600)])];
r=M.mshFromRadio(Uint8Array.from(mkPkt(5,67,tel)));
eq('battery',r.pkt.data.battery,87); near('voltage',r.pkt.data.voltage,4.05); eq('uptime',r.pkt.data.uptime,3600);
// NodeInfo с User и позицией
const user=[...wl(1,utf('!a1b2c3d4')),...wl(2,utf('Base Camp')),...wl(3,utf('BC'))];
r=M.mshFromRadio(Uint8Array.from(wl(4,[...wv(1,0xA1B2C3D4),...wl(2,user),...wl(3,pos),...wf(5,1700000000)])));
eq('node kind',r.kind,'node'); eq('node num',r.node.num,0xA1B2C3D4); eq('node long',r.node.user.long,'Base Camp'); eq('node short',r.node.user.short,'BC');
near('node lat',r.node.lat,55.0415); eq('node heard',r.node.heard,1700000000);
// my_info, config_complete, шифрованный пакет
eq('myinfo',M.mshFromRadio(Uint8Array.from(wl(3,wv(1,0x1234)))).num,0x1234);
eq('complete',M.mshFromRadio(Uint8Array.from(wv(7,1))).kind,'complete');
r=M.mshFromRadio(Uint8Array.from(wl(2,[...wf(1,9),...wl(5,[1,2,3])])));
eq('encrypted',r.pkt.encrypted,true);
// мусор не должен падать иначе чем исключением
let thrown=false; try{ M.mshFromRadio(Uint8Array.from([0x12,0x7f,1])); }catch(e){ thrown=true; } eq('truncated throws',thrown,true);
// ToRadio: текст разбирается обратно как MeshPacket
const tx=M.mshTextPacket('hi',0xFFFFFFFF,2,0xDEADBEEF);
const top=M.pbRead(tx); const p=M.pbRead(top[1][0]);
eq('tx to',p[2][0],0xFFFFFFFF); eq('tx channel',p[3][0],2); eq('tx id',p[6][0],0xDEADBEEF);
const d=M.pbRead(p[4][0]); eq('tx port',d[1][0],1); eq('tx text',new TextDecoder().decode(d[2][0]),'hi');
// Serial-кадры: разбиение по границам, отладочный текст между кадрами
const a=Uint8Array.from(mkPkt(1,1,utf('a'))), b=Uint8Array.from(mkPkt(2,1,utf('b')));
const wire=Uint8Array.from([...utf('DEBUG | boot\n'),...M.mshFrameWrap(a),...utf('x'),...M.mshFrameWrap(b)]);
let st=M.mshFrameStream(), got=[];
for(let i=0;i<wire.length;i+=5) got.push(...M.mshFramePush(st,wire.slice(i,i+5)));
eq('frames count',got.length,2); eq('frame 1',M.mshFromRadio(got[0]).pkt.data.text,'a'); eq('frame 2',M.mshFromRadio(got[1]).pkt.data.text,'b');
st=M.mshFrameStream(); eq('oversize dropped',M.mshFramePush(st,Uint8Array.from([0x94,0xC3,0xFF,0xFF,1,2])).length,0);
console.log(bad?bad+' FAILED':'all passed'); process.exit(bad?1:0);
