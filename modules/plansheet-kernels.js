"use strict";
/* ============================ Plan Editor: лист чертежа и спецификация ============================
   pcSheet(s,opt) — SVG листа A4 / A3 (мм): рамка, план в стандартном масштабе (сам подбирается, 1:20 … 1:1000) с размерами стен и общими размерами,
   трассы и устройства систем (электрика, отопление, вентиляция), экспликация комнат (площадь, объём, температура, теплопотери, воздух),
   спецификация оборудования и основная надпись (проект, адрес, автор, дата, масштаб, этаж).
   pcSpec(s,calc) — те же данные таблицей; pcSpecCsv — CSV. Грузится после plancheck-kernels.js (peSVG, peBounds, peElecStats, hvCalc, hvStats…).
   Ядро чистое, без DOM: node tools/test-plansheet.mjs */

const PS_PAPER={A4:[297,210],A3:[420,297]};
const PS_SCALES=[20,25,50,75,100,150,200,250,500,1000];
const psEsc=t=>String(t).replace(/[<&>"]/g,c=>'&#'+c.charCodeAt(0)+';');

// сцена одного этажа: стены, комнаты, проёмы и устройства только его высот (idx — число; 'all' / null — как есть)
function pcLevelScene(s,idx){ if(idx==='all'||idx==null||!(s.levels||[]).length) return s; const k=+idx, f=lv=>(lv||0)===k, ok=z=>peOnLevel(s,String(k),z||0,false);
  const walls=s.walls.filter(w=>f(w.lv)), ids=new Set(walls.map(w=>w.id)); const keepPt=new Set(); for(const w of walls){ keepPt.add(w.a); keepPt.add(w.b); }
  const rooms=s.rooms.filter(r=>f(r.lv)); for(const r of rooms) for(const id of r.pts) keepPt.add(id);
  return {...s,walls,rooms,pts:s.pts.filter(p=>keepPt.has(p.id)),objs:s.objs.filter(o=>o.wall ? ids.has(o.wall) : ok(o.z)),elec:(s.elec||[]).filter(e=>ok(e.z)),hv:(s.hv||[]).filter(e=>ok(e.z)),
    wires:(s.wires||[]).filter(w=>{ const A=peElOf(s,w.a); return A && ok(A.z); }),pp:(s.pp||[]).filter(l=>{ const A=hvDev(s,l.a); return A && ok(A.z); }),cams:s.cams.filter(c=>ok(c.z)),ants:s.ants.filter(a=>ok(a.z))}; }

// спецификация: комнаты (экспликация) и оборудование по системам
function pcSpec(s,calc,ld){ const C=calc||(s.rooms.length ? hvCalc(s,{}) : null), rooms=(C ? C.rooms : s.rooms.map(r=>({name:r.name||r.id,use:'',area:peRoomArea(s,r),vol:0,tin:0,loss:0,air:0,dir:'',norm:0}))), items=[];
  const E=peElecStats(s), NM={socket:'sockets',switch:'switches',light:'lights',panel:'panels',inlet:'inlets',junction:'junction boxes',load:'loads'};
  for(const k of Object.keys(NM)) if(E.n[k]){ const w=(s.elec||[]).filter(e=>e.type===k).reduce((a,e)=>a+(+e.watt||0),0); items.push({group:'electrics',name:NM[k],qty:E.n[k],note:w>0 ? Math.round(w)+' W' : ''}); }
  for(const [c,L] of Object.entries(E.cables).sort()) items.push({group:'electrics',name:'cable '+c,qty:+L.toFixed(1),unit:'m',note:'with a 10% reserve'});
  const hv=s.hv||[], by=t=>hv.filter(d=>d.type===t);
  if(by('boiler').length) items.push({group:'heating',name:'boiler',qty:by('boiler').length,note:Math.round(by('boiler').reduce((a,d)=>a+(+d.watt||0),0))+' W'});
  if(by('radiator').length) items.push({group:'heating',name:'radiators (rated at ΔT 50 K)',qty:by('radiator').length,note:Math.round(by('radiator').reduce((a,d)=>a+(+d.watt||0),0))+' W'});
  if(by('floor').length) items.push({group:'heating',name:'underfloor loops',qty:by('floor').length,note:by('floor').reduce((a,d)=>a+(+d.area||0),0).toFixed(1)+' m²'});
  if(by('heater').length) items.push({group:'heating',name:'local heaters',qty:by('heater').length,note:Math.round(by('heater').reduce((a,d)=>a+(+d.watt||0),0))+' W'});
  if(by('manifold').length) items.push({group:'heating',name:'manifolds',qty:by('manifold').length});
  if(by('tee').length) items.push({group:'heating',name:'tees',qty:by('tee').length});
  const pipe={}, duct={}; let pipeFree=0, ductFree=0;
  if(C){ for(const g of C.heat.segs) pipe[g.dn]=(pipe[g.dn]||0)+g.len*2; for(const g of C.air.segs) duct[g.d]=(duct[g.d]||0)+g.len; }
  const seenL=new Set(C ? [...C.heat.segs.map(g=>g.link),...C.air.segs.map(g=>g.link)] : []); for(const l of s.pp||[]) if(!seenL.has(l.id)){ const L=hvLinkLen(s,l).len; if(hvLinkKind(s,l)==='pipe') pipeFree+=L*2; else ductFree+=L; }
  for(const [d,L] of Object.entries(pipe).sort((a,b)=>a[0]-b[0])) items.push({group:'heating',name:'pipe DN'+d+' (supply + return)',qty:+L.toFixed(1),unit:'m'});
  if(pipeFree>0) items.push({group:'heating',name:'pipes not connected to a boiler',qty:+pipeFree.toFixed(1),unit:'m'});
  for(const [t,nm] of [['ahu','supply-extract units'],['fan','fans'],['supply','supply terminals'],['extract','extract grilles']]) if(by(t).length) items.push({group:'ventilation',name:nm,qty:by(t).length,note:t==='ahu'||t==='fan' ? Math.round(by(t).reduce((a,d)=>a+(+d.m3||0),0))+' m³/h' : ''});
  for(const [d,L] of Object.entries(duct).sort((a,b)=>a[0]-b[0])) items.push({group:'ventilation',name:'duct Ø'+d,qty:+L.toFixed(1),unit:'m'});
  if(ductFree>0) items.push({group:'ventilation',name:'ducts not connected to a unit',qty:+ductFree.toFixed(1),unit:'m'});
  if(ld){ const I=(name,qty,unit,note)=>items.push({group:'structure',name,qty:+(+qty).toFixed(unit==='m³' ? 1 : 0),unit:unit||'pcs',note:note||''});
    if(ld.house.strip>0) I('strip footing concrete',ld.house.strip,'m³','depth '+ld.house.depth+' m, widths '+(ld.foundation.length ? Math.min(...ld.foundation.map(f=>f.b)).toFixed(2)+'…'+Math.max(...ld.foundation.map(f=>f.b)).toFixed(2)+' m' : ''));
    const by={}; for(const l of ld.lintels) if(l.ibeam) by[l.ibeam]=(by[l.ibeam]||0)+l.n; for(const [no,n] of Object.entries(by).sort((a,b)=>a[0]-b[0])) I('I-beam No. '+no+' (lintels)',n,'pcs','bearing 0.15 m each side');
    for(const f of ld.floors) if(f.As) I('slab over '+f.room+': A500 reinforcement',f.As,'cm²/m','t '+(f.t*100).toFixed(0)+' cm'); }
  if(typeof fenceItems==='function') items.push(...fenceItems(s));
  return {rooms,items,calc:C}; }
function pcSpecCsv(s,calc,ld){ const S=pcSpec(s,calc,ld), q=v=>/[",;\n]/.test(String(v)) ? '"'+String(v).replace(/"/g,'""')+'"' : String(v), out=['section,name,use,area_m2,volume_m3,temp_C,heat_loss_W,air_m3h'];
  for(const r of S.rooms) out.push(['room',r.name,r.use,(+r.area).toFixed(2),(+r.vol||0).toFixed(2),r.tin||'',Math.round(r.loss||0),Math.round(r.air||0)].map(q).join(','));
  out.push('','section,group,name,quantity,unit,note'); for(const i of S.items) out.push(['item',i.group,i.name,i.qty,i.unit||'pcs',i.note||''].map(q).join(','));
  return out.join('\n'); }

// лист
function pcSheet(s,opt={}){
  const paper=PS_PAPER[opt.paper]||PS_PAPER.A3, [W,H]=paper, lvl=opt.level, S=pcLevelScene(s,lvl), pj=opt.proj||{}, calc=opt.calc===undefined ? (S.rooms.length ? hvCalc(S,opt.hvopt||{}) : null) : opt.calc;
  const b=peBounds(S,.8); if(!b) return '';
  const left=20, top=5, right=5, bot=5, tabW=96, gap=5, areaW=W-left-right-tabW-gap, areaH=H-top-bot, pw=b.x1-b.x0, ph=b.y1-b.y0;
  let sc=opt.scale>0 ? opt.scale : PS_SCALES.find(v=>pw*1000/v<=areaW-4 && ph*1000/v<=areaH-14) || 1000;
  const k=1000/sc, w=pw*k, h=ph*k, ox=left+(areaW-w)/2, oy=top+(areaH-h)/2, o=[];
  o.push('<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'mm" height="'+H+'mm" viewBox="0 0 '+W+' '+H+'" font-family="sans-serif">','<rect width="'+W+'" height="'+H+'" fill="#fff"/>',
    '<rect x="'+left+'" y="'+top+'" width="'+(W-left-right)+'" height="'+(H-top-bot)+'" fill="none" stroke="#000" stroke-width=".5"/>');
  // план: вложенный svg peSVG (метры, y вниз) + трассы и устройства систем
  let plan=peSVG(S,{scale:sc,dims:true,north:opt.north}); const vb=(plan.match(/viewBox="([^"]+)"/)||[])[1]||'0 0 1 1';
  const T=(x,y)=>(+x).toFixed(3)+','+(-y).toFixed(3), L=[];
  const el=id=>peElOf(S,id), line=(P,col,sw,dash)=>L.push('<polyline points="'+P.map(q=>T(q[0],q[1])).join(' ')+'" fill="none" stroke="'+col+'" stroke-width="'+sw+'"'+(dash ? ' stroke-dasharray="'+dash+'"' : '')+'/>');
  if(opt.systems!==false){
    for(const wr of S.wires||[]){ const pa=peWirePath(S,wr); if(pa) line(pa.map(q=>[q[0],q[1]]),'#ef8a3a',.02,'.08 .05'); }
    for(const l of S.pp||[]){ const pa=hvLinkPath(S,l); if(pa) line(pa.map(q=>[q[0],q[1]]),hvLinkKind(S,l)==='duct' ? '#2a8ad8' : '#d32f2f',hvLinkKind(S,l)==='duct' ? .035 : .025,hvLinkKind(S,l)==='duct' ? '.12 .05' : ''); }
    const COL={socket:'#ef8a3a',switch:'#ef8a3a',light:'#c9a100',panel:'#2e7d32',inlet:'#c62828',junction:'#777',load:'#8e24aa'}, sym=(x,y,col,txt)=>{ L.push('<circle cx="'+(+x).toFixed(3)+'" cy="'+(-y).toFixed(3)+'" r=".09" fill="#fff" stroke="'+col+'" stroke-width=".03"/>'); if(txt) L.push('<text x="'+(+x).toFixed(3)+'" y="'+(-y+.045).toFixed(3)+'" font-size=".11" text-anchor="middle" fill="'+col+'">'+psEsc(txt)+'</text>'); };
    for(const e of S.elec||[]) sym(e.x,e.y,COL[e.type]||'#555',e.type[0].toUpperCase());
    const HC={boiler:'#d32f2f',radiator:'#e64a19',floor:'#f57c00',heater:'#f9a825',manifold:'#8d6e63',tee:'#ef5350',ahu:'#00838f',fan:'#00acc1',supply:'#0288d1',extract:'#6a1b9a'}, HL={boiler:'B',radiator:'R',floor:'F',heater:'H',manifold:'M',tee:'',ahu:'U',fan:'V',supply:'+',extract:'−'};
    for(const d of S.hv||[]) sym(d.x,d.y,HC[d.type]||'#555',HL[d.type]);
    for(const d of S.hv||[]) L.push('<text x="'+(d.x+.12).toFixed(3)+'" y="'+(-d.y-.1).toFixed(3)+'" font-size=".13" fill="'+(HC[d.type]||'#555')+'">'+psEsc(d.name)+'</text>');
  }
  // общие размеры: вдоль низа и слева по габаритам стен
  { const X=S.walls.flatMap(w=>peWallEnds(S,w).filter(Boolean).map(p=>p.x)), Y=S.walls.flatMap(w=>peWallEnds(S,w).filter(Boolean).map(p=>p.y));
    if(X.length){ const x0=Math.min(...X), x1=Math.max(...X), y0=Math.min(...Y), y1=Math.max(...Y), dy=y0-.5, dx=x0-.5, tk=(a,c,d,e)=>L.push('<line x1="'+a+'" y1="'+c+'" x2="'+d+'" y2="'+e+'" stroke="#000" stroke-width=".02"/>');
      tk(x0,-dy,x1,-dy); tk(x0,-dy-.08,x0,-dy+.08); tk(x1,-dy-.08,x1,-dy+.08); L.push('<text x="'+((x0+x1)/2).toFixed(3)+'" y="'+(-dy-.1).toFixed(3)+'" font-size=".2" text-anchor="middle">'+(x1-x0).toFixed(2)+'</text>');
      tk(dx,-y0,dx,-y1); tk(dx-.08,-y0,dx+.08,-y0); tk(dx-.08,-y1,dx+.08,-y1); L.push('<text transform="translate('+(dx-.1).toFixed(3)+','+(-(y0+y1)/2).toFixed(3)+') rotate(-90)" font-size=".2" text-anchor="middle">'+(y1-y0).toFixed(2)+'</text>'); } }
  plan=plan.replace(/<svg [^>]*>/,'<svg x="'+ox.toFixed(2)+'" y="'+oy.toFixed(2)+'" width="'+w.toFixed(2)+'" height="'+h.toFixed(2)+'" viewBox="'+vb+'">').replace(/<\/svg>\s*$/,L.join('\n')+'\n</svg>');
  o.push(plan);
  // таблицы справа: экспликация, спецификация, основная надпись
  const Sp=pcSpec(S,calc,opt.ld), tx=W-right-tabW+2, fs=2.6, lh=3.6; let y=top+6;
  const text=(x,yy,t,o2={})=>'<text x="'+x.toFixed(2)+'" y="'+yy.toFixed(2)+'" font-size="'+(o2.size||fs)+'"'+(o2.bold ? ' font-weight="bold"' : '')+(o2.anchor ? ' text-anchor="'+o2.anchor+'"' : '')+(o2.fill ? ' fill="'+o2.fill+'"' : '')+'>'+psEsc(t)+'</text>';
  const cols=[[0,'№'],[6,'room'],[32,'m²'],[42,'t °C'],[54,'W'],[68,'m³/h']];
  o.push(text(tx,y,'Room explication',{bold:true,size:3})); y+=lh; for(const [cx,t] of cols) o.push(text(tx+cx,y,t,{bold:true,fill:'#555'})); y+=1; o.push('<line x1="'+tx+'" y1="'+y+'" x2="'+(tx+tabW-4)+'" y2="'+y+'" stroke="#000" stroke-width=".2"/>'); y+=lh-1;
  const maxRows=Math.floor((H-top-bot-70-y)/lh)-6;
  Sp.rooms.slice(0,Math.max(3,maxRows)).forEach((r,i)=>{ const v=[String(i+1),String(r.name).slice(0,14),(+r.area).toFixed(1),r.tin||'',r.loss ? Math.round(r.loss) : '',r.air ? Math.round(r.air)+(r.dir==='supply' ? '↓' : r.dir==='extract' ? '↑' : '') : '']; cols.forEach(([cx],j)=>o.push(text(tx+cx,y,v[j]))); y+=lh; });
  if(Sp.rooms.length>Math.max(3,maxRows)){ o.push(text(tx,y,'… +'+(Sp.rooms.length-Math.max(3,maxRows))+' more',{fill:'#777'})); y+=lh; }
  const A=Sp.rooms.reduce((a,r)=>a+(+r.area||0),0), Q=Sp.rooms.reduce((a,r)=>a+(r.loss||0),0); o.push('<line x1="'+tx+'" y1="'+(y-lh+1)+'" x2="'+(tx+tabW-4)+'" y2="'+(y-lh+1)+'" stroke="#000" stroke-width=".1"/>'); o.push(text(tx+6,y,'total',{bold:true}),text(tx+32,y,A.toFixed(1),{bold:true}),text(tx+54,y,Q ? String(Math.round(Q)) : '',{bold:true})); y+=lh*1.8;
  if(Sp.items.length){ o.push(text(tx,y,'Equipment and materials',{bold:true,size:3})); y+=lh; let g=''; const lim=Math.floor((H-top-bot-48-y)/lh);
    Sp.items.slice(0,Math.max(4,lim)).forEach(it=>{ if(it.group!==g){ g=it.group; o.push(text(tx,y,g,{bold:true,fill:'#555'})); y+=lh; } o.push(text(tx+2,y,String(it.name).slice(0,38)),text(tx+tabW-4,y,it.qty+(it.unit ? ' '+it.unit : '')+(it.note ? ' · '+it.note : ''),{anchor:'end'})); y+=lh; }); }
  // основная надпись
  const bx=W-right-tabW, by=H-bot-40, rows=[['project',pj.name||''],['address',pj.addr||''],['drawn by',pj.by||''],['date',pj.date||''],['scale','1:'+sc],['floor',lvl==null||lvl==='all' ? 'all' : peLvName(+lvl)]];
  o.push('<rect x="'+bx+'" y="'+by+'" width="'+tabW+'" height="40" fill="none" stroke="#000" stroke-width=".5"/>'); rows.forEach(([a,v],i)=>{ const yy=by+6.2+i*6; o.push('<line x1="'+bx+'" y1="'+(yy-4.2)+'" x2="'+(bx+tabW)+'" y2="'+(yy-4.2)+'" stroke="#000" stroke-width=".15"/>',text(bx+2,yy,a,{fill:'#666',size:2.3}),text(bx+24,yy,v,{size:i===0 ? 3.4 : 2.8,bold:i===0})); });
  o.push('</svg>'); return o.join('\n'); }
