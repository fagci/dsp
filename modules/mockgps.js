"use strict";
/* ============================ Mock GPS: фиктивное местоположение (приложение Android, для разработчика) ============================
   Подставляет координаты вместо настоящего GPS: другие приложения и наш собственный источник gps видят подставленную точку.
   Команды gps.mock.start / gps.mock / gps.mock.stop идут на выход cmd → вход cmd у Phone Control (DSP app). Чтобы это работало, приложение
   DSP надо один раз выбрать в Настройки → Для разработчиков → «Выбрать приложение для фиктивных местоположений» (иначе ответ — permission).
   Источники точки: пины lat / lon / …, одна фиксированная точка, маршрут (строки «lat,lon», GPX, KML) с заданной скоростью или окружность.
   Маршруты и геодезия — mockgps-kernels.js (тест: node tools/test-mockgps.mjs). */

const MG_MODES=['pins','fixed','route','circle'];
const MG_END=['loop','pingpong','stop'];
const MG_PROV={'gps':['gps'],'gps + network':['gps','network'],'gps + network + passive':['gps','network','passive']};
const MG_SAMPLE='55.7539,37.6208\n55.7525,37.6231\n55.7512,37.6177\n55.7531,37.6155\n55.7539,37.6208';
def({ id:'mockgps', title:'Mock GPS (DSP app, developer)', cat:'Sources', readout:true, tall:true, w:320,
  kw:'mock location fake gps spoof developer options test provider route gpx kml simulate position walk drive',
  ins:[{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'alt',t:'num'},{n:'speed',t:'num'},{n:'bearing',t:'num'},{n:'acc',t:'num'},{n:'on',t:'num'},{n:'rec',t:'rec'}],
  outs:[{n:'cmd',t:'rec'},{n:'lat',t:'num'},{n:'lon',t:'num'},{n:'speed',t:'num'},{n:'bearing',t:'num'},{n:'progress',t:'num'},{n:'dist',t:'num'},{n:'active',t:'num'}],
  groups:[{n:'Source'},{n:'Route',open:false},{n:'Output',open:true}],
  params:[
    {n:'enable',t:'check',d:false,label:'send the position to the phone (or the «on» pin)',g:'Output'},
    {n:'mode',t:'select',opts:MG_MODES,d:'route',label:'pins — from the lat / lon pins, fixed — one point, route — walk the route, circle — around the point',g:'Source'},
    {n:'flat',t:'num',d:55.7539,label:'point: latitude (fixed / circle centre)',g:'Source'},
    {n:'flon',t:'num',d:37.6208,label:'point: longitude',g:'Source'},
    {n:'falt',t:'num',d:150,label:'altitude, m',g:'Source'},
    {n:'speed',t:'num',d:1.4,label:'speed, m/s (1.4 — walking, 14 — car; route and circle)',g:'Route'},
    {n:'route',t:'code',plain:true,d:MG_SAMPLE,label:'route: «lat,lon[,alt]» per line, or paste a GPX / KML',g:'Route'},
    {n:'file',t:'file',accept:'.gpx,.kml,.csv,.txt,text/plain,application/gpx+xml',label:'load GPX / KML / CSV',g:'Route',fn:(n,f)=>{ const fr=new FileReader(); fr.onload=()=>{ setMod(n,'route',String(fr.result||'')); n.rt=null; }; fr.readAsText(f); }},
    {n:'end',t:'select',opts:MG_END,d:'loop',label:'at the end of the route',g:'Route'},
    {n:'radius',t:'num',d:200,label:'circle radius, m',g:'Route'},
    {n:'restart',t:'button',label:'Restart the route',fn:n=>{ n.s=0; },g:'Route'},
    {n:'acc',t:'num',d:5,label:'accuracy reported, m',g:'Output'},
    {n:'jitter',t:'range',min:0,max:50,step:.5,d:0,label:'random scatter, m (a real receiver is never perfectly still)',g:'Output'},
    {n:'rate',t:'range',min:.2,max:10,step:.1,d:1,label:'updates per second',g:'Output'},
    {n:'prov',t:'select',opts:Object.keys(MG_PROV),d:'gps',label:'providers to replace',g:'Output'}],
  init:n=>{ n.s=0; n.rt=null; n.rtSrc=null; n.sent=false; n.acc=0; n.last=null; n.reply=''; n.text=''; n.cmdQ=[]; n.angle=0; n.pcount=0; n.lastRec=null; },
  process(n,I){
    const p=n.p, dt=indDt(), want= typeof I.on==='number' ? I.on>.5 : !!p.enable;
    // ответы телефона: что не так с разрешением
    let rs=I.rec; if(rs && !Array.isArray(rs)) rs=[rs];
    if(rs && rs!==n.lastRec){ n.lastRec=rs;
      for(const r of rs) if(r && r.src==='cmd' && /^gps\.mock/.test(String(r.cmd||''))){
        n.reply= r.ok===false || r.ok===0 || r.err ? '⚠ '+(r.msg||r.err||'error')+(r.err==='permission' ? '\n  Settings → Developer options → Select mock location app → DSP' : '') : (r.cmd==='gps.mock.start' ? '✓ provider on ('+(r.providers||'')+')' : n.reply); } }
    const num=k=>typeof I[k]==='number' && isFinite(I[k]) ? I[k] : undefined;
    let pt=null;
    if(p.mode==='pins'){ const la=num('lat'), lo=num('lon'); if(la!==undefined && lo!==undefined) pt={lat:la,lon:lo,alt:num('alt')??null,bearing:num('bearing'),speed:num('speed')}; }
    else if(p.mode==='fixed') pt={lat:+p.flat,lon:+p.flon,alt:+p.falt,bearing:0,speed:0};
    else if(p.mode==='circle'){
      const sp=Math.max(0,+p.speed||0), R=Math.max(1,+p.radius||1), c={lat:+p.flat,lon:+p.flon};
      if(want) n.angle=(n.angle+sp/R*dt)%(2*Math.PI);
      const q=mgDest(c,n.angle/MG_RAD,R);
      pt={lat:q.lat,lon:q.lon,alt:+p.falt,bearing:(n.angle/MG_RAD+90)%360,speed:sp};
      n.prog=n.angle/(2*Math.PI);
    } else {
      if(n.rtSrc!==p.route){ n.rtSrc=p.route; n.rt=mgRoute(mgParseRoute(p.route)); n.s=0; }
      const sp=Math.max(0,num('speed') ?? +p.speed);
      if(want) n.s+=sp*dt;
      const q=n.rt && mgAt(n.rt,n.s,p.end);
      if(q) pt={lat:q.lat,lon:q.lon,alt:q.alt!=null ? q.alt : +p.falt,bearing:q.bearing,speed:q.done ? 0 : sp};
      n.prog= n.rt && n.rt.total>0 ? clamp(p.end==='stop' ? n.s/n.rt.total : (n.s%n.rt.total)/n.rt.total,0,1) : 0;
    }
    if(pt && +p.jitter>0){ const j=mgDest(pt,Math.random()*360,Math.random()*+p.jitter); pt={...pt,lat:j.lat,lon:j.lon}; }
    n.last=pt;
    let cmds=null;
    if(want && !n.sent){ n.sent=true; n.acc=0; cmds=[{cmd:'gps.mock.start',providers:MG_PROV[p.prov]||['gps']}]; }
    if(!want && n.sent){ n.sent=false; cmds=[{cmd:'gps.mock.stop'}]; }
    if(want && pt){
      n.acc-=dt;
      if(n.acc<=0){ n.acc=1/Math.max(.1,+p.rate||1);
        const c={cmd:'gps.mock',lat:+pt.lat.toFixed(7),lon:+pt.lon.toFixed(7),acc:+p.acc||5};
        if(pt.alt!=null && isFinite(pt.alt)) c.alt=+pt.alt.toFixed(1);
        if(pt.speed!=null && isFinite(pt.speed)) c.speed=+pt.speed.toFixed(2);
        if(pt.bearing!=null && isFinite(pt.bearing)) c.bearing=+pt.bearing.toFixed(1);
        (cmds=cmds||[]).push(c); n.pcount++; }
    }
    n.text=(want ? '● sending' : '○ off')+' · '+p.mode+(n.last ? '\n'+n.last.lat.toFixed(6)+', '+n.last.lon.toFixed(6)+(n.last.alt!=null && isFinite(n.last.alt) ? '  '+Math.round(n.last.alt)+' m' : '')+'\nspeed '+(n.last.speed!=null ? (+n.last.speed).toFixed(1) : '—')+' m/s · bearing '+(n.last.bearing!=null ? Math.round(n.last.bearing) : '—')+'°' : '\nno point (wire lat / lon or choose another mode)')+
      (p.mode==='route' ? '\n'+(n.rt ? n.rt.pts.length+' points · '+(n.rt.total/1000).toFixed(2)+' km · '+Math.round((n.prog||0)*100)+' %' : '')+(n.rt && !n.rt.pts.length ? '⚠ no points in the route' : '') : '')+
      (n.pcount ? '\nsent '+n.pcount : '')+(n.reply ? '\n'+n.reply : '');
    const q=n.last;
    return {cmd:cmds,lat:q ? q.lat : null,lon:q ? q.lon : null,speed:q && q.speed!=null ? q.speed : null,bearing:q && q.bearing!=null ? q.bearing : null,progress:n.prog||0,dist:n.rt ? n.rt.total*(n.prog||0) : 0,active:want ? 1 : 0}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; } });
