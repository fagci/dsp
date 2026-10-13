// Разбор MeshCore: node tools/test-meshcore.mjs
// Кадры собраны вручную по meshcore-dev/meshcore (Packet.cpp, Utils.cpp, AdvertDataHelpers.cpp), не сняты с реальной ноды.
// AES-128-ECB и HMAC-SHA256 проверены отдельно тест-векторами NIST/RFC 4231 при написании; здесь — сборка↔разбор пакета целиком.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const bytesHex=(a,o,n)=>{ let s=''; for(let i=o||0;i<(n==null?a.length:(o||0)+n);i++) s+=(a[i]<16?'0':'')+a[i].toString(16); return s.toUpperCase(); };
const atob=s=>Buffer.from(s,'base64').toString('binary');
const ctx=vm.createContext({Math,Uint8Array,DataView,ArrayBuffer,Object,Array,Error,TextDecoder,TextEncoder,parseInt,String,isFinite,bytesHex,atob});
vm.runInContext(fs.readFileSync(path.join(root,'modules/meshcore-kernels.js'),'utf8'),ctx);
const M=vm.runInContext('({mcAesSchedule,mcAesEncryptBlock,mcAesDecryptBlock,mcPskSecret,mcEncryptThenMac,mcDecode,MC_PUBLIC_PSK})',ctx);

let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const near=(n,a,b,e=1e-4)=>{ if(!(Math.abs(a-b)<=e)){ bad++; console.log('FAIL',n,a,'≉',b); } else console.log('ok  ',n); };

// AES-128 ECB: FIPS-197 Appendix B/C.1 вектор
{ const hex=h=>Uint8Array.from(h.match(/../g).map(x=>parseInt(x,16)));
  const key=hex('000102030405060708090a0b0c0d0e0f'), pt=hex('00112233445566778899aabbccddeeff'), ctExpect='69c4e0d86a7b0430d8cdb78070b4c55a';
  const sch=M.mcAesSchedule(key), ct=M.mcAesEncryptBlock(pt,sch);
  eq('aes-128 encrypt (FIPS-197)',bytesHex(ct).toLowerCase(),ctExpect);
  eq('aes-128 decrypt (FIPS-197)',bytesHex(M.mcAesDecryptBlock(ct,sch)).toLowerCase(),bytesHex(pt).toLowerCase()); }

const u32le=v=>[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
const hdr=(ptype,route)=>(ptype<<2)|route;

// ADVERT: заголовок — целиком открытый текст (имя, тип, позиция), подпись не проверяем
{ const pub=new Uint8Array(32).fill(0x11), sig=new Uint8Array(64).fill(0x22), name=[...Buffer.from('Relay-Hill')];
  const flags=0x80|0x10|2; // name + latlon + type=repeater
  const app=[flags,...u32le(1000000),...u32le(2000000),...name]; // lat=1.0, lon=2.0
  const payload=[...pub,...u32le(0x0f424092),...sig,...app];
  const pkt=Uint8Array.from([hdr(4,1),0,...payload]); // ADVERT, route=flood, 0 хопов
  const r=M.mcDecode(pkt,[M.MC_PUBLIC_PSK]);
  eq('advert type',r.typeName,'advert'); eq('advert name',r.name,'Relay-Hill'); eq('advert kind',r.advTypeName,'repeater');
  near('advert lat',r.lat,1.0); near('advert lon',r.lon,2.0); }

// GRP_TXT на предустановленном канале Public — расшифровка ключом по умолчанию
{ const ks=M.mcPskSecret(M.MC_PUBLIC_PSK);
  eq('public channel hash',ks.hash,0x11);
  const text=[...Buffer.from('Alice: hello mesh')];
  const plain=Uint8Array.from([...u32le(1700000000),0,...text]);
  const enc=M.mcEncryptThenMac(ks.secret,plain);
  const pkt=Uint8Array.from([hdr(5,1),0,ks.hash,...enc]); // GRP_TXT, route=flood
  const r=M.mcDecode(pkt,[M.MC_PUBLIC_PSK]);
  eq('grp_txt type',r.typeName,'group text'); eq('grp_txt text',r.text,'Alice: hello mesh'); eq('grp_txt timestamp',r.timestamp,1700000000); }

// неизвестный PSK — помечается как encrypted, без расшифровки
{ const ks=M.mcPskSecret(M.MC_PUBLIC_PSK);
  const enc=M.mcEncryptThenMac(ks.secret,Uint8Array.from([...u32le(0),0]));
  const pkt=Uint8Array.from([hdr(5,1),0,ks.hash,...enc]);
  const r=M.mcDecode(pkt,['AAAAAAAAAAAAAAAAAAAAAA==']);
  eq('wrong psk -> encrypted',r.encrypted,true); }

// транспортный маршрут (4 служебных байта transport codes) + direct, 1 хоп в пути, тип TXT_MSG — нужен ключ получателя, не читается
{ const pkt=Uint8Array.from([hdr(2,3),0x34,0x12,0,0,(1<<6)|1,0xaa,1,2,3,4,5,6]);
  const r=M.mcDecode(pkt,[M.MC_PUBLIC_PSK]);
  eq('transport route',r.route,'transport direct'); eq('hop count',r.hopCount,1); eq('undecoded without peer key',!!r.undecoded,true); }

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
