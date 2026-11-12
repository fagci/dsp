"use strict";
/* ============================ LZHUF (LZSS + адаптивный Хаффман, Окумура/Ёсидзаки) ============================
   Чистая логика без DOM (страница и Node). Парой: lzhEncode ↔ lzhDecode (tools/test-winlink.mjs). Сжатие Winlink B2F — этот
   алгоритм. Окно 4096, длина совпадения 3…60, 314 символов дерева (256 литералов + 58 длин); поток: 4 байта длины (LE)
   и биты старшим вперёд. Кодировщик ищет совпадения по хэш-цепочкам (поток иной, чем у оригинала, но читается любым
   декодером LZHUF). Позиция — расстояние−1 (6 старших бит по таблице длин 3/4/5/6/7/8 бит, 6 младших — как есть). */

const LZ_N=4096, LZ_F=60, LZ_T0=2, LZ_NCHAR=256-LZ_T0+LZ_F, LZ_T=LZ_NCHAR*2-1, LZ_R=LZ_T-1, LZ_MAXF=0x8000;
// длины кодов старших 6 бит позиции: 1×3, 3×4, 8×5, 12×6, 24×7, 16×8 бит; коды — канонические
const LZ_PLEN=(()=>{ const a=[]; for(const [n,l] of [[1,3],[3,4],[8,5],[12,6],[24,7],[16,8]]) for(let i=0;i<n;i++) a.push(l); return a; })();
const LZ_PCODE=(()=>{ const a=[]; let c=0; for(const l of LZ_PLEN){ a.push(c); c+=1<<(8-l); } return a; })();

