"use strict";
/* ============================ Lookup: поиск по другой таблице (чистая логика, без DOM) ============================
   Функции вычисляемых полей Table: lookup(список, 'ключ', значение, 'результат'[, режим]) и between(список, 'от', 'до', значение, 'результат').
   Таблица-справочник один раз превращается в индекс (Map / отсортированные массивы), дальше каждая строка стоит O(1) / O(log n) —
   справочник в десятки тысяч записей (OUI) не тормозит вычисление.
   Режимы lookup:
     eq       — точное совпадение без учёта регистра и пробелов по краям (по умолчанию)
     mac      — ключи — начало MAC-адреса (OUI 00:1B:C5, 28 / 36 бит — 00:1B:C5:0A:B); разделители не важны; выигрывает самый длинный ключ
     prefix   — ключ — начало значения («DJI-» → «DJI-MAVIC3»); выигрывает самый длинный
     contains — ключ входит в значение («cam» → «IPCAM_5G»); выигрывает самый длинный; перебор — для коротких справочников
   between: значение лежит в [от; до]; при перекрытии выигрывает самый узкий интервал.
   Индекс кладёт и достаёт Table (modules/table-lookup.js); здесь — построение и поиск. */

const LU_MODES=['eq','mac','prefix','contains'];
const LU_SCAN=512;                                    // между: сколько перекрывающихся интервалов просматриваем назад
const luText=v=>String(v??'').trim().toLowerCase();
const luHex=v=>String(v??'').replace(/[^0-9a-f]/gi,'').toUpperCase();
const luNum=v=>{
  if(typeof v==='number') return v;
  const s=String(v??'').trim(); if(s==='') return NaN;
  const x=Number(s); if(isFinite(x)) return x;
  return typeof parseHzCell==='function' ? parseHzCell(s) : NaN;       // 433.92M, 14 MHz
};

// Индекс одного режима. add(ключ, строка) → done() → find(значение) → строка | null
function luIndex(mode){
  if(mode==='range') return luRangeIndex();
  if(!LU_MODES.includes(mode)) throw new Error('unknown mode "'+mode+'" (eq, mac, prefix, contains)');
  const map=new Map(), lens=new Set(), list=[];
  const norm=mode==='mac' ? luHex : luText;
  return {
    mode, size:0,
    add(key,row){
      const k=norm(key); if(!k) return;
      if(mode==='contains'){ list.push([k,row]); this.size++; return; }
      if(map.has(k)) return;                            // дубли: первая запись
      map.set(k,row); lens.add(k.length); this.size++;
    },
    done(){
      if(mode==='contains') list.sort((a,b)=>b[0].length-a[0].length);
      this.lens=[...lens].sort((a,b)=>b-a);
      return this;
    },
    find(val){
      const v=norm(val); if(!v) return null;
      if(mode==='eq') return map.get(v)||null;
      if(mode==='contains'){ for(const [k,r] of list) if(v.includes(k)) return r; return null; }
      for(const L of this.lens) if(v.length>=L){ const r=map.get(v.slice(0,L)); if(r) return r; }
      return null;
    }};
}

// Интервалы: сортировка по началу, префиксный максимум конца — просмотр назад обрывается, когда дальше накрыть значение уже некому
function luRangeIndex(){
  const items=[]; let lo=null, hi=null, rows=null, pmax=null;
  return {
    mode:'range', size:0,
    add(a,b,row){
      const x=luNum(a); if(!isFinite(x)) return;
      let y=luNum(b); if(!isFinite(y)) y=x;
      items.push(x<=y ? [x,y,row] : [y,x,row]); this.size++;
    },
    done(){
      items.sort((p,q)=>p[0]-q[0]);
      lo=new Float64Array(items.length); hi=new Float64Array(items.length); pmax=new Float64Array(items.length); rows=items.map(i=>i[2]);
      let m=-Infinity;
      items.forEach((it,i)=>{ lo[i]=it[0]; hi[i]=it[1]; m=Math.max(m,it[1]); pmax[i]=m; });
      return this;
    },
    find(val){
      const x=luNum(val); if(!isFinite(x) || !lo || !lo.length) return null;
      let a=0, b=lo.length;                               // первый индекс с lo > x
      while(a<b){ const m=(a+b)>>1; if(lo[m]<=x) a=m+1; else b=m; }
      let best=-1, w=Infinity;
      for(let i=a-1, n=0; i>=0 && pmax[i]>=x && n<LU_SCAN; i--, n++){
        if(hi[i]>=x && hi[i]-lo[i]<w){ w=hi[i]-lo[i]; best=i; }
      }
      return best<0 ? null : rows[best];
    }};
}

