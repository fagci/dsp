"use strict";
/* ============================ HEX Field Finder ============================
   Копит пакеты (rec с полем hex, bin, text) и ищет в них поля: время, координаты, счётчики, идентификаторы, контрольные суммы,
   текст, случайные (шифрованные) участки. Ядро — hex-scan-kernels.js. Выход rec — кандидаты (для Table и карты), text — заготовка
   схемы JSON для HEX Structure (advanced → own structure). */

def({ id:'hexScan', title:'HEX Field Finder', cat:'Data', kw:'hex bytes packet fields find detect coordinates time lat lon counter checksum heuristic reverse unknown protocol encrypted',
  readout:true, tall:true, resize:true, w:520,
  ins:[{n:'rec',t:'rec'},{n:'bin',t:'bin'},{n:'text',t:'txt'},{n:'go',t:'num'}],
  outs:[{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'count',t:'num'},{n:'found',t:'num'}],
  params:[{n:'group',t:'select',opts:['length','kind + length','all'],d:'length',label:'compare packets of the same'},
          {n:'hexcol',t:'text',d:'hex',label:'hex field in a record (else raw, data)',adv:true},
          {n:'minN',t:'range',min:6,max:200,step:1,d:12,label:'packets needed in a group'},
          {n:'max',t:'num',min:50,max:100000,step:1000,d:5000,label:'packets kept',adv:true},
          {n:'live',t:'check',d:true,label:'analyse while packets arrive (every 2 s)'},
          {n:'run',t:'button',label:'Analyse',fn:n=>{ n.dirty=true; }},
          {n:'copy',t:'button',label:'Copy schema JSON',fn:n=>{ try{ navigator.clipboard.writeText(n.schemaText||''); }catch(e){} }},
          {n:'clr',t:'button',label:'Clear',fn:n=>{ n.pk=[]; n.res=[]; n.dirty=true; n.schemaText=''; n.text='cleared'; }}],
  init:n=>{ n.pk=[]; n.res=[]; n.dirty=false; n.lastRec=null; n.lastBin=null; n.lastText=undefined; n.prevGo=0; n.t=0; n.recOut=null; n.schemaText=''; n.fresh=0; n.text='wire records with a hex field (decoders, Table, PCAP Reader)'; },
  process(n,I){
    const P=n.p, add=(d,t,kind)=>{ n.pk.push({d,t,kind}); if(n.pk.length>P.max) n.pk.shift(); n.fresh++; };
    let rs=I.rec; if(rs && !Array.isArray(rs)) rs=[rs];
    if(rs && rs!==n.lastRec){
      n.lastRec=rs;
      for(const r of rs){
        if(!r) continue;
        const col=[P.hexcol||'hex','raw','data'].find(c=>typeof r[c]==='string' && r[c].length>=2 && r[c].length%2===0 && /^[0-9a-f]+$/i.test(r[c]));
        if(col) add(hexFromHex(r[col]),typeof r.t==='number' ? r.t : undefined,r.kind||'');
      }
    }
    if(I.bin && I.bin.d && I.bin!==n.lastBin){ n.lastBin=I.bin; add(I.bin.d,undefined,''); }
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      for(const line of I.text.split(/[\r\n;]+/)) if(/^\s*([0-9a-f]{2}\s*)+$/i.test(line)) add(hexFromHex(line),undefined,'');
    }
    const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    n.t+=BLOCK/Eng.sr;
    if(rise || (P.live && n.fresh && n.t>2)){ n.dirty=true; }
    let out=null;
    if(n.dirty){
      n.dirty=false; n.t=0; n.fresh=0;
      const pk=n.pk.map(p=>({d:p.d,t:p.t,kind:p.kind}));
      let rows=pk;
      if(P.group==='kind + length'){                    // группа = вид записи + длина: подменяем длину ключом
        const by=new Map();
        for(const p of pk){ const k=p.kind||'-'; if(!by.has(k)) by.set(k,[]); by.get(k).push(p); }
        n.res=[]; for(const [k,v] of by) for(const g of hexScan(v,{minN:P.minN})) { g.group=k+' · '+g.group; n.res.push(g); }
      } else n.res=hexScan(rows,{minN:P.minN,group:P.group==='all' ? 'all' : 'length'});
      const recs=[];
      for(const g of n.res) for(const c of g.candidates.filter(c=>c.score>=.6 && c.kind!=='random' && c.kind!=='const'))
        recs.push({t:Date.now(),src:'HexScan',kind:c.kind,id:g.group+'@'+c.off+'+'+c.w,group:g.group,off:c.off,width:c.w,score:c.score,label:c.label,example:c.example,text:c.kind+' @'+c.off+'+'+c.w+' '+c.label});
      out=recs.length ? recs : null;
      const best=n.res.find(g=>g.candidates.some(c=>c.score>=.6 && !['random','const'].includes(c.kind))) || n.res[0];
      n.schemaText=best ? JSON.stringify(hexScanSchema(best)) : '';
      n.found=recs.length;
      const L=[n.pk.length+' packets, '+n.res.length+' group(s)'];
      for(const g of n.res.slice(0,4)){
        L.push('— '+g.group+': '+g.n+' × '+g.len+' B · '+g.verdict);
        for(const c of hexScanPick(g,.5).filter(c=>c.kind!=='const').slice(0,8)) L.push('   @'+c.off+'+'+c.w+' '+c.kind+' '+c.score.toFixed(2)+' '+c.label+(c.example!==undefined ? ' · '+c.example : ''));
      }
      n.text=L.join('\n');
    }
    return {rec:out, text:n.schemaText||null, count:n.pk.length, found:n.found||0}; },
  draw(n){ const r=n.el.querySelector('.readout'); if(r && r.textContent!==n.text) r.textContent=n.text; } });
