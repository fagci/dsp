/* MPEG-2 video decoder (ISO/IEC 13818-2, 4:2:0, frame and field pictures) as a freestanding wasm module: no libc.
   The macroblock syntax and the VLC trees follow pl_mpeg (MIT, Dominic Szablewski, github.com/phoboslab/pl_mpeg); the rest
   (MPEG-2 extensions, field and frame prediction, dequantisation, B-frame reordering) is written for this project.
   Not supported: dual prime, scalability, 4:2:2 / 4:4:4, MPEG-1 streams.
   Host side: write one access unit to m2_in(), call m2_decode(len, pts), read m2_frame(i) (RGBA) for i < result. */
#include <stdint.h>
#include "vlc-trees.h"
#include "rl-tables.h"

typedef uint8_t u8;
extern unsigned char __heap_base;

/* ---------- memory ---------- */
static unsigned heap_top;
static void* halloc(unsigned n){
  heap_top=(heap_top+15)&~15u;
  unsigned p=heap_top; heap_top+=n;
  unsigned have=(unsigned)__builtin_wasm_memory_size(0)*65536u;
  if(heap_top>have){ unsigned pages=(heap_top-have+65535)/65536; if(__builtin_wasm_memory_grow(0,pages)<0) return 0; }
  return (void*)p;
}
static void zero(void* d,unsigned n){ u8* p=d; while(n--) *p++=0; }
static void copy(void* d,const void* s,unsigned n){ u8* p=d; const u8* q=s; while(n--) *p++=*q++; }

/* ---------- bit reader ---------- */
static const u8* bp; static int blen, bpos, berr;
#define BYTE(i) ((i)<blen ? bp[i] : 0)
static inline uint32_t peek(int n){
  int p=bpos>>3;
  uint32_t w=((uint32_t)BYTE(p)<<24)|((uint32_t)BYTE(p+1)<<16)|((uint32_t)BYTE(p+2)<<8)|BYTE(p+3);
  return (w<<(bpos&7))>>(32-n);
}
static inline void skip(int n){ bpos+=n; if(bpos>blen*8) berr=1; }
static inline uint32_t get(int n){ if(!n) return 0; uint32_t v=peek(n); skip(n); return v; }
static inline int bit(void){ return (int)get(1); }
static int vlc(const plm_vlc_t* t){
  plm_vlc_t s={0,0};
  do{ s=t[s.index+bit()]; }while(s.index>0 && !berr);
  if(s.index<0) berr=1;
  return s.value;
}
static int find_start(void){
  int p=(bpos+7)>>3;
  while(p+3<blen){ if(bp[p]==0 && bp[p+1]==0 && bp[p+2]==1){ bpos=(p+4)*8; return bp[p+3]; } p++; }
  bpos=blen*8; return -1;
}

/* ---------- tables ---------- */
static const u8 ZZ[64]={ 0,1,8,16,9,2,3,10, 17,24,32,25,18,11,4,5, 12,19,26,33,40,48,41,34, 27,20,13,6,7,14,21,28,
  35,42,49,56,57,50,43,36, 29,22,15,23,30,37,44,51, 58,59,52,45,38,31,39,46, 53,60,61,54,47,55,62,63 };
static const u8 ALT[64]={ 0,8,16,24,1,9,2,10, 17,25,32,40,48,56,57,49, 41,33,26,18,3,11,4,12, 19,27,34,42,50,58,35,43,
  51,59,20,28,5,13,6,14, 21,29,36,44,52,60,37,45, 53,61,22,30,7,15,23,31, 38,46,54,62,39,47,55,63 };
static const u8 DEF_INTRA[64]={ 8,16,19,22,26,27,29,34, 16,16,22,24,27,29,34,37, 19,22,26,27,29,34,34,38, 22,22,26,27,29,34,37,40,
  22,26,27,29,32,35,40,48, 26,27,29,32,35,40,48,58, 26,27,29,34,38,46,56,69, 27,29,35,38,46,56,69,83 };
static const u8 NONLIN_Q[32]={ 0,1,2,3,4,5,6,7,8,10,12,14,16,18,20,22,24,28,32,36,40,44,48,52,56,64,72,80,88,96,104,112 };
static const double FRATE[9]={ 25,24000/1001.0,24,25,30000/1001.0,30,50,60000/1001.0,60 };

