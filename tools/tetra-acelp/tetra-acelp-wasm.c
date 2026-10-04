/* TETRA ACELP speech decoder (ETSI EN 300 395-2) as a freestanding wasm module: no libc. The codec is fixed point, so the module
   needs nothing from the host. State structures come from a bump allocator and are reused through a handle pool. */
#include <stdlib.h>
#include <string.h>
#include "tetra-codec.h"
#include "tetra-codec-impl.h"

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
void free(void* p){ (void)p; }
void* memset(void* d,int c,size_t n){ unsigned char* p=d; while(n--) *p++=(unsigned char)c; return d; }
void* memcpy(void* d,const void* s,size_t n){ unsigned char* p=d; const unsigned char* q=s; while(n--) *p++=*q++; return d; }
void* memmove(void* d,const void* s,size_t n){ unsigned char* p=d; const unsigned char* q=s; if(p<q) while(n--) *p++=*q++; else { p+=n; q+=n; while(n--) *--p=*--q; } return d; }

#define MAXH 16
static tetra_codec* dec[MAXH];
static unsigned char used[MAXH];
static unsigned char in[137];                 /* one byte per bit, in the order the codec lists them */
static short pcm[240];
unsigned char* ta_bits(void){ return in; }
short* ta_pcm(void){ return pcm; }
/* a decoder in its initial state (a released one is reset); -1 when the pool is full */
int ta_new(void){
  for(int i=0;i<MAXH;i++) if(!used[i]){
    if(!dec[i]) dec[i]=tetra_decoder_create(); else { init_tetra_codec(dec[i]); Init_Decod_Tetra(dec[i]); }
    if(!dec[i]) return -1;
    used[i]=1; return i;
  }
  return -1;
}
void ta_free(int h){ if(h>=0 && h<MAXH) used[h]=0; }
/* bits from ta_bits() → 240 samples at ta_pcm() (8 kHz); bfi — frame marked bad */
int ta_decode(int h,int bfi){
  unsigned char packed[18]; memset(packed,0,sizeof packed);
  for(int i=0;i<137;i++) packed[i>>3]|=(unsigned char)((in[i]&1)<<(7-(i&7)));
  tetra_decode(dec[h],packed,pcm,bfi);
  return 240;
}
