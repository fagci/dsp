/* Codec 2 (LGPL 2.1) as a freestanding wasm module for the M17 modes 3200 and 1600: no libc; the host supplies the transcendental
   functions (Math.*). malloc is a bump allocator over the linear memory - a codec is created once per stream (decoding or encoding),
   and freed ones are reused, so nothing needs to be given back. */
#include "codec2.h"
#include <stdlib.h>
#include <string.h>

extern unsigned char __heap_base;
static unsigned long heap_top;
void* malloc(size_t n){
  if(!heap_top) heap_top=(unsigned long)&__heap_base;
  heap_top=(heap_top+15)&~15UL;
  unsigned long p=heap_top; heap_top+=n;
  unsigned long need=heap_top, have=(unsigned long)__builtin_wasm_memory_size(0)*65536UL;
  if(need>have){ unsigned long pages=(need-have+65535)/65536; if(__builtin_wasm_memory_grow(0,pages)==-1) return 0; }
  return (void*)p;
}
void* calloc(size_t a,size_t b){ void* p=malloc(a*b); if(p) memset(p,0,a*b); return p; }
void free(void* p){ (void)p; }
void* memset(void* d,int c,size_t n){ unsigned char* p=d; while(n--) *p++=(unsigned char)c; return d; }
void* memcpy(void* d,const void* s,size_t n){ unsigned char* p=d; const unsigned char* q=s; while(n--) *p++=*q++; return d; }
void* memmove(void* d,const void* s,size_t n){ unsigned char* p=d; const unsigned char* q=s; if(p<q) while(n--) *p++=*q++; else { p+=n; q+=n; while(n--) *--p=*--q; } return d; }
static unsigned rs=0x2545F491u;
int rand(void){ rs^=rs<<13; rs^=rs>>17; rs^=rs<<5; return (int)(rs&0x7FFFFFFF); }

#define MAXH 8
static struct CODEC2* dec[MAXH]; static int mode_of[MAXH];
static unsigned char in[16];
static short pcm[640];
unsigned char* c2_bits(void){ return in; }
short* c2_pcm(void){ return pcm; }
/* mode: 3200 or 1600; returns a handle (decoders of the same mode are reused) */
int c2_new(int mode){
  int m=mode==1600 ? CODEC2_MODE_1600 : CODEC2_MODE_3200;
  for(int i=0;i<MAXH;i++) if(dec[i] && mode_of[i]==-1-m){ mode_of[i]=m; return i; }     /* a released one */
  for(int i=0;i<MAXH;i++) if(!dec[i]){ dec[i]=codec2_create(m); if(!dec[i]) return -1; mode_of[i]=m; return i; }
  return -1;
}
void c2_free(int h){ if(h>=0 && h<MAXH && dec[h]) mode_of[h]=-1-mode_of[h]; }
int c2_samples(int h){ return codec2_samples_per_frame(dec[h]); }
/* decode the 8 bytes in c2_bits() into c2_samples(h) samples at c2_pcm() */
int c2_decode(int h){ codec2_decode(dec[h],pcm,in); return codec2_samples_per_frame(dec[h]); }
/* encode the c2_samples(h) samples at c2_pcm() into the bytes at c2_bits(); returns the number of bytes (8 in both modes) */
int c2_encode(int h){ codec2_encode(dec[h],in,pcm); return (codec2_bits_per_frame(dec[h])+7)/8; }