/* run/level lookup over the next 16 bits: [0] B.14, [1] B.15. entry: len | run<<8 | level<<16, 0xFFFF... special: ESC / EOB */
#define RL_ESC 0x7f
#define RL_EOB 0x7e
static uint32_t rl_lut[2][65536];
static int tables_ready;
static void make_tables(void){
  if(tables_ready) return;
  for(int t=0;t<2;t++){
    const unsigned short (*tab)[2]= t ? RL_B15 : RL_B14;
    for(int i=0;i<113;i++){
      int code=tab[i][0], len=tab[i][1], run, lvl;
      if(i==111){ run=RL_ESC; lvl=0; } else if(i==112){ run=RL_EOB; lvl=0; } else { run=RL_RUN[i]; lvl=RL_LEVEL[i]; }
      uint32_t e=(uint32_t)len|((uint32_t)run<<8)|((uint32_t)lvl<<16);
      // sign bit follows ordinary codes: the lookup covers the code only
      uint32_t lo=(uint32_t)code<<(16-len), hi=lo+(1u<<(16-len));
      for(uint32_t k=lo;k<hi;k++) rl_lut[t][k]=e;
    }
  }
  tables_ready=1;
}

/* ---------- state ---------- */
static u8 inbuf[4<<20];
enum { E_NONE=0, E_CHROMA=1, E_MPEG1=2, E_DUALPRIME=3, E_SIZE=4, E_MEM=5 };
static int err;
static int sq_w, sq_h, mbw, mbh, stride_y, stride_c, have_seq, aspect_code, frate_code=3, matrix709, prog_seq;
static u8 intra_q[64], nonintra_q[64];

typedef struct { u8 *p[3]; } Buf;
static Buf bufs[3]; static double buf_pts[3];
static int ref0=-1, ref1=-1;           /* older and newer reference frame */
static int cur=-1;
static u8* rgba[4]; static double out_pts[4]; static int nout;
static double last_out_pts=-1, last_in_pts=-1, call_pts;

/* picture */
static int ptype, fc[2][2], dc_prec, pstruct, tff, fpfd, conceal, qst, ivf, altscan, have_pext;
static int pending, in_pic, skip_pic, open_field, open_struct, open_isb;
static int isfield, second, mbrows, curpar;
static u8 *dstp[3]; static int dsty, dstc;                 /* destination surface: base pointers and strides of the picture (field: doubled) */
static int pic_count, slice_errors;

/* slice and macroblock */
static int qs, dcpred[3], PMV[2][2][2];
enum { M_FRAME=0, M_FIELD, M_FIELD1, M_16X8 };
static int mmode, mmv[2][2][2], mfsel[2][2], mfwd, mbwd, have_motion;
static int addr, total;

