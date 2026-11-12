"use strict";
/* ============================ NOAA Weather Radio: какой передатчик слушать ============================
   NWR Stations — по округу (код PSSCCC / SSCCC, «TX:Travis», записи SAME и NWS на входе rec) или по координатам находит передатчики
   NOAA Weather Radio: позывной, частоту (162.400–162.550 МГц, каналы WX1–WX7), мощность, место и офис NWS. Выход freq (Гц)
   перестраивает приёмник. Данные — встроенный список NWS (nwr-data.js, без сети); парой к округу → передатчикам идёт передатчик →
   округа (nwr-kernels.js, tools/test-nwr.mjs). */

const nwShow=(n,t)=>{ const r=n.el && n.el.querySelector('.readout'); if(r && r.textContent!==t) r.textContent=t; };
def({ id:'nwrFind', title:'NWR Stations (NOAA Weather Radio)', cat:'Sources', readout:true, tall:true, w:340,
  kw:'noaa weather radio nwr transmitter station frequency 162 wx1 wx7 same county tune',
  ins:[{n:'rec',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'}],
  outs:[{n:'freq',t:'num'},{n:'call',t:'txt'},{n:'text',t:'txt'},{n:'rows',t:'bands'},{n:'count',t:'num'}],
  params:[{n:'area',t:'text',d:'',label:'county: code (PSSCCC / SSCCC) or ST:County (TX:Travis); empty — by the rec wire, then by position'},
          {n:'lat',t:'num',d:0,label:'latitude (0 and 0 — My Position or wires)'},
          {n:'lon',t:'num',d:0,label:'longitude'},
          {n:'count',t:'range',min:1,max:12,step:1,d:5,label:'how many transmitters to show'},
          {n:'up',t:'check',d:true,label:'skip transmitters that are off the air'}],
  init:n=>{ n.rows=[]; n.msg=''; n.key=''; n.from=''; n.recLoc=''; },
  process(n,I){
    for(const r of recList(I.rec)) if(r && r.locations) n.recLoc=String(r.locations);
    const [la,lo]=ndCentre(n,I), p=n.p;
    const hasPos=la!=null && lo!=null, pos=hasPos ? {lat:la,lon:lo} : null;
    const key=[p.area,n.recLoc,la,lo,p.count,p.up].join('|');
    if(key!==n.key){
      n.key=key; let list=[], from='';
      const a=String(p.area||'').trim();
      if(a){
        let code=null; const m=/^([A-Za-z]{2}):(.+)$/.exec(a);
        if(m && typeof wxAreaCode==='function') code=wxAreaCode(m[2],m[1]);
        else if(/^\d{6}$/.test(a)) code=a; else if(/^\d{5}$/.test(a)) code='0'+a;
        if(code){ list=nwrByCounty(code,pos); from=(typeof wxAreaName==='function' ? wxAreaName(code) : code); }
        else from='unknown county «'+a+'»';
      } else if(n.recLoc){
        for(const l of n.recLoc.split(/[\s,;-]+/).filter(x=>/^\d{6}$/.test(x))){ list=nwrByCounty(l,pos); if(list.length){ from=(typeof wxAreaName==='function' ? wxAreaName(l) : l); break; } }
      } else if(hasPos){ list=nwrNearest(la,lo,+p.count,{up:!!p.up}); from='nearest to '+la.toFixed(2)+', '+lo.toFixed(2); }
      else from='no county, no rec, no position — add My Position or type a county';
      if(p.up) list=list.filter(t=>!t.down);
      n.rows=list.slice(0,+p.count).map(t=>({id:'nwr:'+t.call,label:t.call,lat:t.lat,lon:t.lon,dist:t.dist??null,freq:t.freq*1e6,info:nwrLabel(t)+' · '+t.pwr+' W · '+t.wfo.split('|')[0],icon:'📡',color:'#3aa0ff',size:7}));
      n.from=from; n.msg=from;
    }
    const t=n.rows[0];
    return {freq:t ? t.freq : null, call:t ? t.label : null, text:t ? t.info : null, rows:n.rows, count:n.rows.length};
  },
  drawKey:n=>n.key,
  draw(n){ nwShow(n,(n.msg ? n.msg+'\n' : '')+(n.rows.length ? n.rows.map(r=>r.info+(r.dist!=null ? ' · '+r.dist+' km' : '')).join('\n') : 'no transmitter')); }
});