/* ---------- реестр индексов ---------- */
// ключ индекса: список, режим, колонки. Неудачная загрузка хранится отдельно (bad) с текстом ошибки — и не кэшируется: следующая подготовка пробует снова
const LU={
  idx:new Map(), bad:new Map(), watch:new Set(),
  key:(list,mode,c1,c2)=>[list,mode,c1,c2||''].join('\u0001'),
  busy:new Map(),                                      // ключ → идущая загрузка (одна на всех узлов)
  get(k){ return this.idx.get(k); },
  set(k,ix,list,cols){ ix.list=list; ix.cols=cols; this.idx.set(k,ix); this.bad.delete(k); },
  fail(k,msg){ this.bad.set(k,msg); this.idx.delete(k); },
  // список изменился: индексы по нему выбрасываются (all — по всем пользовательским: правка по id не говорит, какой список), подписчики узнают.
  // Справочники «Reference/…» меняет только скачивание (по имени), правка записи по id их не трогает
  invalidate(list,all){
    const gone=[];
    for(const [k,ix] of this.idx) if(all ? !/^Reference\//.test(ix.list) : ix.list===list){ this.idx.delete(k); gone.push(ix.list); }
    this.bad.clear();                                  // не нашли тогда — найдём, возможно, теперь
    for(const w of this.watch) try{ w(list,gone); }catch(e){}
  },
  // ListDB.<метод>(…) отработал (sources.js): имя списка — первый аргумент, у правок по id имени нет
  touched(method,args){
    if(method==='renameList'){ this.invalidate(args[0]); this.invalidate(args[1]); }
    else if(/^(add|addMany|replaceList|deleteList|setMeta|delMeta)$/.test(method) && typeof args[0]==='string') this.invalidate(args[0]);
    else if(/^(update|remove|removeMany)$/.test(method)) this.invalidate(null,true);
  },
};
// список dep (как написан в выражении: полное имя, без папки) — это список name
const luSame=(dep,name)=>{ const a=String(dep).toLowerCase(), b=String(name).toLowerCase(); return a===b || b.endsWith('/'+a); };

const luStr=(v,what)=>{ if(typeof v!=='string' || !v) throw new Error(what+' must be text in quotes'); return v; };

// lookup('список','колонка-ключ', значение, 'колонка-результат'[, режим]); значение берётся из строки, остальное — литералы
function luLookup(list,keyCol,val,ret,mode='eq'){
  const k=LU.key(luStr(list,'list name'),mode,luStr(keyCol,'key column'));
  const ix=LU.get(k);
  if(!ix) throw new Error(LU.bad.get(k)||'list "'+list+'" is not loaded');
  return luPick(ix,ix.find(val),ret);
}
function luPick(ix,r,ret){
  luStr(ret,'result column');
  if(ix.cols && !ix.cols.has(ret)) throw new Error('no column "'+ret+'" in list "'+ix.list+'"');
  return r ? r[ret] ?? '' : '';
}
function luBetween(list,loCol,hiCol,val,ret){
  const k=LU.key(luStr(list,'list name'),'range',luStr(loCol,'from column'),luStr(hiCol,'to column'));
  const ix=LU.get(k);
  if(!ix) throw new Error(LU.bad.get(k)||'list "'+list+'" is not loaded');
  return luPick(ix,ix.find(val),ret);
}

/* ---------- справочники: разбор скачанных файлов → {cols, rows} ---------- */
// nmap-mac-prefixes: «001BC5 Vendor» (6 / 7 / 9 знаков — MA-L / MA-M / MA-S)
function luParseNmapMac(text){
  const rows=[];
  for(const line of String(text).split(/\r?\n/)){
    const m=/^([0-9A-Fa-f]{6,9})\s+(.+?)\s*$/.exec(line); if(!m) continue;
    rows.push({prefix:luMacShow(m[1].toUpperCase()),vendor:m[2],bits:m[1].length*4});
  }
  if(!rows.length) throw new Error('no MAC prefixes in the file');
  return {cols:['prefix','vendor','bits'],rows};
}
// 001BC5 → 00:1B:C5; 001BC50AB → 00:1B:C5:0A:B (хвост — нецелый байт)
const luMacShow=h=>h.replace(/(..)(?=.)/g,'$1:');

// signals.json (intercept): по строке на диапазон частот записи
function luParseSignals(text){
  const o=JSON.parse(String(text).replace(/^﻿/,'')); if(!Array.isArray(o)) throw new Error('signals.json: array expected');
  const rows=[], j=a=>Array.isArray(a) ? a.join(', ') : '';
  for(const s of o){
    if(!s || !Array.isArray(s.frequency_ranges)) continue;
    const bw=s.bandwidth_range||{}, d=String(s.description||'').replace(/^\s*#.*$/mg,'').replace(/\s+/g,' ').trim();
    for(const f of s.frequency_ranges) rows.push({name:s.name||s.id||'', lo:f.min_hz??'', hi:f.max_hz??'', bw_lo:bw.min_hz??'', bw_hi:bw.max_hz??'',
      mod:j(s.modulations), category:j(s.categories), region:j(s.regions), description:d.slice(0,300), url:s.sigidwiki_url||''});
  }
  if(!rows.length) throw new Error('no signals in the file');
  return {cols:['name','lo','hi','bw_lo','bw_hi','mod','category','region','description','url'],rows};
}
// wefax_stations.json: по строке на частоту станции
function luParseWefax(text){
  const o=JSON.parse(String(text).replace(/^﻿/,'')), st=o && o.stations; if(!Array.isArray(st)) throw new Error('wefax_stations.json: stations expected');
  const rows=[];
  for(const s of st) for(const f of s.frequencies||[]) rows.push({name:s.name||'', callsign:s.callsign||'', country:s.country||'', city:s.city||'',
    lat:s.coordinates?.[0]??'', lon:s.coordinates?.[1]??'', hz:Math.round((+f.khz||0)*1000), use:f.description||'', ioc:s.ioc??'', lpm:s.lpm??''});
  if(!rows.length) throw new Error('no stations in the file');
  return {cols:['name','callsign','country','city','lat','lon','hz','use','ioc','lpm'],rows};
}
// data/bluetooth-uuids.json (tools/bt-uuids.mjs): UUID служб, характеристик и дескрипторов Bluetooth + формат разбора значения
function luParseBtUuids(text){
  const o=JSON.parse(String(text).replace(/^\ufeff/,'')); if(!o || !Array.isArray(o.rows)) throw new Error('bluetooth-uuids.json: unexpected format');
  return {cols:o.cols||['uuid','kind','name','fmt','scale','unit','note'],rows:o.rows};
}
// intercept-ids.json (tools/intercept-data.py из data/patterns.py и tscm_frequencies.py): несколько таблиц сразу
function luParseIds(text){
  const o=JSON.parse(String(text).replace(/^﻿/,'')); if(!o || !Array.isArray(o.tscm)) throw new Error('intercept-ids.json: unexpected format');
  return {
    tscm:{cols:['group','name','lo','hi','risk'],rows:o.tscm},
    ssid:{cols:['pattern','kind','vendor'],rows:o.ssid},
    mac:{cols:['prefix','vendor','kind'],rows:o.mac},
    ble:{cols:['company','name','risk','patterns','description'],rows:o.ble},
  };
}
// intercept-spy.json (tools/intercept/build.py из routes/spy_stations.py): по строке на частоту станции
function luParseSpy(text){
  const o=JSON.parse(String(text).replace(/^\uFEFF/,'')); if(!Array.isArray(o) || !o.length || !('hz' in o[0])) throw new Error('intercept-spy.json: unexpected format');
  return {cols:['name','nickname','type','country','hz','primary','mode','operator','schedule','description','url'],rows:o};
}
// RadioID: user.csv (RADIO_ID,CALLSIGN,FIRST_NAME,LAST_NAME,CITY,STATE,COUNTRY) или users.json ({users:[{id,callsign,fname,name,city,state,country}]})
function luParseRadioId(text){
  text=String(text).replace(/^\uFEFF/,'');
  const rows=[], put=(id,call,first,last,city,state,country)=>{
    id=+id; if(!(id>0) || !call) return;
    rows.push({id, callsign:String(call).trim(), name:[first,last].filter(Boolean).join(' ').trim(), place:[city,state,country].filter(Boolean).join(', ')});
  };
  if(/^\s*[{[]/.test(text)){
    const j=JSON.parse(text);
    for(const u of (Array.isArray(j) ? j : j.users||j.results||[])) put(u.id||u.radio_id,u.callsign,u.fname||u.first_name,u.name||u.surname||u.last_name,u.city,u.state,u.country);
  } else for(const ln of text.split(/\r?\n/)){
    const c=ln.split(',');
    if(c.length>=2 && /^\d+$/.test(c[0].trim())) put(c[0],c[1],c[2],c[3],c[4],c[5],c[6]);
  }
  if(!rows.length) throw new Error('no DMR IDs in the file');
  return {cols:['id','callsign','name','place'],rows};
}
// разговорные группы: {"91":"World-wide"} (BrandMeister API), [{id,name}] или строки «id,имя» / «id;имя»
function luParseTalkgroups(text){
  text=String(text).replace(/^\uFEFF/,'');
  const rows=[];
  if(/^\s*[{[]/.test(text)){
    const j=JSON.parse(text);
    if(Array.isArray(j)) for(const g of j){ const id=+(g.id??g.talkgroup??g.tg), nm=g.name||g.label; if(id>=0 && nm) rows.push({id,name:String(nm)}); }
    else for(const k of Object.keys(j)) if(/^\d+$/.test(k) && j[k]) rows.push({id:+k,name:String(j[k])});
  } else for(const ln of text.split(/\r?\n/)){
    const r=/^\s*(\d+)\s*[,;\t ]\s*(.+?)\s*$/.exec(ln);
    if(r) rows.push({id:+r[1],name:r[2].replace(/^"|"$/g,'')});
  }
  if(!rows.length) throw new Error('no talkgroups in the file');
  return {cols:['id','name'],rows};
}