/* ---------- IDCT (Wang, as in the MPEG Software Simulation Group decoder) ---------- */
#define W1 2841
#define W2 2676
#define W3 2408
#define W5 1609
#define W6 1108
#define W7 565
static void idct_row(int* b){
  int x0,x1,x2,x3,x4,x5,x6,x7,x8;
  if(!((x1=b[4]<<11)|(x2=b[6])|(x3=b[2])|(x4=b[1])|(x5=b[7])|(x6=b[5])|(x7=b[3]))){
    b[0]=b[1]=b[2]=b[3]=b[4]=b[5]=b[6]=b[7]=b[0]<<3; return; }
  x0=(b[0]<<11)+128;
  x8=W7*(x4+x5); x4=x8+(W1-W7)*x4; x5=x8-(W1+W7)*x5;
  x8=W3*(x6+x7); x6=x8-(W3-W5)*x6; x7=x8-(W3+W5)*x7;
  x8=x0+x1; x0-=x1;
  x1=W6*(x3+x2); x2=x1-(W2+W6)*x2; x3=x1+(W2-W6)*x3;
  x1=x4+x6; x4-=x6; x6=x5+x7; x5-=x7;
  x7=x8+x3; x8-=x3; x3=x0+x2; x0-=x2;
  x2=(181*(x4+x5)+128)>>8; x4=(181*(x4-x5)+128)>>8;
  b[0]=(x7+x1)>>8; b[1]=(x3+x2)>>8; b[2]=(x0+x4)>>8; b[3]=(x8+x6)>>8;
  b[4]=(x8-x6)>>8; b[5]=(x0-x4)>>8; b[6]=(x3-x2)>>8; b[7]=(x7-x1)>>8;
}
static inline int clip(int v,int lo,int hi){ return v<lo ? lo : v>hi ? hi : v; }
static void idct_col(int* b){
  int x0,x1,x2,x3,x4,x5,x6,x7,x8;
  if(!((x1=b[8*4]<<8)|(x2=b[8*6])|(x3=b[8*2])|(x4=b[8*1])|(x5=b[8*7])|(x6=b[8*5])|(x7=b[8*3]))){
    int v=clip((b[0]+32)>>6,-256,255); for(int i=0;i<8;i++) b[8*i]=v; return; }
  x0=(b[0]<<8)+8192;
  x8=W7*(x4+x5)+4; x4=(x8+(W1-W7)*x4)>>3; x5=(x8-(W1+W7)*x5)>>3;
  x8=W3*(x6+x7)+4; x6=(x8-(W3-W5)*x6)>>3; x7=(x8-(W3+W5)*x7)>>3;
  x8=x0+x1; x0-=x1;
  x1=W6*(x3+x2)+4; x2=(x1-(W2+W6)*x2)>>3; x3=(x1+(W2-W6)*x3)>>3;
  x1=x4+x6; x4-=x6; x6=x5+x7; x5-=x7;
  x7=x8+x3; x8-=x3; x3=x0+x2; x0-=x2;
  x2=(181*(x4+x5)+128)>>8; x4=(181*(x4-x5)+128)>>8;
  b[8*0]=clip((x7+x1)>>14,-256,255); b[8*1]=clip((x3+x2)>>14,-256,255);
  b[8*2]=clip((x0+x4)>>14,-256,255); b[8*3]=clip((x8+x6)>>14,-256,255);
  b[8*4]=clip((x8-x6)>>14,-256,255); b[8*5]=clip((x0-x4)>>14,-256,255);
  b[8*6]=clip((x3-x2)>>14,-256,255); b[8*7]=clip((x7-x1)>>14,-256,255);
}
static void idct(int* b){ for(int i=0;i<8;i++) idct_row(b+8*i); for(int i=0;i<8;i++) idct_col(b+i); }

/* ---------- motion compensation ---------- */
/* block w x h of the reference surface (base ref, row stride rs, size rw x rh), top left (x, y) in whole samples,
   half-sample flags hx, hy; written (avg = 0) or averaged with what is already there (avg = 1) */
static void mc(u8* dst,int ds,const u8* ref,int rs,int rw,int rh,int x,int y,int hx,int hy,int w,int h,int avg){
  u8 tmp[17*17];
  const u8* s; int ss;
  if(x<0 || y<0 || x+w+hx>rw || y+h+hy>rh){
    for(int j=0;j<h+1;j++){ int yy=clip(y+j,0,rh-1);
      for(int i=0;i<w+1;i++) tmp[j*17+i]=ref[yy*rs+clip(x+i,0,rw-1)]; }
    s=tmp; ss=17;
  }else{ s=ref+y*rs+x; ss=rs; }
  for(int j=0;j<h;j++){
    const u8* a=s+j*ss; const u8* c=a+ss; u8* d=dst+j*ds;
    for(int i=0;i<w;i++){
      int v;
      if(!hx && !hy) v=a[i];
      else if(hx && !hy) v=(a[i]+a[i+1]+1)>>1;
      else if(!hx && hy) v=(a[i]+c[i]+1)>>1;
      else v=(a[i]+a[i+1]+c[i]+c[i+1]+2)>>2;
      d[i]=avg ? (u8)((d[i]+v+1)>>1) : (u8)v;
    }
  }
}

/* frame buffer to use as the reference of direction s (0 forward, 1 backward) for a field of parity par */
static int ref_for(int s,int par){
  if(ptype==3) return s ? ref1 : ref0;
  if(isfield && second && par!=curpar) return cur;           /* second field of a P frame predicts from the first */
  return ref1;
}

