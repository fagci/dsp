/* mbelib reference: native build of the same sources as vendor/mbelib.wasm. Reads frames (one line: type imbe|a2450|a2400, then 0/1 bits
   of the 8x23 / 4x24 matrix in row order), keeps decoder state between lines, prints 160 samples per frame as int16 hex (little endian).
   Same xorshift rand() as tools/mbelib/mbelib-wasm.c, seeded 0x1234567 + frame number, so the noise of unvoiced bands matches.
   gcc -O1 -w -I/path/to/mbelib mbelibref.c /path/to/mbelib/{mbelib,ecc,imbe7200x4400,ambe3600x2400,ambe3600x2450}.c -lm */
#include "mbelib.h"
#include <stdio.h>
#include <string.h>
static unsigned rnd_s=0x2545F491u;
int rand(void){ rnd_s^=rnd_s<<13; rnd_s^=rnd_s>>17; rnd_s^=rnd_s<<5; return (int)(rnd_s&0x7FFFFFFF); }
int main(){
  mbe_parms cur,prv,enh; mbe_initMbeParms(&cur,&prv,&enh);
  char type[16], bits[400]; char fr[8][23]; char fa[4][24]; char dd[88]; short pcm[160]; char es[64]; int e,e2;
  int ln=0; char last[16]="";
  while(scanf("%15s %399s",type,bits)==2){
    rnd_s=0x1234567u+(unsigned)(ln++); memset(dd,0,sizeof dd); memset(es,0,sizeof es);              /* per-frame seed, the test seeds the wasm the same way */
    if(strcmp(type,last)){ mbe_initMbeParms(&cur,&prv,&enh); strcpy(last,type); }   /* a fresh decoder state per frame type, like a new handle in the wasm */
    if(!strcmp(type,"imbe")){ for(int i=0;i<184;i++) fr[i/23][i%23]=bits[i]-'0'; mbe_processImbe7200x4400Frame(pcm,&e,&e2,es,fr,dd,&cur,&prv,&enh,3); }
    else { for(int i=0;i<96;i++) fa[i/24][i%24]=bits[i]-'0';
      if(!strcmp(type,"a2450")) mbe_processAmbe3600x2450Frame(pcm,&e,&e2,es,fa,dd,&cur,&prv,&enh,3); else mbe_processAmbe3600x2400Frame(pcm,&e,&e2,es,fa,dd,&cur,&prv,&enh,3); }
    printf("%d ",e); for(int i=0;i<160;i++) printf("%04X",(unsigned short)pcm[i]); printf("\n");
  }
  return 0; }
