"use strict";
/* ============================ HEX Structure: узел и интерфейс ============================
   bin / text (hex) → разбор по схеме → rec;  rec → сборка по схеме → bin / text.
   Дамп с подсветкой полей, дерево полей, правка байтов и значений. Ядро — hex-kernels.js, схемы — hex-formats.js. */

const HX_MAX_SHOW=4096;                                 // байт в дампе (остальное — только в данных)
const HX_COLORS=8;
const hxObj=(d,name)=>typeof binObj==='function' ? binObj(d,name||'','') : {d,name:name||'',mime:'',id:Date.now()+Math.random()};

// схема узла: из JSON-редактора, если он заполнен, иначе из списка. Возвращает {sch, lib, err}
function hxResolve(n){
  const txt=String(n.p.json||'').trim();
  if(n._jsonSrc===txt && n._jsonRes && n._jsonSel===n.p.schema) return n._jsonRes;
  let res;
  try{
    if(!txt) res={sch:hexSchema(n.p.schema),lib:HEX_LIB,err:''};
    else {
      const j=JSON.parse(txt), lib=Object.create(HEX_LIB);
      let sch=null;
      if(j.fields) sch=j;
      else if(j.lib || j.schemas){ Object.assign(lib,j.lib||j.schemas); sch=lib[j.root||n.p.schema]; if(!sch) throw new Error('"root" is not in "lib"'); }
      else if(typeof j==='object'){ Object.assign(lib,j); sch=lib[n.p.schema] || Object.values(j)[0]; }
      const errs=hexSchemaCheck(sch,lib);
      res={sch,lib,err:errs.slice(0,3).join('; ')};
      if(!sch.fields) throw new Error('no "fields"');
    }
  }catch(e){ res={sch:{fields:[]},lib:HEX_LIB,err:String(e.message||e)}; }
  n._jsonSrc=txt; n._jsonSel=n.p.schema; n._jsonRes=res;
  return res;
}
function hxSetBuf(n,bytes,emit){
  n.buf=bytes; n.dirty=true; if(emit) n.emit=true;
  if(bytes.length<=65536) n.p.hex=hexToHex(bytes);
}
function hxParseNow(n){
  const r=hxResolve(n);
  n.err=r.err;
  n.res=hexParse(r.sch,n.buf,{lib:r.lib});
  n.recOut=hexToRec(n.res);
  n.dirty=false; n.uiDirty=true;
}
// имя поля rec ← колонка: «колонка=поле, …»
function hxMapRec(rec,map){
  const m={}; for(const pair of String(map||'').split(/[,;\n]/)){ const [a,b]=pair.split('=').map(s=>s.trim()); if(a && b) m[a]=b; }
  const o={}; for(const k in rec) o[m[k] || k]=rec[k];
  return o;
}
// собрать пакет: значения текущего пакета, поверх них поля из rec
function hxBuild(n,over){
  const r=hxResolve(n);
  const base=n.res ? hexFromRec(n.recOut) : {};
  const vals=Object.assign(base,over||{});
  const b=hexBuild(r.sch,vals,{lib:r.lib});
  let bytes=b.bytes;
  if(n.res && n.res.rest.length && !over){ const t=new Uint8Array(bytes.length+n.res.rest.length); t.set(bytes); t.set(n.res.rest,bytes.length); bytes=t; }
  n.warn=b.warn;
  return bytes;
}
function hxCommitField(n,rec,text){
  if(!n.res || n.res.trunc) return;
  const bytes=hxBuild(n,{[rec.n]:text});
  hxSetBuf(n,bytes,n.p.emitEdit);
  if(!n.p.emitEdit) n.dirty=true;
}

