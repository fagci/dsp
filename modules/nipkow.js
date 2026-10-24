"use strict";
/* ============================ Диск Нипкова: блоки ============================
   Nipkow Disk: Transmit — картинка (img / vid / тестовая) → звуковой сигнал развёртки диска (level) + синхроимпульс раз в оборот (sync).
   Nipkow Disk: Receive — звуковой сигнал → картинка (img). Синхронизация: pulse, in-band, free (вручную shift / trim) или auto (период по автокорреляции).
   Варианты диска — параметры блоков (строки, спирали, чересстрочность, направление, вид геометрии), их список — в nipkow-kernels.js. */

const NIP_LINES=['16','24','30','32','36','48','50','60','64','90','120'];
function nipGeomParams(syncOpts){
  return [
    {n:'std',t:'select',opts:['custom',...Object.keys(NIP_STD)],d:'Baird 30-line, 12.5 fps',label:'disk: a ready-made variant (fills in the fields below; then edit freely)',
     fn:n=>{ const p=NIP_STD[n.p.std]; if(!p) return; Object.assign(n.p,p); n.nk=null; rebuildNode(n); }},
    {n:'lines',t:'select',opts:NIP_LINES,d:'30',label:'lines per field = holes on one spiral'},
    {n:'spirals',t:'select',opts:['1','2','3','4'],d:'1',label:'spirals = fields per turn of the disk'},
    {n:'interlace',t:'check',d:false,label:'interlace: spirals are shifted by 1/k of the line pitch, a frame is k fields (otherwise every field is a whole picture)'},
    {n:'color',t:'check',d:false,label:'colour: red, green and blue pictures go in turn (a filter wheel), one colour frame = 3 pictures (3 frames when interlaced); the start of the cycle is marked by the sync'},
    {n:'fps',t:'range',min:.5,max:60,step:.1,d:12.5,label:'pictures per second, each colour plane counts (turns per second = fps ÷ spirals; ×60 = rpm for one spiral)'},
    {n:'px',t:'select',opts:['auto','16','24','32','48','64','96','128','192','256'],d:'auto',label:'pixels per line (auto: about 4 samples per pixel; both ends must agree)'},
    {n:'aspect',t:'select',opts:NIP_ASPECTS,d:'3:7',label:'window width : height — sets the inner radius of the spiral'},
    {n:'sweep',t:'select',opts:['outer → inner','inner → outer'],d:'outer → inner',label:'the first line of a field is at the outer or inner edge of the spiral'},
    {n:'rot',t:'select',opts:['cw','ccw'],d:'cw',label:'direction of rotation (mirrors the picture in the disk geometry)'},
    {n:'sync',t:'select',opts:syncOpts,d:'pulse',label:'sync: pulse — separate signal once per turn; in-band — an extra hole before every field, below black; none/free/auto — no sync'},
  ];
}
function nipKey(o){ return [o.lines,o.spirals,o.interlace,o.color,o.fps,o.px,o.aspect,o.sweep,o.rot,o.sync,Eng.sr].join('|'); }
function nipInfo(c){
  return c.N+' lines'+(c.k>1 ? ' × '+c.k+' spirals'+(c.il ? ' interlaced → '+c.R+'-line frame' : '') : '')+' · '+c.fps+' fps'+(c.color ? ' (RGB in turn: '+(c.fps/3).toFixed(1)+' colour frames/s)' : '')+' · '+(c.revRate*60).toFixed(c.revRate*60%1?1:0)+' rpm · '+
    c.M+' px/line · '+((c.fieldRate*(c.N+c.S)*c.M)/2000).toFixed(1)+' kHz band · inner radius '+c.rin.toFixed(2);
}

