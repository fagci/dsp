#include "NXDNLICH.h"
#include "NXDNSACCH.h"
#include "NXDNFACCH1.h"
#include "NXDNUDCH.h"
#include "NXDNDefines.h"
#include "NXDNCRC.h"
#include "Sync.h"
#include <cstdio>
#include <cstring>
static const unsigned char SCRAMBLER[] = {
	0x00U, 0x00U, 0x00U, 0x82U, 0xA0U, 0x88U, 0x8AU, 0x00U, 0xA2U, 0xA8U, 0x82U, 0x8AU, 0x82U, 0x02U,
	0x20U, 0x08U, 0x8AU, 0x20U, 0xAAU, 0xA2U, 0x82U, 0x08U, 0x22U, 0x8AU, 0xAAU, 0x08U, 0x28U, 0x88U,
	0x28U, 0x28U, 0x00U, 0x0AU, 0x02U, 0x82U, 0x20U, 0x28U, 0x82U, 0x2AU, 0xAAU, 0x20U, 0x22U, 0x80U,
	0xA8U, 0x8AU, 0x08U, 0xA0U, 0xAAU, 0x02U };
static void hex(const char* n, const unsigned char* d, unsigned l){ printf("%s:",n); for(unsigned i=0;i<l;i++) printf("%02X",d[i]); printf("\n"); }
static void scr(unsigned char* d){ for(unsigned i=0;i<48;i++) d[i]^=SCRAMBLER[i]; }
int main(){
  // A: SACCH superframe segment 1/4 + FACCH1 in the first half, AMBE in the second
  { unsigned char frame[50]; memset(frame,0,50); unsigned char* f=frame+2;
    CSync::addNXDNSync(f);
    CNXDNLICH lich; lich.setRFCT(NXDN_LICH_RFCT_RTCH); lich.setFCT(NXDN_LICH_USC_SACCH_SS); lich.setOption(NXDN_LICH_STEAL_FACCH1_1); lich.setDirection(NXDN_LICH_DIRECTION_OUTBOUND); lich.encode(f);
    CNXDNSACCH sacch; sacch.setRAN(5); sacch.setStructure(NXDN_SR_1_4); unsigned char sd[3]={0x81,0x02,0x03}; sacch.setData(sd); sacch.encode(f);
    CNXDNFACCH1 fa; unsigned char l3[10]={0x01,0x00,0x04,0x12,0x34,0x00,0x64,0x00,0,0}; fa.setData(l3); fa.encode(f, 96U);
    for(int i=0;i<18;i++) f[30+i]=0x11*(i+1); // second half raw (bytes 30..47)
    hex("frameA_plain",f,48); scr(f); hex("frameA",f,48); printf("lichA:%02X\n",lich.getRaw()); }
  // B: UDCH
  { unsigned char frame[50]; memset(frame,0,50); unsigned char* f=frame+2;
    CSync::addNXDNSync(f);
    CNXDNLICH lich; lich.setRFCT(NXDN_LICH_RFCT_RDCH); lich.setFCT(NXDN_LICH_USC_UDCH); lich.setOption(NXDN_LICH_STEAL_NONE); lich.setDirection(NXDN_LICH_DIRECTION_INBOUND); lich.encode(f);
    CNXDNUDCH u; u.setRAN(7); unsigned char ud[22]; for(int i=0;i<22;i++) ud[i]=(unsigned char)(0xA0+i); u.setData(ud); u.encode(f);
    hex("frameB_plain",f,48); scr(f); hex("frameB",f,48); printf("lichB:%02X\n",lich.getRaw()); }
  // C: SACCH + two FACCH1
  { unsigned char frame[50]; memset(frame,0,50); unsigned char* f=frame+2;
    CSync::addNXDNSync(f);
    CNXDNLICH lich; lich.setRFCT(NXDN_LICH_RFCT_RTCH); lich.setFCT(NXDN_LICH_USC_SACCH_NS); lich.setOption(NXDN_LICH_STEAL_FACCH); lich.setDirection(NXDN_LICH_DIRECTION_OUTBOUND); lich.encode(f);
    CNXDNSACCH sacch; sacch.setRAN(33); sacch.setStructure(NXDN_SR_SINGLE); unsigned char sd[3]={0x10,0,0}; sacch.setData(sd); sacch.encode(f);
    CNXDNFACCH1 fa; unsigned char l3[10]={0x08,0x00,0x04,0xAB,0xCD,0x00,0x64,0x00,0,0}; fa.setData(l3); fa.encode(f,96U); fa.encode(f,240U);
    hex("frameC_plain",f,48); scr(f); hex("frameC",f,48); printf("lichC:%02X\n",lich.getRaw()); }
  return 0; }