/* prediction of the current macroblock from direction s */
static void predict(int s,int avg,int mx,int my){
  int fh=mbh*16, cw=mbw*8;
  if(mmode==M_FRAME){
    int r=ref_for(s,0); if(r<0) return;
    int vx=mmv[0][s][0], vy=mmv[0][s][1];
    mc(dstp[0]+my*16*dsty+mx*16,dsty,bufs[r].p[0],stride_y,stride_y,fh,mx*16+(vx>>1),my*16+(vy>>1),vx&1,vy&1,16,16,avg);
    int cx=vx/2, cy=vy/2;
    for(int c=1;c<3;c++)
      mc(dstp[c]+my*8*dstc+mx*8,dstc,bufs[r].p[c],stride_c,cw,fh/2,mx*8+(cx>>1),my*8+(cy>>1),cx&1,cy&1,8,8,avg);
  }else if(mmode==M_FIELD){                                 /* frame picture, two field vectors */
    for(int q=0;q<2;q++){
      int par=mfsel[q][s], r=ref_for(s,par); if(r<0) continue;
      int vx=mmv[q][s][0], vy=mmv[q][s][1], cx=vx/2, cy=vy/2;
      mc(dstp[0]+(my*16+q)*dsty+mx*16,dsty*2,bufs[r].p[0]+par*stride_y,stride_y*2,stride_y,fh/2,
         mx*16+(vx>>1),my*8+(vy>>1),vx&1,vy&1,16,8,avg);
      for(int c=1;c<3;c++)
        mc(dstp[c]+(my*8+q)*dstc+mx*8,dstc*2,bufs[r].p[c]+par*stride_c,stride_c*2,cw,fh/4,
           mx*8+(cx>>1),my*4+(cy>>1),cx&1,cy&1,8,4,avg);
    }
  }else{                                                    /* field picture: M_FIELD1 (16x16) or M_16X8 */
    int parts=mmode==M_16X8 ? 2 : 1, h=16/parts;
    for(int q=0;q<parts;q++){
      int par=mfsel[q][s], r=ref_for(s,par); if(r<0) continue;
      int vx=mmv[q][s][0], vy=mmv[q][s][1], cx=vx/2, cy=vy/2, oy=q*h;
      mc(dstp[0]+(my*16+oy)*dsty+mx*16,dsty,bufs[r].p[0]+par*stride_y,stride_y*2,stride_y,fh/2,
         mx*16+(vx>>1),my*16+oy+(vy>>1),vx&1,vy&1,16,h,avg);
      for(int c=1;c<3;c++)
        mc(dstp[c]+(my*8+oy/2)*dstc+mx*8,dstc,bufs[r].p[c]+par*stride_c,stride_c*2,cw,fh/4,
           mx*8+(cx>>1),my*8+oy/2+(cy>>1),cx&1,cy&1,8,h/2,avg);
    }
  }
}

static void predict_mb(int mx,int my){
  if(mfwd && mbwd){ predict(0,0,mx,my); predict(1,1,mx,my); }
  else if(mfwd) predict(0,0,mx,my);
  else if(mbwd) predict(1,0,mx,my);
}

/* ---------- motion vectors ---------- */
static int mvdec(int fcode,int pred){
  int rs=fcode-1, fs=1<<rs;
  int code=vlc(PLM_VIDEO_MOTION), d;
  if(code!=0 && fs!=1){
    int res=(int)get(rs);
    d=((code<0 ? -code : code)-1)*fs+res+1; if(code<0) d=-d;
  }else d=code;
  int v=pred+d;
  if(v>fs*16-1) v-=fs*32; else if(v< -fs*16) v+=fs*32;
  return v;
}
static void read_mvs(int s){
  int cnt=(mmode==M_FIELD || mmode==M_16X8) ? 2 : 1;
  int fieldfmt=mmode!=M_FRAME;
  for(int r=0;r<cnt;r++){
    if(fieldfmt) mfsel[r][s]=bit();
    int mx=mvdec(fc[s][0],PMV[r][s][0]); PMV[r][s][0]=mx;
    int pv=PMV[r][s][1]; if(mmode==M_FIELD) pv>>=1;
    int my=mvdec(fc[s][1],pv); PMV[r][s][1]= mmode==M_FIELD ? my*2 : my;
    mmv[r][s][0]=mx; mmv[r][s][1]=my;
  }
  if(cnt==1){
    PMV[1][s][0]=PMV[0][s][0]; PMV[1][s][1]=PMV[0][s][1];
    mmv[1][s][0]=mmv[0][s][0]; mmv[1][s][1]=mmv[0][s][1]; mfsel[1][s]=mfsel[0][s];
  }
}

/* ---------- blocks ---------- */
static int coef[64];