def({ id:'nipkowTx', title:'Nipkow Disk: Transmit', cat:'Video', readout:true,
  kw:'nipkow disk disc mechanical television baird scanning spiral holes line scan video audio transmit',
  ins:[{n:'img',t:'img'},{n:'vid',t:'vid'}], outs:[{n:'level',t:'sig'},{n:'sync',t:'sig'},{n:'rpm',t:'num'}],
  params:[...nipGeomParams(['pulse','in-band','none']),
    {n:'scene',t:'select',opts:['flat','disk'],d:'flat',label:'how the picture is read: flat — lines are straight; disk — along the arcs the holes really draw (the picture comes out bent)'},
    {n:'src',t:'select',opts:['auto','input','test pattern'],d:'auto',label:'picture: auto — input if connected, otherwise the test pattern'},
    {n:'fit',t:'select',opts:['cover','stretch'],d:'cover',label:'picture to the window: crop to its shape, or squeeze'},
    {n:'invert',t:'check',d:false,label:'negative (white = low level)'},
    {n:'amp',t:'range',min:0,max:1,step:.01,d:1,label:'output level'}],
  init:n=>{ n.nk=null; n.ns=null; n.nc=null; n.pk=null; n.vt=0; n.text='no picture'; },
  process(n,I){
    const o=n.p, key=nipKey(o)+'|'+o.scene;
    if(key!==n.nk){ n.nk=key; n.nc=nipCfg(o,Eng.sr); n.nmap=nipSrcMap(n.nc,o.scene==='disk'); n.pix=new Float32Array(n.nc.R*n.nc.M*n.nc.cc); n.pk=null; n.ns=n.ns||nipTxNew(); }
    const c=n.nc, hasVid=!!(I.vid && I.vid.videoWidth), hasImg=!!(I.img && (I.img.data || I.img.buf) && I.img.w);
    const tp=o.src==='test pattern' || (o.src==='auto' && !hasVid && !hasImg);
    const live=!tp && hasVid ? 'vid' : !tp && hasImg ? 'img' : tp ? 'tp' : 'none';
    const now=performance.now();
    const stale=key+'|'+live+'|'+o.invert+'|'+o.fit!==n.pk || (live==='img' && (n.sref!==I.img || n.srev!==I.img.rev)) || (live==='vid' && now-n.vt>50);
    if(stale){
      n.pk=key+'|'+live+'|'+o.invert+'|'+o.fit; n.vt=now;
      let g=null;                                                   // g — список плоскостей [{g,w,h}] (цвет: R, G, B; иначе одна — яркость)
      if(live==='tp'){ const w=128, h=Math.round(128*c.bh/c.bw), tp=nipTestPattern(w,h,c.color); g=(c.color ? [tp.r,tp.g,tp.b] : [tp]).map(a=>({g:a,w,h})); }
      else if(live==='vid'){
        const cw=96, ch=Math.max(8,Math.round(96*c.bh/c.bw)), v=I.vid;
        if(!n.vcv){ n.vcv=document.createElement('canvas'); n.vcx=n.vcv.getContext('2d',{willReadFrequently:true}); }
        if(n.vcv.width!==cw || n.vcv.height!==ch){ n.vcv.width=cw; n.vcv.height=ch; }
        let sx=0, sy=0, sw=v.videoWidth, sh=v.videoHeight;
        if(o.fit==='cover'){ const a=c.bw/c.bh; if(sw/sh>a){ const w2=sh*a; sx=(sw-w2)/2; sw=w2; } else { const h2=sw/a; sy=(sh-h2)/2; sh=h2; } }
        try{ n.vcx.drawImage(v,sx,sy,sw,sh,0,0,cw,ch); const im={w:cw,h:ch,gray:false,data:n.vcx.getImageData(0,0,cw,ch)}; g=(c.color ? [0,1,2] : [-1]).map(k=>nipGray(im,k)); }catch(e){ g=null; }
      }
      else if(live==='img'){ n.sref=I.img; n.srev=I.img.rev; g=(c.color ? [0,1,2] : [-1]).map(k=>nipGray(I.img,k)); if(g[0] && o.fit==='cover') g=g.map(a=>nipCover(a,c.bw/c.bh)); }
      const RM=c.R*c.M;
      if(g && g[0]) for(let i=0;i<c.cc;i++) nipPixels(c,n.nmap,g[i].g,g[i].w,g[i].h,n.pix.subarray(i*RM,(i+1)*RM),o.invert); else n.pix.fill(o.invert?1:0);
    }
    const lv=buf(n,'level'), sy=buf(n,'sync');
    nipTxRun(n.ns,c,Eng.sr,n.pix,lv,sy,BLOCK);
    const a=+o.amp; if(a!==1) for(let i=0;i<BLOCK;i++) lv[i]*=a;
    n.text=nipInfo(c)+' · '+(live==='tp' ? 'test pattern' : live==='vid' ? 'video' : live==='img' ? 'picture' : 'no picture')+' · '+
      (o.scene==='disk' ? 'disk arcs' : 'flat lines')+' · sync '+(c.sk==='pulse' ? 'pulse' : c.sk==='band' ? 'in-band' : 'none');
    return {level:lv,sync:sy,rpm:c.revRate*60}; },
  drawKey:n=>n.text,
  draw(n){ n.el.querySelector('.readout').textContent=n.text; }});

