"use strict";
/* ============================ Universal Decoder: мост к декодерам главного потока ============================
   Декодеры звукового домена (SAME, Morse, FT8…) и GSM живут блоками MOD[id] со своим process(n,I) на Eng.sr и BLOCK; ядра в воркере у них нет.
   Мост ведёт канал udec к ним: IQ → децимация (iqDecim) → демодулятор (iqDemod: FM / AM / USB) → блоки звука aud.blk → MOD[id].process.
   Eng.sr и BLOCK на время блока подменяются (вызов синхронный, потом возвращаются). Работает только в главном потоке: в воркере ядро udec
   (udec-kernels.js) эти записи пропускает и просит узел переехать (needMain, см. udec.js). Одну цепочку «децимация + демодулятор» делят все записи с одинаковыми aud. */
const UDEC_AUDIO=(()=>{
  const ready=()=>typeof MOD!=='undefined' && typeof Eng!=='undefined' && typeof IQK!=='undefined' && !!IQK.iqDemod;
  // параметры блока по умолчанию из его описания + свои записи реестра
  const dflt=id=>{ const o={}; for(const q of (MOD[id]?.params||[])) if('d' in q) o[q.n]=q.d; return o; };
  const stagesOf=r=>r.stages || [{id:r.id}];
  const tstr=x=>x==null ? '' : String(x);

  // ---- канал → звук ----
  function front(n,s,a,now){
    n.afr=n.afr||new Map();
    const key=[a.mode,a.asr,a.dev||0,a.bw||0,s.sr].join('|');
    let f=n.afr.get(key);
    if(!f){
      f={dc:[], dm:{p:{mode:a.mode, dev:a.dev||5000, bw:a.bw||2700, deemph:'off', stereo:false, samSb:'both', agc:true, dc:true, gain:0}}, tick:-1, chunks:null, ar:0, seen:now};
      let D=Math.max(1,Math.floor(s.sr/a.asr));
      while(D>1){
        const d=UDEC_DEC.reduce((m,x)=>x<=D ? x : m,1);
        if(d<2) break;
        const st={p:{M:String(d), cut:.4, tpp:'16'}}; IQK.iqDecim.init(st); f.dc.push(st); D=Math.floor(D/d);
      }
      if(a.mode!=='ENV') IQK.iqDemod.init(f.dm);
      n.afr.set(key,f);
    }
    f.seen=now;
    if(f.tick!==n.tick){                                      // новый такт (по счётчику узла: объект потока источник переиспользует): считаем один раз на все записи с этими aud
      f.tick=n.tick; f.chunks=null;
      let x=s;
      for(const st of f.dc){ x=IQK.iqDecim.process(st,{in:x}).out; if(!x) return f; }
      if(a.mode==='ENV'){                                      // огибающая |IQ| без демодулятора (Morse: манипуляция несущей; AM-АРУ на старте даёт выброс, который держит порог)
        f.ar=x.sr; f.chunks=x.chunks.map(c=>{ const im=iqChunkIm(c), e=new Float32Array(c.re.length); for(let i=0;i<e.length;i++) e[i]=Math.hypot(c.re[i],im[i]); return e; });
        return f;
      }
      const y=IQK.iqDemod.process(f.dm,{in:x}).out;
      if(y){ f.ar=y.sr; f.chunks=y.chunks.map(c=>c.re); }
    }
    for(const [kk,v] of n.afr) if(now-v.seen>5000) n.afr.delete(kk);    // давно не нужные
    return f;
  }

  // ---- как читать выход последней ступени ----
  // накопление текста: строка уходит записью по '\n', по длине или после паузы idle мс; ok(k, acc) — достоверно ли (нет — kind 'unknown': выводится, но захват не даёт)
  function flush(k,r,now,recs,texts,extra){
    const g=GATE[r.gate]||GATE.any;
    const cut=(line)=>{ const t=line.trim(); if(!t) return;
      const ok=g(k,t);
      recs.push({t:Date.now(), src:r.proto, kind:ok ? 'text' : 'unknown', text:t, ...(extra||{})});
      if(ok) texts.push(t); };
    let acc=k.acc;
    let i;
    while((i=acc.indexOf('\n'))>=0){ cut(acc.slice(0,i)); acc=acc.slice(i+1); }
    const L=r.maxLen||60;
    while(acc.length>=L){ cut(acc.slice(0,L)); acc=acc.slice(L); }
    if(acc && now-k.accT>=(r.idle||1500)){ cut(acc); acc=''; }
    k.acc=acc;
  }
  const GATE={
    any:()=>true,
    // Morse: скорость 5–50 WPM и в основном буквы / цифры (шум даёт «ETET#E#»)
    morse:(k,t)=>{ const c=t.replace(/\s/g,''); return c.length>=3 && k.wpm>=5 && k.wpm<=50 && (c.match(/[A-Z0-9]/gi)||[]).length>=.7*c.length; },
    dtmf:(k,t)=>t.replace(/\s/g,'').length>=2,
    // aFSK / RTTY: скорость захвачена (lock) и в основном печатные знаки — иначе это шум со случайным «захватом» частот
    afsk:(k,t)=>k.lock>=.7 && t.length>=4 && (t.match(/[\x20-\x7E]/g)||[]).length>=.8*t.length,
    olivia:(k)=>!!k.locked
  };
  const RD={
    // готовые записи декодера (rec) и его текст
    rec(k,r,st,o,now,recs,texts){
      const got=o.rec ? (Array.isArray(o.rec) ? o.rec : [o.rec]) : [];
      for(const x of got) recs.push(x);
      if(o.text) texts.push(tstr(o.text));
      else for(const x of got) if(x.msg) texts.push(tstr(x.msg));       // FT8 / JS8: текст сообщения в самой записи
    },
    // текст, который блок дописывает в st.text: перед блоком st.text обнуляется, после — приращение
    tail(k,r,st,o,now,recs,texts){
      const d=tstr(st.text); st.text='';
      k.wpm=+o.wpm||k.wpm||0; if(o.lock!=null) k.lock=+o.lock; k.locked=st.locked;
      if(d){ k.acc+=d; k.accT=now; k.lockMax=Math.max(k.lockMax||0,k.lock||0); }
    },
    // кадры AX.25: по строке 'SRC>DST,путь:данные' на кадр
    ax25(k,r,st,o,now,recs,texts){
      const d=tstr(st.text); st.text='';
      for(const line of d.split('\n')){
        if(!line.trim()) continue;
        const m=/^([^>\s]+)>([^,:\s]+)(?:,([^:]*))?:(.*)$/.exec(line.trim());
        recs.push(m ? {t:Date.now(), src:'AX.25', kind:'frame', from:m[1], to:m[2], path:m[3]||'', info:m[4], text:line.trim()}
                    : {t:Date.now(), src:'AX.25', kind:'frame', text:line.trim()});
        texts.push(line.trim());
      }
    },
    // WWV / CHU: строка журнала (время, дата, DUT1…) — запись
    wwv(k,r,st,o,now,recs,texts){
      const l=st.log && st.log[0];
      if(l && l!==k.lastLog){ k.lastLog=l; recs.push({t:Date.now(), src:'WWV', kind:'time', text:l}); texts.push(l); }
    }
  };
  // вход блока по записи: feed 'level' — число (Morse берёт уровень, а не отсчёты)
  const mkInput=(a,blk)=>{
    if(a.feed==='level'){ let m=0; for(let i=0;i<blk.length;i++) m+=blk[i]; return {level:m/blk.length}; }
    return {in:blk};
  };

  // состояние ступеней: параметры из описания блока, затем записи реестра; p записи реестра — у последней ступени (самого декодера)
  function build(k,r,ar,blk){
    k.ar=ar; k.blk=blk; k.fill=0; k.buf=new Float32Array(blk); k.acc=''; k.accT=0;
    const sg=stagesOf(r);
    k.sts=sg.map((g,i)=>({id:g.id, p:{...dflt(g.id), ...(g.p||{}), ...(i===sg.length-1 ? r.p : null)}}));
    for(const st of k.sts) MOD[st.id].init(st);
  }

  // один блок звука через цепочку блоков
  function block(k,r,now,recs,texts){
    const a=r.aud, sB=BLOCK, sS=Eng.sr;
    BLOCK=k.blk; Eng.sr=k.ar;
    try{
      let I=mkInput(a,k.buf), o={};
      const sg=stagesOf(r);
      for(let i=0;i<k.sts.length;i++){
        const st=k.sts[i];
        if(i===k.sts.length-1 && (r.rd==='tail' || r.rd==='ax25')) st.text='';
        if(st.id==='ft8Rx') st.p.freq=k.fc||0;
        o=MOD[st.id].process(st,I) || {};
        if(i<k.sts.length-1) I={in:o[sg[i].via||'out']};
      }
      RD[r.rd](k,r,k.sts[k.sts.length-1],o,now,recs,texts);
    } finally { BLOCK=sB; Eng.sr=sS; }
  }

  function run(n,k,r,s,now){
    if(!s) return {};
    const recs=[], texts=[];
    k.fc=s.fc||0;
    if(!r.aud){                                               // IQ напрямую (GSM)
      if(!k.sts){ k.sts=[{id:r.id, p:{...dflt(r.id), ...r.p}}]; MOD[r.id].init(k.sts[0]); }
      const st=k.sts[0]; st.text='';
      const o=MOD[r.id].process(st,{in:s}) || {};
      RD[r.rd](k,r,st,o,now,recs,texts);
      return {rec:recs.length ? recs : null, text:texts.length ? texts.join('\n') : null};
    }
    const f=front(n,s,r.aud,now);
    if(!f.chunks) return {};
    const blk=r.aud.blk||512;
    if(!k.sts || Math.abs(k.ar-f.ar)>1 || k.blk!==blk) build(k,r,f.ar,blk);
    for(const ch of f.chunks){
      let i=0;
      while(i<ch.length){
        const take=Math.min(ch.length-i,k.blk-k.fill);
        k.buf.set(ch.subarray(i,i+take),k.fill); k.fill+=take; i+=take;
        if(k.fill===k.blk){ k.fill=0; block(k,r,now,recs,texts); }
      }
    }
    if(r.rd==='tail') flush(k,r,now,recs,texts,r.gate==='afsk' ? {lock:+(k.lock||0).toFixed(2)} : r.gate==='morse' ? {wpm:+(k.wpm||0).toFixed(1)} : null);
    return {rec:recs.length ? recs : null, text:texts.length ? texts.join('\n') : null};
  }
  return {ready, run};
})();