/* dct_dc_size_luminance / chrominance, sizes 0..11 (MPEG-2 allows up to 11 bits of DC precision) */
static const unsigned short DC_CODE[2][12]={{4,0,1,5,6,0xe,0x1e,0x3e,0x7e,0xfe,0x1fe,0x1ff},{0,1,2,6,0xe,0x1e,0x3e,0x7e,0xfe,0x1fe,0x3fe,0x3ff}};
static const u8 DC_BITS[2][12]={{3,2,2,3,3,4,5,6,7,8,9,9},{2,2,2,3,4,5,6,7,8,9,10,10}};
static int dc_size(int chroma){
  uint32_t v=peek(10);
  for(int i=0;i<12;i++){ int l=DC_BITS[chroma][i]; if((v>>(10-l))==DC_CODE[chroma][i]){ skip(l); return i; } }
  berr=1; return 0;
}

/* decodes one block into coef[] (dequantised); returns 0 on error */
static int block(int b,int intra){
  zero(coef,sizeof(coef));
  int n=0, parity=0;
  const u8* scan=altscan ? ALT : ZZ;
  const u8* W=intra ? intra_q : nonintra_q;
  if(intra){
    int comp= b<4 ? 0 : b-3;
    int size=dc_size(comp!=0);
    int diff=0;
    if(size>0){ int v=(int)get(size); diff=(v&(1<<(size-1))) ? v : v-((1<<size)-1); }
    dcpred[comp]+=diff;
    coef[0]=dcpred[comp]*(8>>dc_prec);
    parity=coef[0]&1; n=1;
  }
  const uint32_t* lut=rl_lut[intra && ivf ? 1 : 0];
  int first=!intra;
  for(;;){
    int run, lvl;
    if(first && peek(1)){ skip(1); run=0; lvl=1; }          /* B.14, first coefficient: "1s" */
    else{
      uint32_t e=lut[peek(16)];
      int len=e&0xff, r=(e>>8)&0xff;
      if(len==0){ berr=1; return 0; }
      if(r==RL_EOB){ if(first && !intra){ berr=1; return 0; } skip(len); break; }
      if(r==RL_ESC){ skip(len); run=(int)get(6); int v=(int)get(12); lvl= v>=2048 ? v-4096 : v;
        if(lvl==0 || lvl==-2048){ berr=1; return 0; }
        n+=run; if(n>63){ berr=1; return 0; }
        goto have_level_signed;
      }
      skip(len); run=r; lvl=(int)((e>>16)&0xff);
    }
    n+=run; if(n>63){ berr=1; return 0; }
    if(bit()) lvl=-lvl;
  have_level_signed:
    {
      int pos=scan[n], v;
      if(intra) v=(lvl*W[pos]*qs)/16;
      else v=((2*lvl+(lvl>0 ? 1 : -1))*W[pos]*qs)/32;
      v=clip(v,-2048,2047);
      coef[pos]=v; parity^=v&1; n++;
    }
    first=0;
    if(berr) return 0;
  }
  if(!(parity&1)) coef[63]^=1;                                       /* mismatch control */
  return 1;
}

static inline void put_intra(u8* d,int ds,const int* r){
  for(int j=0;j<8;j++) for(int i=0;i<8;i++) d[j*ds+i]=(u8)clip(r[j*8+i],0,255);
}
static inline void put_inter(u8* d,int ds,const int* r){
  for(int j=0;j<8;j++) for(int i=0;i<8;i++) d[j*ds+i]=(u8)clip(d[j*ds+i]+r[j*8+i],0,255);
}

/* ---------- macroblock ---------- */
static int dct_field;

static int do_blocks(int mx,int my,int intra,int cbp){
  for(int b=0;b<6;b++){
    if(!(cbp&(0x20>>b))) continue;
    if(!block(b,intra)) return 0;
    idct(coef);
    u8* d; int ds;
    if(b<4){
      int bx=(b&1)*8, by=(b>>1)*8;
      if(dct_field){ d=dstp[0]+(my*16+(b>>1))*dsty+mx*16+bx; ds=dsty*2; }
      else{ d=dstp[0]+(my*16+by)*dsty+mx*16+bx; ds=dsty; }
    }else{ d=dstp[b-3]+my*8*dstc+mx*8; ds=dstc; }
    if(intra) put_intra(d,ds,coef); else put_inter(d,ds,coef);
  }
  return 1;
}

static void default_motion(void){                                   /* zero vector, forward only */
  mmode= isfield ? M_FIELD1 : M_FRAME;
  mfwd=1; mbwd=0;
  for(int s=0;s<2;s++) for(int r=0;r<2;r++){ mmv[r][s][0]=mmv[r][s][1]=0; mfsel[r][s]=curpar; }
}

