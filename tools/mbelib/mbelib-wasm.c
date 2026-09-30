/* mbelib (ISC) as a freestanding wasm module: no libc, cosf / powf are imported from the host.
   One handle = one vocoder state (previous frame parameters), so several streams can run side by side. */
#include "mbelib.h"
#include <stdlib.h>
void* memset(void* d,int c,unsigned long n){ unsigned char* p=d; while(n--) *p++=(unsigned char)c; return d; }
void* memcpy(void* d,const void* s,unsigned long n){ unsigned char* p=d; const unsigned char* q=s; while(n--) *p++=*q++; return d; }
long strtol(const char* s,char** e,int base){ long v=0; while(*s>='0' && *s<'0'+base){ v=v*base+(*s-'0'); s++; } if(e) *e=(char*)s; return v; }

#define MAXH 16
static mbe_parms cur[MAXH], prv[MAXH], enh[MAXH];
static char used[MAXH];
static unsigned rnd_s=0x2545F491u;
int rand(void){ rnd_s^=rnd_s<<13; rnd_s^=rnd_s>>17; rnd_s^=rnd_s<<5; return (int)(rnd_s&0x7FFFFFFF); }

/* buffers the host reads and writes */
static char fr[8*23];        /* IMBE 8x23 or AMBE 4x24 frame, one bit per byte */
static char dd[88];
static short pcm[160];
static char es[64];
void mbx_seed(unsigned s){ rnd_s=s ? s : 1; }     /* noise of the unvoiced bands; the tests seed it per frame */
char* mbx_frame(void){ return fr; }
short* mbx_pcm(void){ return pcm; }
char* mbx_data(void){ return dd; }               /* decoded 49 / 88 parameter bits of the last frame (debug) */

int mbx_new(void){
  for(int i=0;i<MAXH;i++) if(!used[i]){ used[i]=1; mbe_initMbeParms(&cur[i],&prv[i],&enh[i]); return i; }
  return -1;
}
void mbx_free(int h){ if(h>=0 && h<MAXH) used[h]=0; }
void mbx_reset(int h){ mbe_initMbeParms(&cur[h],&prv[h],&enh[h]); }

/* return: bit errors in the first Golay word (errs); pcm has 160 samples at 8 kHz */
int mbx_imbe(int h,int q){ int e=0,e2=0; mbe_processImbe7200x4400Frame(pcm,&e,&e2,es,(char(*)[23])fr,dd,&cur[h],&prv[h],&enh[h],q); return e; }
int mbx_ambe2450(int h,int q){ int e=0,e2=0; mbe_processAmbe3600x2450Frame(pcm,&e,&e2,es,(char(*)[24])fr,dd,&cur[h],&prv[h],&enh[h],q); return e; }
/* AMBE+2 parameter bits already error-corrected (49 in mbx_frame(), one per byte): YSF V/D mode 2 does its own majority vote */
int mbx_ambe2450_data(int h,int q){ int e=0,e2=0; memcpy(dd,fr,49); mbe_processAmbe2450Data(pcm,&e,&e2,es,dd,&cur[h],&prv[h],&enh[h],q); return e; }
int mbx_ambe2400(int h,int q){ int e=0,e2=0; mbe_processAmbe3600x2400Frame(pcm,&e,&e2,es,(char(*)[24])fr,dd,&cur[h],&prv[h],&enh[h],q); return e; }
