#define private public
#include "YSFFICH.h"
#include "YSFPayload.h"
#include "YSFConvolution.h"
#include "YSFDefines.h"
#include "CRC.h"
#include "Sync.h"
#undef private
#include <cstdio>
#include <cstring>
const unsigned int IL_5_20[] = {
	0U, 40U,  80U, 120U, 160U, 2U, 42U,  82U, 122U, 162U, 4U, 44U,  84U, 124U, 164U, 6U, 46U,  86U, 126U, 166U, 8U, 48U,  88U, 128U, 168U,
	10U, 50U,  90U, 130U, 170U, 12U, 52U,  92U, 132U, 172U, 14U, 54U,  94U, 134U, 174U, 16U, 56U,  96U, 136U, 176U, 18U, 58U,  98U, 138U, 178U,
	20U, 60U, 100U, 140U, 180U, 22U, 62U, 102U, 142U, 182U, 24U, 64U, 104U, 144U, 184U, 26U, 66U, 106U, 146U, 186U, 28U, 68U, 108U, 148U, 188U,
	30U, 70U, 110U, 150U, 190U, 32U, 72U, 112U, 152U, 192U, 34U, 74U, 114U, 154U, 194U, 36U, 76U, 116U, 156U, 196U, 38U, 78U, 118U, 158U, 198U};
const unsigned int IL_26_4[] = {
	0U, 4U,  8U, 12U, 16U, 20U, 24U, 28U, 32U, 36U, 40U, 44U, 48U, 52U, 56U, 60U, 64U, 68U, 72U, 76U, 80U, 84U, 88U, 92U, 96U, 100U,
	1U, 5U,  9U, 13U, 17U, 21U, 25U, 29U, 33U, 37U, 41U, 45U, 49U, 53U, 57U, 61U, 65U, 69U, 73U, 77U, 81U, 85U, 89U, 93U, 97U, 101U,
	2U, 6U, 10U, 14U, 18U, 22U, 26U, 30U, 34U, 38U, 42U, 46U, 50U, 54U, 58U, 62U, 66U, 70U, 74U, 78U, 82U, 86U, 90U, 94U, 98U, 102U,
	3U, 7U, 11U, 15U, 19U, 23U, 27U, 31U, 35U, 39U, 43U, 47U, 51U, 55U, 59U, 63U, 67U, 71U, 75U, 79U, 83U, 87U, 91U, 95U, 99U, 103U};
const unsigned char WH[] = {0x93U, 0xD7U, 0x51U, 0x21U, 0x9CU, 0x2FU, 0x6CU, 0xD0U, 0xEFU, 0x0FU, 0xF8U, 0x3DU, 0xF1U, 0x73U, 0x20U, 0x94U, 0xEDU, 0x1EU, 0x7CU, 0xD8U};
static const unsigned char BM[] = {0x80,0x40,0x20,0x10,0x08,0x04,0x02,0x01};
#define WB(p,i,b) p[(i)>>3] = (b) ? (p[(i)>>3] | BM[(i)&7]) : (p[(i)>>3] & ~BM[(i)&7])
#define RB(p,i)   (p[(i)>>3] & BM[(i)&7])
static void hex(const char* n, const unsigned char* d, unsigned l){ printf("%s:",n); for(unsigned i=0;i<l;i++) printf("%02X",d[i]); printf("\n"); }
// VD mode 2: DCH из 10 байт
static void vd2dch(const unsigned char* dt, unsigned char* data){
  data += 30; unsigned char output[13]; for(int i=0;i<10;i++) output[i]=dt[i]^WH[i]; CCRC::addCCITT162(output,12); output[12]=0;
  CYSFConvolution conv; unsigned char convolved[25]; conv.encode(output,convolved,100U);
  unsigned char bytes[25]; memset(bytes,0,25); unsigned j=0;
  for(unsigned i=0;i<100;i++){ unsigned n=IL_5_20[i]; bool s0=RB(convolved,j)!=0; j++; bool s1=RB(convolved,j)!=0; j++; WB(bytes,n,s0); n++; WB(bytes,n,s1); }
  unsigned char* p1=data; unsigned char* p2=bytes; for(int i=0;i<5;i++){ memcpy(p1,p2,5); p1+=18; p2+=5; }
}
static void vd2vch(const unsigned char* vch13, int j, unsigned char* data){ // как «Scramble + Interleave» в processVDMode2Audio
  data += 30; unsigned offset=40+144*j; unsigned char v[13]; for(int i=0;i<13;i++) v[i]=vch13[i]^WH[i];
  for(unsigned i=0;i<104;i++){ unsigned n=IL_26_4[i]; bool s=RB(v,i); WB(data,offset+n,s); }
}
int main(){
  { // FICH-кадры
    unsigned char frame[120]; memset(frame,0,120); for(int i=0;i<5;i++) frame[i]=YSF_SYNC_BYTES[i];
    CYSFFICH f; f.m_fich[0]=(1<<6)|(0<<2)|0; f.m_fich[1]=(0<<6)|(3<<3)|6; f.m_fich[2]=(1<<3)|2; f.m_fich[3]=0x85; f.encode(frame); hex("fich_vd2",frame,30);
    CYSFFICH g; g.m_fich[0]=(0<<6)|(2<<4)|(1<<2)|1; g.m_fich[1]=(2<<6)|(5<<3)|7; g.m_fich[2]=0x40|(2<<3)|0x04|0; g.m_fich[3]=0x12; memset(frame+5,0,25); g.encode(frame); hex("fich_hdr",frame,30);
    unsigned char chk[120]; memset(chk,0,120); memcpy(chk,frame,30); CYSFFICH d; printf("fich_dec:%d %d %d %d\n",d.decode(chk),d.getFI(),d.getFN(),d.getDGId()); }
  { // заголовок: writeHeader
    unsigned char frame[120]; memset(frame,0,120); for(int i=0;i<5;i++) frame[i]=YSF_SYNC_BYTES[i];
    CYSFFICH f; f.m_fich[0]=0; f.m_fich[1]=(0<<3)|6; f.m_fich[2]=(0<<3)|1; f.m_fich[3]=0; f.encode(frame);
    unsigned char csd1[20], csd2[20]; memcpy(csd1,"CQCQCQ    N0CALL    ",20); memcpy(csd2,"DOWNLINK  UPLINK    ",20);
    CYSFPayload p; p.writeHeader(frame,csd1,csd2); hex("frame_hdr",frame,120); }
  { // VD mode 2, FN=1: источник; голос — пробные 13 байт
    unsigned char frame[120]; memset(frame,0,120); for(int i=0;i<5;i++) frame[i]=YSF_SYNC_BYTES[i];
    CYSFFICH f; f.m_fich[0]=(1<<6); f.m_fich[1]=(0<<6)|(1<<3)|6; f.m_fich[2]=2; f.m_fich[3]=7; f.encode(frame);
    vd2dch((const unsigned char*)"N0CALL    ",frame);
    for(int j=0;j<5;j++){ unsigned char v[13]; for(int i=0;i<13;i++) v[i]=(unsigned char)(j*16+i+1); vd2vch(v,j,frame); }
    hex("frame_vd2",frame,120); }
  return 0; }
