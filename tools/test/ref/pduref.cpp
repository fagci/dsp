// P25 multi-block PDU: MMDVMHost rate 3/4 trellis, CRC-32 and CRC-9 as in dsd-fme (p25p1_mdpu.c, dmr_utils.c)
#include "P25Trellis.h"
#include <cstdio>
#include <cstring>
#include <cstdint>
static void hex(const char* n, const unsigned char* d, unsigned l){ printf("%s:",n); for(unsigned i=0;i<l;i++) printf("%02X",d[i]); printf("\n"); }
static uint32_t crc32mbf(uint8_t* buf, int len){
  uint32_t g=0x04c11db7; uint64_t crc=0;
  for(int i=0;i<len;i++){ crc<<=1; int b=(buf[i/8]>>(7-(i%8)))&1; if(((crc>>32)^b)&1) crc^=g; }
  return (crc&0xffffffff)^0xffffffff;
}
static uint16_t crc9(uint8_t* d, uint32_t n){
  uint16_t c=0, p=0x059;
  for(uint32_t i=0;i<n;i++){ if(((c>>8)&1)^(d[i]&1)) c=(c<<1)^p; else c<<=1; }
  return (c&0x1ff)^0x1ff;
}
int main(){
  CP25Trellis tr;
  unsigned char pay[18]; for(int i=0;i<18;i++) pay[i]=(unsigned char)(0x11*i+7);
  unsigned char raw[25]; memset(raw,0,25); tr.encode34(pay,raw); hex("tr34_pay",pay,18); hex("tr34",raw,25);
  // CRC-32 over bytes 00..3B (bit-serial, MSB first), CRC-9 over 135 bits
  uint8_t m[64]; for(int i=0;i<64;i++) m[i]=(uint8_t)(i*13+5);
  printf("crc32:%08X\n",crc32mbf(m,60*8));
  uint8_t bits[135]; for(int i=0;i<135;i++) bits[i]=((m[i/8]>>(7-(i%8)))&1);
  printf("crc9:%03X\n",crc9(bits,135));
  return 0; }
