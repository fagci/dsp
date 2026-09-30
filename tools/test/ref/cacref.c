#include "dsd.h"
#include "nxdn_const.h"
void unpack_byte_array_into_bit_array(uint8_t*i,uint8_t*o,int len){int k=0;for(int a=0;a<len;a++)for(int b=7;b>=0;b--)o[k++]=(i[a]>>b)&1;}
void pack_bit_array_into_byte_array(uint8_t*in,uint8_t*out,int len){for(int i=0;i<len;i++){out[i]=0;for(int b=0;b<8;b++)out[i]=(out[i]<<1)|in[i*8+b];}}
uint16_t crc16cac(const uint8_t buf[], int len){uint32_t crc=0xc3ee,poly=(1<<12)+(1<<5)+1;for(int i=0;i<len;i++){crc=((crc<<1)|buf[i])&0x1ffff;if(crc&0x10000)crc=(crc&0xffff)^poly;}crc^=0xffff;return crc&0xffff;}
uint8_t cac_puncture[14]={1,1,1,0,1,1,1,1,1,1,1,0,1,1};
int main(){
  char s[400]; uint8_t bits[300],vb[300],vy[100];
  while(scanf("%399s",s)==1){
    for(int i=0;i<300;i++)bits[i]=s[i]-'0';
    memset(vb,0,sizeof vb);memset(vy,0,sizeof vy);
    nxdn_soft_decision_viterbi(bits,PERM_12_25,cac_puncture,300,14,22,8,vb,vy);
    printf("crc=%04X bits=",crc16cac(vb,171));for(int i=0;i<171;i++)putchar('0'+vb[i]);putchar('\n');
  }
}
