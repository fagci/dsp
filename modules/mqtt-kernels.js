"use strict";
/* ============================ MQTT 3.1.1: ядро ============================
   Пакеты и разбор потока; транспорт — WebSocket (подпротокол «mqtt»), см. mqtt.js.
   Поддержано: CONNECT (логин, пароль, clean session), PUBLISH QoS 0 / 1 в обе стороны, SUBSCRIBE, PINGREQ, DISCONNECT. */

const MQ={CONNECT:1,CONNACK:2,PUBLISH:3,PUBACK:4,SUBSCRIBE:8,SUBACK:9,PINGREQ:12,PINGRESP:13,DISCONNECT:14};
const mqEnc=new TextEncoder(), mqDec=new TextDecoder();
const mqStr=s=>{ const b=mqEnc.encode(s); const o=new Uint8Array(2+b.length); o[0]=b.length>>8; o[1]=b.length&255; o.set(b,2); return o; };
function mqCat(parts){
  const o=new Uint8Array(parts.reduce((a,p)=>a+p.length,0)); let i=0;
  for(const p of parts){ o.set(p,i); i+=p.length; }
  return o;
}
function mqPacket(type,flags,body){
  const rl=[]; let n=body.length;
  do{ let d=n%128; n=Math.floor(n/128); rl.push(n>0 ? d|128 : d); }while(n>0);
  return mqCat([Uint8Array.of(type<<4|flags,...rl),body]);
}
const mqConnect=(o={})=>{
  const flags=(o.user ? 0x80 : 0)|(o.user && o.pass ? 0x40 : 0)|0x02, ka=o.keepalive||30;
  return mqPacket(MQ.CONNECT,0,mqCat([mqStr('MQTT'),Uint8Array.of(4,flags,ka>>8,ka&255),mqStr(o.clientId||''),
    ...(o.user ? [mqStr(o.user)] : []),...(o.user && o.pass ? [mqStr(o.pass)] : [])]));
};
const mqId=id=>Uint8Array.of(id>>8,id&255);
function mqPublish(topic,payload,o={}){
  const qos=o.qos|0, p=typeof payload==='string' ? mqEnc.encode(payload) : payload;
  return mqPacket(MQ.PUBLISH,(qos<<1)|(o.retain ? 1 : 0),mqCat([mqStr(topic),...(qos ? [mqId(o.id)] : []),p]));
}
const mqSubscribe=(id,filters,qos=0)=>mqPacket(MQ.SUBSCRIBE,2,mqCat([mqId(id),...filters.flatMap(f=>[mqStr(f),Uint8Array.of(qos)])]));
const mqPuback=id=>mqPacket(MQ.PUBACK,0,mqId(id));
const mqPing=()=>mqPacket(MQ.PINGREQ,0,new Uint8Array(0));
const mqDisconnect=()=>mqPacket(MQ.DISCONNECT,0,new Uint8Array(0));

// поток байт → пакеты: {type, topic, payload, qos, retain, id, code, codes}
class MqParser{
  constructor(){ this.b=new Uint8Array(0); }
  push(chunk){
    this.b=mqCat([this.b,new Uint8Array(chunk)]);
    const out=[];
    for(;;){
      const b=this.b; if(b.length<2) break;
      let rl=0, mul=1, i=1, c;
      do{ if(i>=b.length || i>4) { if(i>4) throw new Error('bad MQTT length'); return out; } c=b[i++]; rl+=(c&127)*mul; mul*=128; }while(c&128);
      if(b.length<i+rl) break;
      const body=b.subarray(i,i+rl), type=b[0]>>4, fl=b[0]&15;
      this.b=b.slice(i+rl);
      const p={type};
      if(type===MQ.CONNACK) p.code=body[1];
      else if(type===MQ.PUBLISH){
        const tl=body[0]<<8|body[1]; p.topic=mqDec.decode(body.subarray(2,2+tl)); let k=2+tl;
        p.qos=(fl>>1)&3; p.retain=!!(fl&1);
        if(p.qos){ p.id=body[k]<<8|body[k+1]; k+=2; }
        p.payload=body.slice(k);
      } else if(type===MQ.PUBACK) p.id=body[0]<<8|body[1];
      else if(type===MQ.SUBACK){ p.id=body[0]<<8|body[1]; p.codes=Array.from(body.subarray(2)); }
      out.push(p);
    }
    return out;
  }
}
const MQ_CONNACK_TEXT=['accepted','unacceptable protocol version','client id rejected','server unavailable','bad user name or password','not authorized'];

if(typeof module!=='undefined') module.exports={MQ,MqParser,mqConnect,mqPublish,mqSubscribe,mqPuback,mqPing,mqDisconnect,mqPacket};
