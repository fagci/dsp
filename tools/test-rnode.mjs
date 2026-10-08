// KISS RNode и пакеты Reticulum: node tools/test-rnode.mjs
// Кадры собраны по RNode_Firmware/Framing.h, RNodeInterface.py и RNS/Packet.py, не сняты с реального RNode.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const ctx=vm.createContext({Math,Uint8Array,Object,Array,Error,TextDecoder,TextEncoder,String,parseInt,RegExp});
vm.runInContext(fs.readFileSync(path.join(root,'modules/rnode-kernels.js'),'utf8')+';this.R={RN,kissFrame,rnDetect,rnConfig,rnData,rnStream,rnPush,rnEvent,rnsParse,rnsAnnounce,mpRead};',ctx);
const R=ctx.R;
let bad=0; const eq=(n,a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)){ bad++; console.log('FAIL',n,JSON.stringify(a),'!=',JSON.stringify(b)); } else console.log('ok  ',n); };
const arr=u=>[...u];

// команды как в initRadio
const cfg=R.rnConfig({freq:867200000,bw:125000,txp:7,sf:8,cr:5});
eq('freq bytes',arr(cfg[0]),[0xC0,0x01,...[867200000>>>24,(867200000>>>16)&255,(867200000>>>8)&255,867200000&255],0xC0]);
eq('bw bytes',arr(cfg[1]),[0xC0,0x02,0x00,0x01,0xE8,0x48,0xC0]);
eq('txp',arr(cfg[2]),[0xC0,0x03,7,0xC0]); eq('sf',arr(cfg[3]),[0xC0,0x04,8,0xC0]); eq('cr',arr(cfg[4]),[0xC0,0x05,5,0xC0]);
eq('radio on',arr(cfg[5]),[0xC0,0x06,1,0xC0]);
eq('detect',arr(R.rnDetect()),[0xC0,0x08,0x73,0xC0,0xC0,0x50,0x00,0xC0,0xC0,0x48,0x00,0xC0,0xC0,0x49,0x00,0xC0]);
// экранирование данных: C0 и DB внутри кадра
eq('escape',arr(R.rnData(Uint8Array.from([1,0xC0,2,0xDB,3]))),[0xC0,0,1,0xDB,0xDC,2,0xDB,0xDD,3,0xC0]);

// поток от RNode: RSSI, SNR, данные (с экранированием), приходят кусками
const rssi=Uint8Array.from([0xC0,0x23,100,0xC0]), snr=Uint8Array.from([0xC0,0x24,0xF6,0xC0]);   // 100-157=-57 dBm, 0xF6=-10 → -2.5 дБ
const payload=Uint8Array.from([0x10,0xC0,0xDB,0x55]);
const wire=Uint8Array.from([0xAA,...rssi,...snr,...R.rnData(payload),0xC0,0x0F,0x01,0xC0]);
const st=R.rnStream(); let frames=[];
for(let i=0;i<wire.length;i+=3) frames.push(...R.rnPush(st,wire.slice(i,i+3)));
const ev=frames.map(R.rnEvent);
eq('frames count',frames.length,4);
eq('rssi',ev[0].rssi,-57); eq('snr',ev[1].snr,-2.5); eq('data unescaped',arr(ev[2].data),arr(payload));
eq('ready cmd',frames[3].cmd,0x0F);
// статус
const evf=(cmd,...d)=>R.rnEvent({cmd,data:Uint8Array.from(d)});
eq('freq report',evf(0x01,0x33,0xB0,0x6C,0x00).freq,867200000);
eq('bw report',evf(0x02,0,1,0xE8,0x48).bw,125000);
eq('fw',evf(0x50,1,74).fw,'1.74'); eq('detect resp',evf(0x08,0x46).detected,true); eq('detect other',evf(0x08,0).detected,false);
eq('battery',evf(0x27,2,150).battery,100); eq('temp',evf(0x29,150).temp,30); eq('temp invalid',evf(0x29,0).temp,undefined);
eq('error',evf(0x90,2).err,'transmit failed'); eq('platform',evf(0x48,0x80).platform,'ESP32');
eq('chtm noise',evf(0x25,0,50,0,100,0,10,0,20,157,117,255).noise,-40);

// Reticulum
const hexb=s=>Uint8Array.from(s.match(/../g).map(h=>parseInt(h,16)));
const dst='0123456789abcdef0123456789abcdef';
const pk=new Array(64).fill(7), nh=Array.from(hexb('6ec60bc318e2c0f0d908')), t=1700000000;
const rnd=[1,2,3,4,5,Math.floor(t/4294967296),(t>>>24)&255,(t>>>16)&255,(t>>>8)&255,t&255], sig=new Array(64).fill(9);
const mp=[0x92,0xc4,5,...Buffer.from('Alice'),0x08];     // ["Alice"(bin), 8]
const ann=Uint8Array.from([0x01,3,...hexb(dst),0x00,...pk,...nh,...rnd,...sig,...mp]);   // flags: header1, broadcast, single, announce
let p=R.rnsParse(ann);
eq('rns type',p.typeName,'announce'); eq('rns dest',p.dest,dst); eq('rns hops',p.hops,3); eq('rns dest type',p.destName,'single'); eq('rns ctx',p.contextName,'none');
let a=R.rnsAnnounce(p);
eq('announce name',a.name,'lxmf.delivery'); eq('announce time',a.time,t); eq('announce app',a.appName,'Alice'); eq('announce ratchet',a.ratchet,false);
// с ratchet: флаг контекста (бит 5)
const ann2=Uint8Array.from([0x21,0,...hexb(dst),0x00,...pk,...nh,...rnd,...new Array(32).fill(5),...sig,...mp]);
a=R.rnsAnnounce(R.rnsParse(ann2)); eq('ratchet announce',[a.ratchet,a.appName,a.time],[true,'Alice',t]);
// Nomad-узел: app_data — текст
const ann3=Uint8Array.from([0x01,0,...hexb(dst),0x00,...pk,...hexb('213e6311bcec54ab4fde'),...rnd,...sig,...Buffer.from('My Node')]);
a=R.rnsAnnounce(R.rnsParse(ann3)); eq('nomad name',[a.name,a.appName],['nomadnetwork.node','My Node']);
// HEADER_2 (транспорт) и обычные данные
const h2=Uint8Array.from([0x50|0x00,2,...hexb('ffeeddccbbaa99887766554433221100'),...hexb(dst),0x00,1,2,3]);
p=R.rnsParse(h2); eq('header2 transport',[p.headerType,p.transportId,p.dest,p.data.length],[1,'ffeeddccbbaa99887766554433221100',dst,3]);
eq('data not announce',R.rnsAnnounce(R.rnsParse(Uint8Array.from([0x00,0,...hexb(dst),0,1,2,3]))),null);
eq('ifac flagged',R.rnsParse(Uint8Array.from([0x81,0,...hexb(dst),0,1,2,3])).ifac,true);
eq('too short',R.rnsParse(Uint8Array.from([0,0,1])),null);
eq('truncated announce',R.rnsAnnounce(R.rnsParse(Uint8Array.from([0x01,0,...hexb(dst),0,1,2,3]))),null);
console.log(bad?bad+' FAILED':'all passed'); process.exit(bad?1:0);
