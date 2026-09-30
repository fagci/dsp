#include "P25Data.h"
#include "P25NID.h"
#include "P25Trellis.h"
#include "P25LowSpeedData.h"
#include "P25Defines.h"
#include "Golay24128.h"
#include "CRC.h"
#include <cstdio>
#include <cstring>
static void hex(const char* n, const unsigned char* d, unsigned l){ printf("%s:",n); for(unsigned i=0;i<l;i++) printf("%02X",d[i]); printf("\n"); }
int main(){
  CP25NID nid(0x293);
  unsigned char duids[]={P25_DUID_HEADER,P25_DUID_LDU1,P25_DUID_LDU2,P25_DUID_TERM,P25_DUID_TERM_LC,P25_DUID_TSDU,P25_DUID_PDU};
  for(unsigned char d:duids){ unsigned char f[216]; memset(f,0,216); nid.encode(f,d); char nm[16]; sprintf(nm,"nid_%X",d); hex(nm,f+6,9); }
  // LDU1
  CP25Data dt; dt.reset(); dt.setLCF(P25_LCF_GROUP); dt.setMFId(0); dt.setSrcId(1234567); dt.setDstId(4321); dt.setEmergency(true);
  unsigned char f[216]; memset(f,0,216); dt.encodeLDU1(f); hex("ldu1",f,216);
  CP25Data d2; d2.reset(); d2.setLCF(P25_LCF_PRIVATE); d2.setMFId(0); d2.setSrcId(0xABCDEF); d2.setDstId(0x123456);
  memset(f,0,216); d2.encodeLDU1(f); hex("ldu1p",f,216);
  // LDU2
  CP25Data d3; d3.reset(); unsigned char mi[9]={1,2,3,4,5,6,7,8,9}; d3.setMI(mi); d3.setAlgId(0x81); d3.setKId(0xBEEF);
  memset(f,0,216); d3.encodeLDU2(f); hex("ldu2",f,216);
  // HDU
  CP25Data d4; d4.reset(); d4.setMI(mi); d4.setMFId(0x90); d4.setAlgId(0x84); d4.setKId(0x1234); d4.setDstId(0x0BAD);
  unsigned char h[99]; memset(h,0,99); d4.encodeHeader(h); hex("hdu",h,99);
  // TSDU group grant
  CP25Data d5; d5.reset(); d5.setLCF(P25_LCF_GRP_VCH_GRANT); d5.setMFId(0); d5.setServiceType(0x40); d5.setDstId(0x0777); d5.setSrcId(0x00A1B2C3);
  unsigned char t[45]; memset(t,0,45); d5.encodeTSDU(t); hex("tsdu",t,45);
  // LSD
  CP25LowSpeedData ls; ls.setLSD1(0x5A); ls.setLSD2(0xC3); unsigned char l[216]; memset(l,0,216); ls.encode(l); hex("lsd",l+1546/8-0,4);
  // trellis 1/2 raw
  CP25Trellis tr; unsigned char pay[12]={0x80,0x00,0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,0,0}; CCRC::addCCITT162(pay,12); hex("tsbk_pay",pay,12);
  unsigned char raw[25]; memset(raw,0,25); tr.encode12(pay,raw); hex("tr12",raw,25);
  unsigned char g[3]; unsigned int cw=CGolay24128::encode24128(0x3F); printf("golay3F:%06X\n",cw);
  for(unsigned dv=0;dv<64;dv+=9) printf("golay%02X:%06X\n",dv,CGolay24128::encode24128(dv));
  return 0; }