static void skipped_mb(int mx,int my){
  if(ptype==2){
    default_motion();
    for(int r=0;r<2;r++) for(int s=0;s<2;s++) PMV[r][s][0]=PMV[r][s][1]=0;
  }else if(!have_motion) default_motion();
  else{                                                             /* B: direction of the previous macroblock, its predictor as the vector, frame / field mode of the picture */
    mmode= isfield ? M_FIELD1 : M_FRAME;
    for(int s=0;s<2;s++) for(int r=0;r<2;r++){ mmv[r][s][0]=PMV[0][s][0]; mmv[r][s][1]=PMV[0][s][1]; mfsel[r][s]=curpar; }
  }
  predict_mb(mx,my);
}

static int macroblock(int first){
  int inc=0, t=vlc(PLM_VIDEO_MACROBLOCK_ADDRESS_INCREMENT);
  while(t==34 && !berr) t=vlc(PLM_VIDEO_MACROBLOCK_ADDRESS_INCREMENT);
  while(t==35 && !berr){ inc+=33; t=vlc(PLM_VIDEO_MACROBLOCK_ADDRESS_INCREMENT); }
  inc+=t;
  if(berr || inc<1) return 0;
  if(first) addr+=inc;
  else{
    if(addr+inc>=total) return 0;
    if(inc>1){
      dcpred[0]=dcpred[1]=dcpred[2]=1<<(7+dc_prec);
      for(int k=1;k<inc;k++){ addr++; skipped_mb(addr%mbw,addr/mbw); }
    }
    addr++;
  }
  if(addr>=total) return 0;
  int mx=addr%mbw, my=addr/mbw;
  int mt=vlc(PLM_VIDEO_MACROBLOCK_TYPE[ptype]);
  if(berr) return 0;
  int intra=mt&1, pattern=mt&2;
  mbwd=(mt&4)!=0; mfwd=(mt&8)!=0;
  if(mt&0x10){ int c=(int)get(5); qs= qst ? NONLIN_Q[c] : c*2; }
  int mtype=0;
  if(mfwd || mbwd){
    if(!isfield){ mtype= fpfd ? 2 : (int)get(2); }
    else mtype=(int)get(2);
  }
  dct_field=0;
  if(!isfield && !fpfd && (intra || pattern)) dct_field=bit();
  if(berr) return 0;

  if(intra){
    if(conceal){                                                    /* concealment vectors: read and ignore */
      int sv_mode=mmode; mmode= isfield ? M_FIELD1 : M_FRAME;
      read_mvs(0); bit(); mmode=sv_mode;
    }
    for(int r=0;r<2;r++) for(int s=0;s<2;s++) PMV[r][s][0]=PMV[r][s][1]=0;
    have_motion=0;
    return do_blocks(mx,my,1,0x3f);
  }
  dcpred[0]=dcpred[1]=dcpred[2]=1<<(7+dc_prec);
  if(mfwd || mbwd){
    if(!isfield) mmode= mtype==1 ? M_FIELD : M_FRAME;
    else mmode= mtype==2 ? M_16X8 : M_FIELD1;
    if(mtype==3){ err=E_DUALPRIME; return 0; }
    if(mtype==0){ berr=1; return 0; }
    for(int s=0;s<2;s++) if(s ? mbwd : mfwd) read_mvs(s);
    have_motion=1;
  }else{                                                            /* P: no motion code, zero vector */
    default_motion();
    for(int r=0;r<2;r++) for(int s=0;s<2;s++) PMV[r][s][0]=PMV[r][s][1]=0;
    have_motion=1;
  }
  int cbp= pattern ? vlc(PLM_VIDEO_CODE_BLOCK_PATTERN) : 0;
  if(berr) return 0;
  predict_mb(mx,my);
  return cbp ? do_blocks(mx,my,0,cbp) : 1;
}

static void slice(int row){
  if(row<0 || row>=mbrows) return;
  addr=row*mbw-1;
  dcpred[0]=dcpred[1]=dcpred[2]=1<<(7+dc_prec);
  for(int r=0;r<2;r++) for(int s=0;s<2;s++) PMV[r][s][0]=PMV[r][s][1]=0;
  have_motion=0;
  int c=(int)get(5); qs= qst ? NONLIN_Q[c] : c*2;
  while(bit() && !berr) skip(8);
  int first=1;
  do{
    if(!macroblock(first)){ slice_errors++; return; }
    first=0;
  }while(addr<total-1 && peek(23)!=0 && !berr);
}