function lzHuff(){
  const freq=new Int32Array(LZ_T+1), prnt=new Int32Array(LZ_T+LZ_NCHAR), son=new Int32Array(LZ_T);
  for(let i=0;i<LZ_NCHAR;i++){ freq[i]=1; son[i]=i+LZ_T; prnt[i+LZ_T]=i; }
  let i=0, j=LZ_NCHAR;
  while(j<=LZ_R){ freq[j]=freq[i]+freq[i+1]; son[j]=i; prnt[i]=prnt[i+1]=j; i+=2; j++; }
  freq[LZ_T]=0xffff; prnt[LZ_R]=0;
  return {freq,prnt,son};
}
function lzReconst(h){
  const {freq,prnt,son}=h; let j=0;
  for(let i=0;i<LZ_T;i++) if(son[i]>=LZ_T){ freq[j]=(freq[i]+1)>>1; son[j]=son[i]; j++; }
  for(let i=0,jj=LZ_NCHAR;jj<LZ_T;i+=2,jj++){
    let k=i+1; const f=freq[jj]=freq[i]+freq[k];
    for(k=jj-1;f<freq[k];k--);
    k++;
    for(let m=jj;m>k;m--){ freq[m]=freq[m-1]; son[m]=son[m-1]; }
    freq[k]=f; son[k]=i;
  }
  for(let i=0;i<LZ_T;i++){ const k=son[i]; if(k>=LZ_T) prnt[k]=i; else prnt[k]=prnt[k+1]=i; }
}
function lzUpdate(h,c){
  const {freq,prnt,son}=h;
  if(freq[LZ_R]===LZ_MAXF) lzReconst(h);
  c=prnt[c+LZ_T];
  do{
    const k=++freq[c]; let l=c+1;
    if(k>freq[l]){
      while(k>freq[++l]);
      l--;
      freq[c]=freq[l]; freq[l]=k;
      const i=son[c]; prnt[i]=l; if(i<LZ_T) prnt[i+1]=l;
      const j=son[l]; son[l]=i; prnt[j]=c; if(j<LZ_T) prnt[j+1]=c;
      son[c]=j; c=l;
    }
  }while((c=prnt[c])!==0);
}
function lzEncode(src){
  const n=src.length, out=[n&255,(n>>8)&255,(n>>16)&255,(n>>>24)&255];
  const h=lzHuff(); let acc=0, nb=0;
  const put=(len,val)=>{ for(let b=len-1;b>=0;b--){ acc=(acc<<1)|((val>>b)&1); if(++nb===8){ out.push(acc); acc=0; nb=0; } } };
  const encChar=c=>{
    const bits=[]; let k=h.prnt[c+LZ_T];
    do{ bits.push(k&1); k=h.prnt[k]; }while(k!==LZ_R);
    for(let i=bits.length-1;i>=0;i--) put(1,bits[i]);                   // от корня к листу
    lzUpdate(h,c);
  };
  const encPos=d=>{ const i=d>>6; put(LZ_PLEN[i],LZ_PCODE[i]>>(8-LZ_PLEN[i])); put(6,d&63); };
  const PRE=LZ_N-LZ_F;                                                    // пробелы в начале окна
  const hist=new Uint8Array(PRE+n); hist.fill(32,0,PRE); hist.set(src,PRE);
  const head=new Map();                                                   // хэш трёх байт → позиции (по возрастанию)
  const key=p=>hist[p]|(hist[p+1]<<8)|(hist[p+2]<<16);
  const ins=p=>{ if(p+2>=hist.length) return; const k=key(p); let a=head.get(k); if(!a){ a=[]; head.set(k,a); } a.push(p); };
  for(let p=0;p+2<PRE;p++) ins(p);
  let cur=PRE;
  while(cur<hist.length){
    let bl=0, bp=0;
    const maxl=Math.min(LZ_F,hist.length-cur);
    if(maxl>=3){
      const a=head.get(key(cur));
      if(a) for(let q=a.length-1,tries=0;q>=0 && tries<160;q--,tries++){
        const p=a[q]; if(p>=cur) continue;
        const d=cur-p; if(d>LZ_N-LZ_F) break;
        let l=0; while(l<maxl && hist[p+l]===hist[cur+l]) l++;
        if(l>bl){ bl=l; bp=d; if(l===maxl) break; }
      }
    }
    if(bl<=LZ_T0){ encChar(hist[cur]); ins(cur); cur++; }
    else { encChar(255-LZ_T0+bl); encPos(bp-1); for(let k=0;k<bl;k++) ins(cur+k); cur+=bl; }
  }
  if(nb>0){ out.push((acc<<(8-nb))&255); }
  return Uint8Array.from(out);
}
function lzDecode(data){
  if(data.length<4) return null;
  const size=(data[0]|(data[1]<<8)|(data[2]<<16))+data[3]*16777216;
  if(size>16777216) return null;
  const h=lzHuff(), out=new Uint8Array(size), ring=new Uint8Array(LZ_N).fill(32);
  let bi=32;                                                               // номер бита в потоке (после 4 байт)
  const bit=()=>{ const by=data[bi>>3]; if(by===undefined) throw new Error('eof'); const b=(by>>(7-(bi&7)))&1; bi++; return b; };
  let r=LZ_N-LZ_F, o=0;
  try{
    while(o<size){
      let c=h.son[LZ_R];
      while(c<LZ_T) c=h.son[c+bit()];
      c-=LZ_T; lzUpdate(h,c);
      if(c<256){ out[o++]=c; ring[r]=c; r=(r+1)&(LZ_N-1); }
      else {
        let v=0, len=0, idx=-1;
        while(idx<0){ v=(v<<1)|bit(); len++; if(len>8) return null; for(let i=0;i<64;i++) if(LZ_PLEN[i]===len && (LZ_PCODE[i]>>(8-len))===v){ idx=i; break; } }
        let low=0; for(let k=0;k<6;k++) low=(low<<1)|bit();
        const d=(idx<<6)|low;
        let i=(r-d-1)&(LZ_N-1); const j=c-255+LZ_T0;
        for(let k=0;k<j && o<size;k++){ const b=ring[(i+k)&(LZ_N-1)]; out[o++]=b; ring[r]=b; r=(r+1)&(LZ_N-1); }
      }
    }
  }catch(e){ return null; }
  return out;
}
