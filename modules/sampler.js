/* ============================ СЕМПЛЕР ============================ */
// Полифонический семплер клипа из Sample Library: входы freq/gate/vel ×4 — те же, что у Synth (4 voices),
// пиано-ролла и Tracker Instrument. Высота — отношение freq к корневой ноте клипа.
let SamplerClips = [];                           // 'id: имя' всех клипов библиотеки, для списка выбора
async function samplerScan(){
  const out = [], walk = async (fid, path)=>{
    for(const c of await SampleDB.listClips(fid)) out.push(c.id+': '+path+c.name);
    for(const f of await SampleDB.listFolders(fid)) await walk(f.id, path+f.name+'/');
  };
  try{ await walk(null, ''); }catch(e){ console.warn('sampler:', e); }
  SamplerClips = out;
  for(const n of Graph.nodes) if(n.type==='sampler') n.set?.clip?.();
}
async function samplerLoad(n){
  const id = parseInt(n.p.clip);
  n.data = null; n.status = id ? 'loading…' : 'pick a clip from the Sample Library';
  if(!id) return;
  const want = n.p.clip;
  const c = await SampleDB.getClip(id).catch(()=>null);
  if(n.p.clip!==want) return;
  if(!c){ n.status = 'clip not found'; return; }
  n.data = c.samples; n.dataSr = c.sr; n.status = c.name+' · '+(c.samples.length/c.sr).toFixed(2)+' s';
  redraw(n);
}
const SAMPLER_INS = [];
for(let k=1;k<=4;k++){ const s = k>1 ? k : ''; SAMPLER_INS.push({n:'freq'+s,t:'num'},{n:'gate'+s,t:'sig'},{n:'vel'+s,t:'num'}); }
def({ id:'sampler', lazy:'manual', title:'Sampler', cat:'Music', readout:true,
  ins:SAMPLER_INS,
  outs:[{n:'out',t:'sig'},{n:'L',t:'sig'},{n:'R',t:'sig'}],
  params:[
    {n:'clip',t:'select',d:'',label:'clip',
     opts:n=>{ const o = ['', ...SamplerClips]; if(n.p.clip && !o.includes(n.p.clip)) o.push(n.p.clip); return o; },
     fn:n=>samplerLoad(n)},
    {n:'rescan',t:'button',label:'↻ library',fn:()=>samplerScan()},
    {n:'root',t:'num',d:60,label:'root note (MIDI)'},
    {n:'loop',t:'check',d:false,label:'loop'},
    {n:'attack',t:'range',min:.001,max:2,step:.001,d:.002,log:true,label:'A'},
    {n:'release',t:'range',min:.005,max:5,step:.001,d:.15,log:true,label:'R'},
    {n:'gain',t:'range',min:0,max:2,step:.01,d:.8},
    {n:'spread',t:'range',min:0,max:1,step:.01,d:.4,label:'stereo spread'}],
  init:n=>{
    n.v = [0,1,2,3].map(()=>({pos:0, lvl:0, on:false, pv:0, rel:0}));
    n.data = null; n.dataSr = 48000; n.status = '';
    if(!SamplerClips.length) samplerScan();
    samplerLoad(n);
  },
  drawKey:n=>n.status,
  process(n,I){
    const o = buf(n,'out'), oL = buf(n,'L'), oR = buf(n,'R'), p = n.p, sr = Eng.sr, d = n.data;
    o.fill(0); oL.fill(0); oR.fill(0);
    if(!d || !d.length) return {out:o, L:oL, R:oR};
    const rootF = 440*Math.pow(2, ((+p.root||60)-69)/12), len = d.length;
    const aK = 1/(p.attack*sr), pans = [-1,-1/3,1/3,1].map(x=>x*p.spread);
    for(let k=0;k<4;k++){
      const s = k ? k+1 : '', g = I['gate'+s], vs = n.v[k];
      if(!g && !vs.on && vs.lvl<=0) continue;
      const f = typeof I['freq'+s]==='number' ? I['freq'+s] : rootF;
      const vel = typeof I['vel'+s]==='number' ? I['vel'+s] : 1;
      const step = f/rootF*n.dataSr/sr, ang = (pans[k]+1)*Math.PI/4, gl = Math.cos(ang), gr = Math.sin(ang);
      for(let i=0;i<BLOCK;i++){
        const gv = g ? g[i] : 0;
        if(gv>0 && vs.pv<=0){ vs.on = true; vs.pos = 0; vs.lvl = 0; }             // новая нота — с начала клипа
        else if(gv<=0 && vs.pv>0){ vs.on = false; vs.rel = vs.lvl/(p.release*sr); }
        vs.pv = gv;
        if(vs.on) vs.lvl = Math.min(1, vs.lvl+aK);
        else if(vs.lvl>0) vs.lvl = Math.max(0, vs.lvl-vs.rel);
        else continue;
        if(vs.pos>=len-1){ if(p.loop) vs.pos %= len-1; else { vs.lvl = 0; vs.on = false; continue; } }
        const i0 = vs.pos|0, fr = vs.pos-i0;
        const x = (d[i0]*(1-fr) + d[i0+1]*fr)*vs.lvl*vel*p.gain;
        o[i] += x; oL[i] += x*gl; oR[i] += x*gr;
        vs.pos += step;
      }
    }
    redrawIf(n, n.v.map(v=>v.lvl>0?1:0).join(''));
    return {out:o, L:oL, R:oR};
  },
  draw(n){
    if(!n.ro) return;
    const act = n.v.filter(v=>v.lvl>0).length;
    n.ro.textContent = (n.status||'') + (n.data ? ' · '+act+'/4 voices' : '');
  }
});