/* ---------- output ---------- */
static void emit(int idx){
  if(idx<0 || !rgba[0] || nout>=4) return;
  double pts=buf_pts[idx];
  double dur=1.0/FRATE[frate_code>0&&frate_code<9 ? frate_code : 3];
  if(pts<0) pts= last_out_pts>=0 ? last_out_pts+dur : 0;
  last_out_pts=pts;
  u8* o=rgba[nout]; out_pts[nout]=pts; nout++;
  const u8 *Y=bufs[idx].p[0], *U=bufs[idx].p[1], *V=bufs[idx].p[2];
  int cr_r, cg_u, cg_v, cb_b;
  if(matrix709){ cr_r=459; cg_u=55; cg_v=136; cb_b=541; } else { cr_r=409; cg_u=100; cg_v=208; cb_b=516; }
  for(int y=0;y<sq_h;y++){
    const u8* yr=Y+y*stride_y; const u8* ur=U+(y>>1)*stride_c; const u8* vr=V+(y>>1)*stride_c;
    for(int x=0;x<sq_w;x++){
      int yy=298*(yr[x]-16), u=ur[x>>1]-128, v=vr[x>>1]-128;
      *o++=(u8)clip((yy+cr_r*v+128)>>8,0,255);
      *o++=(u8)clip((yy-cg_u*u-cg_v*v+128)>>8,0,255);
      *o++=(u8)clip((yy+cb_b*u+128)>>8,0,255);
      *o++=255;
    }
  }
}

/* a whole frame (or both fields) is decoded */
static void finish_frame(void){
  open_field=0;
  if(cur<0) return;
  if(ptype==3) emit(cur);
  else{
    if(ref1>=0) emit(ref1);
    ref0=ref1; ref1=cur;
  }
  cur=-1;
}

static void pic_end(void){
  if(!in_pic) return;
  in_pic=0;
  if(skip_pic) return;
  pic_count++;
  if(isfield && !second){ open_field=1; open_struct=pstruct; open_isb=(ptype==3); return; }
  finish_frame();
}

static void pic_begin(void){
  pending=0; in_pic=1; skip_pic=0;
  if(err==E_CHROMA){ skip_pic=1; return; }
  if(!have_seq || !have_pext){ skip_pic=1; if(have_seq && !have_pext) err=E_MPEG1; return; }
  isfield= pstruct!=3;
  second=0;
  if(open_field){
    if(isfield && pstruct!=open_struct && (ptype==3)==(open_isb!=0)) second=1;
    else{ int sp=ptype; ptype= open_isb ? 3 : 2; finish_frame(); ptype=sp; }      /* unmatched first field: show it as it is */
  }
  if(ptype==3 && (ref0<0 || ref1<0)) { skip_pic=1; return; }
  if(ptype==2 && ref1<0 && !second) { skip_pic=1; return; }
  if(!second){
    int f=0; while(f==ref0 || f==ref1) f++;
    cur=f;
    buf_pts[cur]=call_pts;
  }
  if(cur<0){ skip_pic=1; return; }
  curpar= pstruct==2;
  mbrows= isfield ? mbh/2 : mbh;
  total=mbrows*mbw;
  int off= pstruct==2 ? 1 : 0;
  dsty= isfield ? stride_y*2 : stride_y;
  dstc= isfield ? stride_c*2 : stride_c;
  dstp[0]=bufs[cur].p[0]+off*stride_y;
  dstp[1]=bufs[cur].p[1]+off*stride_c;
  dstp[2]=bufs[cur].p[2]+off*stride_c;
}

/* ---------- headers ---------- */
static int seq_alloc(void){
  heap_top=(unsigned)&__heap_base;
  stride_y=mbw*16; stride_c=mbw*8;
  unsigned ys=(unsigned)stride_y*mbh*16, cs=(unsigned)stride_c*mbh*8;
  for(int i=0;i<3;i++){
    u8* p=halloc(ys+2*cs); if(!p) return 0;
    bufs[i].p[0]=p; bufs[i].p[1]=p+ys; bufs[i].p[2]=p+ys+cs;
    zero(p,ys); for(unsigned k=0;k<2*cs;k++) p[ys+k]=128;
  }
  for(int i=0;i<4;i++){ rgba[i]=halloc((unsigned)sq_w*sq_h*4); if(!rgba[i]) return 0; }
  ref0=ref1=cur=-1; open_field=0;
  return 1;
}