def({ id:'hexStruct', title:'HEX Structure', cat:'Data', kw:'hex bytes packet parse build decode struct frame header ip mac wifi dmr gsm crc endian dump editor',
  readout:true, resize:true, w:420, h:460,
  ins:[{n:'bin',t:'bin'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'go',t:'num'}],
  outs:[{n:'bin',t:'bin'},{n:'rec',t:'rec'},{n:'text',t:'txt'},{n:'ok',t:'num'},{n:'len',t:'num'},{n:'new',t:'num'}],
  params:[
    {n:'schema',t:'select',opts:()=>Object.keys(HEX_LIB),d:'eth',label:'structure'},
    {n:'width',adv:true,t:'select',opts:['8','16','24','32'],d:'16',label:'bytes per row'},
    {n:'group',adv:true,t:'select',opts:['1','2','4'],d:'1',label:'group bytes'},
    {n:'emitEdit',adv:true,t:'check',d:true,label:'send the packet on edit'},
    {n:'recMode',adv:true,t:'select',opts:['auto','build','parse'],d:'auto',label:'rec input',tip:'auto: a record with a hex field is parsed (decoder output), any other record is built into a packet'},
    {n:'hexcol',adv:true,t:'text',d:'hex',label:'hex field in a record'},
    {n:'autoSchema',adv:true,t:'check',d:true,label:'take the structure from hexSchema of the record'},
    {n:'map',adv:true,t:'text',d:'',label:'rec field names (column=field, …)',tip:'maps record keys from a Table to structure fields when the names differ'},
    {n:'json',adv:true,t:'code',d:'',plain:true,label:'own structure (JSON; empty — the list above)',fn:n=>{ n.dirty=true; n.uiDirty=true; }},
    {n:'tojson',adv:true,t:'button',label:'Copy chosen structure to JSON',fn:n=>{
      const s=HEX_LIB[n.p.schema]; if(!s) return;
      const t=JSON.stringify(s,null,1); n.p.json=t; if(n.set?.json) n.set.json(t); n.dirty=true; n.uiDirty=true; }},
    {n:'fix',adv:true,t:'button',label:'Fix lengths and checksums',fn:n=>{
      if(!n.res || n.res.trunc) return; hxSetBuf(n,hxBuild(n),true); }},
    {n:'hex',t:'text',d:'',hidden:true},
  ],
  init:n=>{
    n.buf=new Uint8Array(0); n.res=null; n.recOut=null; n.dirty=true; n.uiDirty=true; n.emit=false; n.pulse=0; n.sel=-1;
    n.lastBin=null; n.aisAsm=new HexAisAsm(); n.lastText=undefined; n.lastRec=undefined; n.prevGo=0; n.binOut=null; n.err=''; n.warn=[];
    if(n.p.hex) n.buf=hexFromHex(n.p.hex);
    n.onResize=ln=>{ if(ln.ui) syncCustomHeight(ln,ln.ui.root,160); };
  },
  process(n,I){
    const go=(I.go||0)>.5, rise=go && !n.prevGo; n.prevGo=go;
    const o=I.bin;
    if(o && o.d && o!==n.lastBin){ n.lastBin=o; hxSetBuf(n,o.d,true); }
    if(typeof I.text==='string' && I.text!==n.lastText){
      n.lastText=I.text;
      if(/^\s*[!$]..VD[MO],/.test(I.text)){                // предложения AIS: полезная нагрузка → биты сообщения
        for(const line of I.text.split(/[\r\n]+/)){
          const b=n.aisAsm.push(line);
          if(b){ if(n.p.autoSchema && n.p.schema!=='ais'){ n.p.schema='ais'; if(n.set?.schema) n.set.schema('ais'); } hxSetBuf(n,b.bytes,true); }
        }
      } else if(I.text.trim()) hxSetBuf(n,hexFromHex(I.text),true);
    }
    let rec=I.rec; if(Array.isArray(rec)) rec=rec[rec.length-1];
    if(rec && typeof rec==='object' && rec!==n.lastRec){
      n.lastRec=rec;
      const hx=rec[n.p.hexcol||'hex'], mode=n.p.recMode;
      if(mode!=='build' && typeof hx==='string' && /^[0-9a-f\s]+$/i.test(hx)){      // запись декодера: байты кадра в поле hex
        if(n.p.autoSchema && HEX_LIB[rec.hexSchema] && n.p.schema!==rec.hexSchema){
          n.p.schema=rec.hexSchema; if(n.set?.schema) n.set.schema(rec.hexSchema); }
        hxSetBuf(n,hexFromHex(hx),true);
      } else if(mode!=='parse'){
        if(n.dirty || !n.res) hxParseNow(n);
        hxSetBuf(n,hxBuild(n,hexFromRec(hxMapRec(rec,n.p.map))),true);
      }
    }
    if(rise) n.emit=true;
    const schKey=n.p.schema+'|'+n.p.json;
    if(n._schKey!==schKey){ n._schKey=schKey; n.dirty=true; }
    if(n.dirty || !n.res) hxParseNow(n);
    if(n.emit){ n.emit=false; n.binOut=hxObj(n.buf,n.res.schema||n.p.schema); n.pulse=2; }
    const v=n.pulse>0 ? 1 : 0; if(n.pulse>0) n.pulse--;
    return { bin:n.binOut, rec:n.recOut, text:hexToHex(n.buf), ok:n.res.ok?1:0, len:n.buf.length, new:v }; },
  draw(n){
    if(!n.ui && n.el) hxInit(n);
    if(!n.ui) return;
    if(n.dirty || !n.res) hxParseNow(n);
    if(n.uiDirty && performance.now()-(n.uiT||0)>120){ n.uiDirty=false; n.uiT=performance.now(); hxRender(n); }
  } });

