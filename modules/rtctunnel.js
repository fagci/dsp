"use strict";
/* ============================ WebRTC Tunnel (any protocol) ============================
   Прокидывает записи (rec) между двумя узлами WebRTC Tunnel на двух патчах/телефонах через служебный канал tun
   соединения WebRTC Data (rtcTunChannel, webrtc.js) — он шифрован самим WebRTC (DTLS), без своего ключа. Связь —
   проводом rtc от WebRTC Data (link). Само содержимое — любой протокол графа: например, записи сокета Network (DSP
   app) (open/accept/data/close) с одного телефона в cmd второго — тогда второй телефон открывает настоящее TCP/UDP-
   соединение и шлёт ответы назад тем же путём (пресет «показывает» именно эту пару). Несколько туннелей на одном
   соединении различаются параметром label (как дорожки медиа — своей подписью). */

def({ id:'rtcTunnel', title:'WebRTC Tunnel (any protocol)', cat:'Control',
  kw:'webrtc tunnel vpn relay socket proxy remote network tcp udp bridge p2p phone any protocol',
  ins:[{n:'rtc',t:'rtc'},{n:'rec',t:'rec'}],
  outs:[{n:'rec',t:'rec'},{n:'open',t:'num'},{n:'count',t:'num'}],
  readout:true,
  params:[{n:'label',t:'text',d:'tun',label:'channel name (the same on both sides; several tunnels can share one connection)'}],
  init:n=>{ n.rn=null; n.lastRec=undefined; n.status='not linked'; n.count=0; },
  dispose:n=>{ if(n.rn) rtcTunUnreg(n.rn,n.id); },
  process(n,I){
    const rn=rtcLinked(I.rtc), label=String(n.p.label||'tun');
    if(rn!==n.rn){ if(n.rn) rtcTunUnreg(n.rn,n.id); n.rn=rn; }
    if(rn) rtcTunReg(rn,n.id,label);
    if(I.rec!==n.lastRec){
      n.lastRec=I.rec;
      for(const r of recList(I.rec)) rtcTunSend(rn,label,r);
    }
    let rec=null;
    const reg=rn && rn.tunReg.get(n.id);
    if(reg && reg.q.length){ rec=reg.q.splice(0); n.count+=rec.length; }
    n.status=!rn ? 'not linked (wire WebRTC Data → link to rtc)' : !rn.tunOpen ? 'linked, waiting for the connection' : 'ready — forwarding records («'+label+'»)';
    return {rec, open:rn && rn.tunOpen ? 1 : 0, count:n.count};
  },
  draw(n){ if(n.ro) n.ro.textContent=n.status+(n.count ? ' · '+n.count : ''); }
});
