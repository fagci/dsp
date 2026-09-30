#include "m17.h"
#include <stdio.h>
#include <stdlib.h>
static void syms(const char* n, const float* s, int len){ printf("%s:",n); for(int i=0;i<len;i++){ int v=(int)(s[i]>0 ? (s[i]>2?1:0) : (s[i]<-2?3:2)); printf("%d",v);} printf("\n"); }
static void hex(const char* n, const uint8_t* d, int l){ printf("%s:",n); for(int i=0;i<l;i++) printf("%02X",d[i]); printf("\n"); }
int main(){
  lsf_t lsf; uint8_t meta[14]={0}; 
  set_LSF(&lsf,"SP5WWP","W2FBI",M17_TYPE_STREAM|M17_TYPE_VOICE|M17_TYPE_CAN(3),meta);
  set_LSF_meta_ecd(&lsf,"SP5WWP","M17-M17 C");
  update_LSF_CRC(&lsf);
  hex("lsf_dst",lsf.dst,6); hex("lsf_src",lsf.src,6); hex("lsf_type",lsf.type,2); hex("lsf_meta",lsf.meta,14); hex("lsf_crc",lsf.crc,2);
  float out[192];
  gen_frame(out,NULL,FRAME_LSF,&lsf,0,0); syms("lsf_frame",out,192);
  uint8_t data[16]; for(int i=0;i<16;i++) data[i]=0x10+i;
  for(int c=0;c<6;c++){ char nm[16]; sprintf(nm,"str_%d",c); gen_frame(out,data,FRAME_STR,&lsf,c,c==5 ? 0x8005 : 100+c); syms(nm,out,192); }
  uint8_t pk[26]; for(int i=0;i<25;i++) pk[i]=0x41+i; pk[25]=(1<<7)|(20<<2)?0:0; 
  pk[25]=0; // frame 0, not last
  gen_frame(out,pk,FRAME_PKT,&lsf,0,0); syms("pkt_0",out,192);
  uint8_t pk2[26]; for(int i=0;i<25;i++) pk2[i]=0x61+i; pk2[25]=(1<<7)|(7<<2)?((1<<7)|(7<<2)):0; // EOF, 7 bytes: bits: eof at top of 6-bit? check API
  gen_frame(out,pk2,FRAME_PKT,&lsf,0,0); syms("pkt_1",out,192);
  uint8_t bert[25]; for(int i=0;i<25;i++) bert[i]=0xA5^i; gen_frame(out,bert,FRAME_BERT,&lsf,0,0); syms("bert",out,192);
  printf("crc_A:%04X\n",CRC_M17((const uint8_t*)"A",1)); printf("crc_123:%04X\n",CRC_M17((const uint8_t*)"123456789",9));
  uint8_t cs[6]; encode_callsign_bytes(cs,"AB1CD"); hex("cs_AB1CD",cs,6);
  uint8_t l[6]={1,2,3,4,5,6}, enc[12]; encode_LICH(enc,l); hex("lich_enc",enc,12);
  printf("golay:%06X %06X\n",golay24_encode(0x123),golay24_encode(0xFFF));
  return 0; }