/* ---------- интерфейс ---------- */
const hxEsc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function hxInit(n){
  const mid=n.el.querySelector('.mid');
  if(!mid || mid.querySelector('.hx-ui')) return;
  const root=document.createElement('div'); root.className='hx-ui';
  root.innerHTML=`<div class="hx-bar"><span class="hx-info"></span>
      <button class="hx-btn hx-copy" title="copy the packet as hex">copy</button>
      <button class="hx-btn hx-fix" title="recalculate lengths and checksums from the field values">fix</button></div>
    <div class="hx-dump" tabindex="0" title="click a byte, type hex digits to overwrite; Delete removes it, Insert adds 00"></div>
    <div class="hx-tree"></div>
    <input class="hx-line" placeholder="hex: 45 00 00 1c …" spellcheck="false">`;
  mid.append(root);
  syncCustomHeight(n,root,160);
  const q=s=>root.querySelector(s);
  n.ui={root, info:q('.hx-info'), dump:q('.hx-dump'), tree:q('.hx-tree'), line:q('.hx-line'), pend:null};
  for(const ev of ['pointerdown','wheel']) root.addEventListener(ev,e=>e.stopPropagation());
  root.addEventListener('keydown',e=>e.stopPropagation());
  q('.hx-copy').addEventListener('click',()=>{ try{ navigator.clipboard.writeText(hexToHex(n.buf).replace(/(..)/g,'$1 ').trim()); }catch(e){} });
  q('.hx-fix').addEventListener('click',()=>{ if(n.res && !n.res.trunc) hxSetBuf(n,hxBuild(n),true); });
  n.ui.line.addEventListener('change',()=>{ hxSetBuf(n,hexFromHex(n.ui.line.value),n.p.emitEdit); n.sel=-1; });
  n.ui.dump.addEventListener('click',e=>{
    const t=e.target.closest('[data-i]'); if(!t) return;
    n.selByte=+t.dataset.i; n.ui.pend=null;
    const k=n.fmap && n.fmap[n.selByte]; n.sel=k>=0 ? k : -1;
    n.uiDirty=true; n.ui.dump.focus();
  });
  n.ui.dump.addEventListener('keydown',e=>hxKey(n,e));
  n.ui.tree.addEventListener('click',e=>{
    const row=e.target.closest('[data-k]'); if(!row) return;
    const k=+row.dataset.k;
    if(e.target.closest('.hx-val') && n.res && !n.res.trunc && hxEditable(n.res.fields[k])) hxEditCell(n,row,k);
    else { n.sel=n.sel===k ? -1 : k; n.uiDirty=true; }
  });
  n.uiDirty=true;
}
const hxEditable=r=>r && !r.sub && !r.list && !r.pad && !r.err && r.value!==undefined && r.n;
function hxEditCell(n,row,k){
  const rec=n.res.fields[k], cell=row.querySelector('.hx-val');
  const inp=document.createElement('input'); inp.className='hx-edit';
  inp.value=rec.f.enum || rec.f.flags ? String(rec.value) : String(rec.value);
  cell.textContent=''; cell.append(inp); inp.focus(); inp.select();
  let done=false;
  const fin=ok=>{ if(done) return; done=true; if(ok && inp.value!==String(rec.value)) hxCommitField(n,rec,inp.value); n.uiDirty=true; };
  inp.addEventListener('keydown',e=>{ e.stopPropagation(); if(e.key==='Enter') fin(true); else if(e.key==='Escape') fin(false); });
  inp.addEventListener('blur',()=>fin(true));
  inp.addEventListener('click',e=>e.stopPropagation());
}
function hxKey(n,e){
  const i=n.selByte, L=n.buf.length;
  if(i==null || i<0) return;
  const hexd=/^[0-9a-fA-F]$/.test(e.key) && !e.ctrlKey && !e.metaKey;
  const set=b=>hxSetBuf(n,b,n.p.emitEdit);
  if(hexd){
    e.preventDefault();
    const p=n.ui.pend;
    if(p==null && i<L){ n.ui.pend=parseInt(e.key,16); n.ui.pendAt=i; }
    else if(i<L){
      const b=n.buf.slice(); b[i]=(n.ui.pend<<4)|parseInt(e.key,16); n.ui.pend=null; set(b);
      n.selByte=Math.min(L-1,i+1);
    }
  } else if(e.key==='ArrowRight'){ e.preventDefault(); n.selByte=Math.min(L-1,i+1); n.ui.pend=null; }
  else if(e.key==='ArrowLeft'){ e.preventDefault(); n.selByte=Math.max(0,i-1); n.ui.pend=null; }
  else if(e.key==='ArrowDown'){ e.preventDefault(); n.selByte=Math.min(L-1,i+(+n.p.width||16)); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); n.selByte=Math.max(0,i-(+n.p.width||16)); }
  else if(e.key==='Delete' || e.key==='Backspace'){
    e.preventDefault();
    const b=new Uint8Array(L-1); b.set(n.buf.subarray(0,i)); b.set(n.buf.subarray(i+1),i); set(b);
    n.selByte=Math.min(i,Math.max(0,L-2));
  } else if(e.key==='Insert'){
    e.preventDefault();
    const b=new Uint8Array(L+1); b.set(n.buf.subarray(0,i)); b.set(n.buf.subarray(i),i+1); set(b);
  } else return;
  const k=n.fmap && n.fmap[n.selByte]; n.sel=k>=0 ? k : -1;
  n.uiDirty=true;
}
function hxRender(n){
  const u=n.ui, res=n.res, buf=n.buf;
  const W=+n.p.width||16, G=+n.p.group||1;
  // байт → лист дерева
  const leaves=[], fmap=new Int32Array(buf.length).fill(-1);
  const isCont=r=>r.sub || r.list || r.item;
  res.fields.forEach((r,k)=>{
    if(isCont(r)) return;
    const a=r.b0>>3, b=Math.min(buf.length-1,(r.b0+Math.max(r.bl,1)-1)>>3), c=leaves.length%HX_COLORS;
    leaves.push(k); r.color=r.pad ? -1 : c;
    for(let i=a;i<=b;i++) fmap[i]=k;
  });
  n.fmap=fmap;
  const sel=n.sel>=0 ? res.fields[n.sel] : null;
  let sa=-1, sb=-2;
  if(sel){ sa=sel.b0>>3; sb=(sel.b0+Math.max(sel.bl,1)-1)>>3; }
  const cls=i=>{
    const k=fmap[i], r=k>=0 ? res.fields[k] : null;
    let c=r ? (r.err ? 'hx-err' : r.pad ? 'hx-pad' : 'hx-c'+r.color) : 'hx-x';
    if(i>=sa && i<=sb) c+=' hx-in';
    if(i===n.selByte) c+=' hx-cur';
    return c;
  };
  const N=Math.min(buf.length,HX_MAX_SHOW);
  let h='';
  for(let o=0;o<N;o+=W){
    h+='<div class="hx-row"><span class="hx-off">'+o.toString(16).padStart(4,'0')+'</span><span class="hx-hex">';
    for(let i=o;i<o+W;i++){
      const sep=i>o && (i-o)%G===0 ? ' ' : '';
      if(i<N){
        let t=hexByte(buf[i]);
        if(n.ui.pend!=null && i===n.selByte) t=n.ui.pend.toString(16)+'_';
        h+=sep+'<b data-i="'+i+'" class="'+cls(i)+'">'+t+'</b>';
      } else h+=sep+'<b class="hx-x">  </b>';
    }
    h+='</span><span class="hx-asc">';
    for(let i=o;i<Math.min(N,o+W);i++){ const c=buf[i]; h+='<i data-i="'+i+'" class="'+cls(i)+'">'+(c>=32&&c<127 ? hxEsc(String.fromCharCode(c)) : '·')+'</i>'; }
    h+='</span></div>';
  }
  if(!buf.length) h='<div class="hx-empty">no data — wire <b>bin</b> / <b>text</b>, type hex below or wire a <b>rec</b></div>';
  if(buf.length>N) h+='<div class="hx-empty">… +'+(buf.length-N)+' bytes not shown</div>';
  u.dump.innerHTML=h;
  // дерево
  let t='';
  res.fields.forEach((r,k)=>{
    if(r.pad) return;
    const cont=isCont(r);
    const val=cont ? '' : r.err ? r.err : (r.text!==undefined ? r.text : String(r.value));
    const off=(r.b0>>3).toString(16)+((r.b0&7)||(r.bl&7) ? '.'+(r.b0&7) : '');
    const rawHex=!cont && typeof r.value==='number' && r.bl>8 && !r.f.enum ? ' <u>0x'+r.value.toString(16)+'</u>' : '';
    const warn=r.warn ? ' <em>'+hxEsc(r.warn)+'</em>' : '';
    const sw=cont ? '' : '<s class="'+(r.color>=0 ? 'hx-c'+r.color : '')+'"></s>';
    t+='<div class="hx-f'+(n.sel===k ? ' on' : '')+(r.err||r.calcOk===false ? ' bad' : '')+'" data-k="'+k+'" style="padding-left:'+(r.depth*10+2)+'px">'+sw+
      '<span class="hx-n">'+hxEsc(r.name||r.n)+'</span><span class="hx-o">'+off+'</span>'+
      '<span class="hx-val'+(hxEditable(r)&&!res.trunc ? ' ed' : '')+'">'+hxEsc(val)+rawHex+warn+'</span></div>';
  });
  if(res.rest.length) t+='<div class="hx-f"><span class="hx-n">trailing</span><span class="hx-o">'+res.len.toString(16)+'</span><span class="hx-val">'+res.rest.length+' B</span></div>';
  u.tree.innerHTML=t;
  if(document.activeElement!==u.line) u.line.value=Array.from(buf.subarray(0,512),hexByte).join(' ')+(buf.length>512 ? ' …' : '');
  const name=res.schema || n.p.schema;
  const st=n.err ? '⚠ '+n.err : res.trunc ? '⚠ truncated' : res.ok ? 'ok' : '⚠ '+(res.fields.find(r=>r.warn)?.warn||'check');
  u.info.textContent=name+' · '+buf.length+' B · '+st;
  u.info.className='hx-info'+(n.err||res.trunc||!res.ok ? ' bad' : '');
  const r=n.el.querySelector('.readout');
  const rt=name+' · '+buf.length+' B · '+(res.ok&&!n.err ? 'ok' : 'check');
  if(r && r.textContent!==rt) r.textContent=rt;
}
