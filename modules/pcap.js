"use strict";
/* ============================ PCAP Reader / Writer ============================
   Reader: bin (файл .pcap / .pcapng, например из File → Bytes) → записи rec с полем hex и hexSchema (для HEX Structure / Table).
   Writer: записи rec с hex (Wi-Fi Sniffer, декодеры, HEX Structure) и bin → файл .pcap на выходе bin (→ Bytes → File).
   Ядро — pcap-kernels.js. */

const pcapObj=(d,name)=>typeof binObj==='function' ? binObj(d,name||'','application/vnd.tcpdump.pcap') : {d,name:name||'',mime:'',id:Date.now()};

def({ id:'pcapRead', title:'PCAP Reader', cat:'Data', kw:'pcap pcapng capture wireshark packets file read import tcpdump', readout:true,
  ins:[{n:'bin',t:'bin'},{n:'go',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'count',t:'num'},{n:'link',t:'num'}],
  params:[{n:'rate',t:'range',min:0,max:1000,step:1,d:0,label:'packets per second (0 — all at once)'},
          {n:'max',t:'num',min:1,max:100000,step:1000,d:20000,label:'max packets',adv:true},
          {n:'restart',t:'button',label:'Again',fn:n=>{ n.pos=0; }}],
  init:n=>{ n.last=null; n.pk=[]; n.link=1; n.pos=0; n.acc=0; n.prevGo=0; n.binOut=null; n.text='wire a .pcap file (File → Bytes)'; },
  process(n,I){
    const o=I.bin;
    if(o && o.d && o!==n.last){
      n.last=o;
      try{ const r=pcapRead(o.d,n.p.max); n.pk=r.packets; n.link=r.linktype; n.pos=0; n.text=r.format+' · '+r.packets.length+' packets · link '+r.linktype; }
      catch(e){ n.pk=[]; n.text='⚠ '+e.message; }
    }
    const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    if(rise) n.pos=0;
    let out=null;
    if(n.pos<n.pk.length){
      let take=n.pk.length-n.pos;
      if(n.p.rate>0){ n.acc+=n.p.rate*BLOCK/Eng.sr; take=Math.min(take,Math.floor(n.acc)); n.acc-=take; }
      if(take>0){
        const sch=PCAP_SCHEMA[n.link]||'auto';
        out=[];
        for(let i=0;i<take;i++){
          const p=n.pk[n.pos+i];
          out.push({t:p.t, src:'pcap', kind:'packet', n:n.pos+i+1, len:p.data.length, orig:p.orig, link:p.link, hex:hexToHex(p.data), hexSchema:sch,
            time:new Date(p.t).toISOString(), text:'#'+(n.pos+i+1)+' '+p.data.length+' B'});
        }
        n.pos+=take;
        n.binOut=pcapObj(n.pk[n.pos-1].data,'packet-'+n.pos+'.bin');
        n.text=n.pos+' / '+n.pk.length+' packets · link '+n.link;
      }
    }
    return {rec:out, bin:n.binOut, count:n.pk.length, link:n.link}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; } });

const PCAP_LINKS=['1 Ethernet','105 802.11','127 radiotap + 802.11','101 raw IP'];
def({ id:'pcapWrite', title:'PCAP Writer', cat:'Data', kw:'pcap capture wireshark packets file write export save', readout:true,
  ins:[{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'go',t:'num'}],
  outs:[{n:'bin',t:'bin'},{n:'count',t:'num'}],
  params:[{n:'link',t:'select',opts:PCAP_LINKS,d:'1 Ethernet',label:'link type'},
          {n:'live',t:'check',d:false,label:'send the file after every packet (off — on go / Save)'},
          {n:'max',t:'num',min:1,max:100000,step:1000,d:20000,label:'max packets',adv:true},
          {n:'save',t:'button',label:'Save',fn:n=>{ n.trig=true; }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.pk=[]; n.text='empty'; }}],
  init:n=>{ n.pk=[]; n.lastBin=null; n.lastRec=null; n.trig=false; n.prevGo=0; n.binOut=null; n.text='empty'; },
  process(n,I){
    const add=(d,t)=>{ n.pk.push({t:t||Date.now(), data:d}); if(n.pk.length>n.p.max) n.pk.shift(); n.dirty=true; };
    let rs=I.rec; if(rs && !Array.isArray(rs)) rs=[rs];
    if(rs && rs!==n.lastRec){
      n.lastRec=rs;
      for(const r of rs) if(r && typeof r.hex==='string' && /^[0-9a-f\s]+$/i.test(r.hex)) add(hexFromHex(r.hex),r.t);
    }
    if(I.bin && I.bin.d && I.bin!==n.lastBin){ n.lastBin=I.bin; add(I.bin.d); }
    const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    if((n.trig || rise || (n.p.live && n.dirty)) && n.pk.length){
      n.binOut=pcapObj(pcapWrite(n.pk,parseInt(n.p.link,10)||1),'capture.pcap'); n.dirty=false;
    }
    n.trig=false;
    n.text=n.pk.length+' packets'+(n.binOut ? ' · file '+n.binOut.d.length+' B' : '');
    return {bin:n.binOut, count:n.pk.length}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; } });