def({ id:'nipkowRx', title:'Nipkow Disk: Receive', cat:'Video', readout:true,
  kw:'nipkow disk disc mechanical television baird scanning spiral holes line scan video audio receive decode demodulate',
  ins:[{n:'level',t:'sig'},{n:'sync',t:'sig'},{n:'trim',t:'num'},{n:'shift',t:'num'}],
  outs:[{n:'img',t:'img'},{n:'lock',t:'num'},{n:'rpm',t:'num'}],
  params:[...nipGeomParams(['pulse','in-band','free','auto']),
    {n:'view',t:'select',opts:['flat','disk'],d:'flat',label:'picture: flat — straight lines; disk — as seen through the disk: lines are arcs of the spiral (a sector)'},
    {n:'size',t:'select',opts:['120','180','240','360','480'],d:'240',label:'output picture width, px (height follows the window shape)'},
    {n:'invert',t:'check',d:false,label:'negative'},
    {n:'auto',t:'check',d:true,label:'auto level: stretch the picture to the full range'},
    {n:'trim',t:'range',min:-30000,max:30000,step:1,d:0,label:'free / auto start: turn period trim, ppm (the picture stops sliding when it matches the transmitter)'},
    {n:'shift',t:'range',min:0,max:1,step:.0005,d:0,label:'picture shift along the field, fraction (needed in free and auto: no sync marks where the field begins)'}],
  init:n=>{ n.nk=null; n.ns=null; n.nc=null; n.tk=null; n.tab=null; n.frame=null; n.rt=0; n.text='no signal'; },
  process(n,I){
    for(const k of ['trim','shift']) if(typeof I[k]==='number') setMod(n,k,I[k]);
    const o=n.p, key=nipKey(o);
    if(key!==n.nk){ n.nk=key; n.nc=nipCfg(o,Eng.sr); n.ns=nipRxNew(n.nc,Eng.sr); n.tk=null; }
    const c=n.nc, st=n.ns, optical=o.view==='disk', W=+o.size||240;
    const tk=key+'|'+optical+'|'+W;
    if(tk!==n.tk){
      n.tk=tk; n.tab=nipViewTab(c,W,optical);
      const fw=n.tab.w, fh=n.tab.h, rev=(n.frame?.rev|0)+1;
      n.frame=c.color ? {data:new ImageData(fw,fh),w:fw,h:fh,gray:false,rev} : {buf:new Float32Array(fw*fh),w:fw,h:fh,gray:true,rev};
      n.pl=c.color ? [0,1,2].map(()=>new Float32Array(fw*fh)) : null; st.dirty=true; st.lv=null; }
    if(I.level) nipRxRun(st,c,Eng.sr,I.level,I.sync||null,BLOCK,{shift:o.shift,trim:o.trim,invert:o.invert});
    const now=performance.now();
    if(st.dirty && now-n.rt>40){
      st.dirty=false; n.rt=now;
      let lv=[0,1];
      if(o.auto){ const l=nipLevels(st.scan); if(!st.lv) st.lv=l; else { st.lv[0]+=.3*(l[0]-st.lv[0]); st.lv[1]+=.3*(l[1]-st.lv[1]); } lv=st.lv; }
      if(!c.color) nipRender(st.scan,n.tab,n.frame.buf,lv[0],lv[1]);
      else {                                                         // три плоскости развёртки → RGB
        const RM=c.R*c.M, d=n.frame.data.data, q=n.tab.w*n.tab.h;
        for(let i=0;i<3;i++) nipRender(st.scan.subarray(i*RM,(i+1)*RM),n.tab,n.pl[i],lv[0],lv[1]);
        for(let j=0;j<q;j++){ d[j*4]=n.pl[0][j]*255; d[j*4+1]=n.pl[1][j]*255; d[j*4+2]=n.pl[2][j]*255; d[j*4+3]=255; } }
      n.frame.rev++; }
    const lock=nipLock(st,c), rpm=60*Eng.sr/st.Pf/c.k;
    n.text=!I.level ? 'no signal' :
      (c.sk==='free' ? 'free-run' : c.sk==='auto' ? (lock ? 'period found' : 'searching period') : lock ? 'locked' : 'searching sync')+' · '+nipInfo(c).replace(/ · inner radius.*/,'')+
      ' · measured '+(60*Eng.sr/st.Pf/c.k).toFixed(1)+' rpm · '+n.frame.w+'×'+n.frame.h+(optical ? ' disk arcs' : ' flat')+' · fields '+st.fields;
    return {img:n.frame,lock,rpm}; },
  drawKey:n=>n.text,
  draw(n){ n.el.querySelector('.readout').textContent=n.text; }});
