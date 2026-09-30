// dPMR header frame (FS1, HI0 / HI1) built with the code of dsdcc (f4exb, GPLv3): Hamming(12,8), scrambler LFSR, interleaver dI120
// and CRC-8 are the ones from dpmr.cpp / fec.cpp; the encoder runs their decoder's steps backwards. Build:
//   g++ -std=c++11 -w -I. dpmrhdrref.cpp fec.cpp -o dpmrhdrref   (in a dsdcc checkout, with export.h available)
#include "fec.h"
#include <cstdio>
#include <cstring>
using namespace DSDcc;
struct Lfsr { unsigned m_sr; void init(){ m_sr=0x3FF; } unsigned next(){ m_sr>>=1; unsigned res=m_sr&1, fb=((((m_sr>>4)&1)^res)<<9); m_sr=(m_sr&0x1FF)|fb; return res; } };
static void crc8(unsigned char* bits,int n){
  unsigned char w[80]; memcpy(w,bits,n); memset(w+n,0,8);
  for(int i=0;i<n;i++) if(w[i]){ w[i]=0; w[i+6]^=1; w[i+7]^=1; w[i+8]^=1; }
  memcpy(bits+n,w+n,8);
}
static void put(unsigned char* b,int o,int n,unsigned v){ for(int i=0;i<n;i++) b[o+i]=(v>>(n-1-i))&1; }
int main(){
  Hamming_12_8 ham; Lfsr g; g.init(); unsigned char scr[120]; for(int i=0;i<120;i++) scr[i]=g.next()&1;
  unsigned dI120[120]; for(int i=0;i<120;i++) dI120[i]=12*(i%10)+(i/10);
  struct { int ht; unsigned called, own; int mode, format; } t[]={{0,0x1E240,0x0F1206,0,1},{3,0xABCDEF,0x123456,4,0},{6,0x000001,0x0A1B2C,5,1}};
  for(auto& h: t){
    unsigned char b[80]; memset(b,0,80);
    put(b,0,4,h.ht); put(b,4,24,h.called); put(b,28,24,h.own); put(b,52,3,h.mode); put(b,55,4,h.format);
    crc8(b,72);
    unsigned char enc[120];
    for(int w=0;w<10;w++) ham.encode(b+8*w,enc+12*w);
    printf("hdr %d %06X %06X %d %d ",h.ht,h.called,h.own,h.mode,h.format);
    for(int s=0;s<60;s++){ int m=enc[dI120[2*s]]^scr[2*s], l=enc[dI120[2*s+1]]^scr[2*s+1]; printf("%d",m*2+l); }
    printf("\n");
  }
  return 0; }