static void seq_header(void){
  int w=(int)get(12), h=(int)get(12);
  aspect_code=(int)get(4); frate_code=(int)get(4);
  skip(18+1+10+1);
  if(w<=0 || h<=0 || w>1920 || h>1088){ err=E_SIZE; return; }
  int imx=(w+15)>>4, imy=(h+15)>>4;
  int changed= !have_seq || w!=sq_w || h!=sq_h;
  if(bit()){ for(int i=0;i<64;i++) intra_q[ZZ[i]]=(u8)get(8); } else copy(intra_q,DEF_INTRA,64);
  if(bit()){ for(int i=0;i<64;i++) nonintra_q[ZZ[i]]=(u8)get(8); } else for(int i=0;i<64;i++) nonintra_q[i]=16;
  if(changed){
    sq_w=w; sq_h=h; mbw=imx; mbh=imy;
    have_seq=0;
    if(!seq_alloc()){ err=E_MEM; return; }
    matrix709= h>=720;
  }
  have_seq=1;
}

static void ext_header(void){
  int id=(int)get(4);
  if(id==1){                                                        /* sequence extension */
    skip(8); prog_seq=bit(); int chroma=(int)get(2); skip(2+2+12+1+8+1+2+5);
    if(chroma!=1) err=E_CHROMA;
  }else if(id==2){                                                  /* sequence display extension */
    skip(3); if(bit()){ skip(16); int m=(int)get(8); matrix709= m==1; }
  }else if(id==3){                                                  /* quantiser matrix extension */
    if(bit()) for(int i=0;i<64;i++) intra_q[ZZ[i]]=(u8)get(8);
    if(bit()) for(int i=0;i<64;i++) nonintra_q[ZZ[i]]=(u8)get(8);
  }else if(id==8){                                                  /* picture coding extension */
    fc[0][0]=(int)get(4); fc[0][1]=(int)get(4); fc[1][0]=(int)get(4); fc[1][1]=(int)get(4);
    dc_prec=(int)get(2); pstruct=(int)get(2); tff=bit(); fpfd=bit(); conceal=bit(); qst=bit(); ivf=bit(); altscan=bit();
    skip(1+1+1); if(bit()) skip(20);
    have_pext=1;
    if(pstruct==0) have_pext=0;
  }
}

static void pic_header(void){
  skip(10); ptype=(int)get(3); skip(16);
  if(ptype==2 || ptype==3){ skip(1); get(3); }
  if(ptype==3){ skip(1); get(3); }
  have_pext=0;
  pending=1;
}

/* ---------- interface ---------- */
void m2_reset(void){ ref0=ref1=cur=-1; open_field=0; pending=in_pic=0; last_out_pts=-1; }
u8* m2_in(void){ make_tables(); return inbuf; }
int m2_cap(void){ return (int)sizeof(inbuf); }
int m2_w(void){ return sq_w; }
int m2_h(void){ return sq_h; }
int m2_aspect(void){ return aspect_code; }
int m2_prog(void){ return prog_seq; }
int m2_err(void){ return err; }
int m2_pics(void){ return pic_count; }
int m2_bad(void){ return slice_errors; }
double m2_rate(void){ return FRATE[frate_code>0&&frate_code<9 ? frate_code : 3]; }
u8* m2_frame(int i){ return rgba[i]; }
double m2_pts(int i){ return out_pts[i]; }

int m2_decode(int len,double pts){
  make_tables();
  bp=inbuf; blen=len; bpos=0; berr=0; nout=0; call_pts=pts; err= err==E_MEM ? err : 0;
  int code;
  while((code=find_start())>=0){
    berr=0;
    if(code==0x00){ pic_end(); pic_header(); }
    else if(code>=0x01 && code<=0xAF){
      if(pending) pic_begin();
      if(in_pic && !skip_pic){ slice(code-1); berr=0; }
    }
    else if(code==0xB3){ pic_end(); seq_header(); }
    else if(code==0xB5){ ext_header(); }
    else if(code==0xB7 || code==0xB8){ pic_end(); }
  }
  pic_end();
  return nout;
}

int m2_flush(void){
  nout=0;
  if(open_field){ int sp=ptype; ptype= open_isb ? 3 : 2; finish_frame(); ptype=sp; }
  if(ref1>=0){ emit(ref1); ref1=-1; }
  return nout;
}
