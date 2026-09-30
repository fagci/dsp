#include <cstdio>
#include <cstdlib>
#include <cstring>
extern "C++" { }
extern "C" void encode_golay_24_12(char* dodeca, char* out_parity);
extern "C" int check_and_fix_reedsolomon_24_12_13(char* data, char* parity);
extern "C" void encode_reedsolomon_24_12_13(char* hex_data, char* fixed_parity);
int main(){
  srand(7);
  for(int t=0;t<3;t++){
    char d[12], p[12]; for(int i=0;i<12;i++) d[i]=rand()&1;
    encode_golay_24_12(d,p); printf("g%d:",t); for(int i=0;i<12;i++) printf("%d",d[i]); printf(" "); for(int i=0;i<12;i++) printf("%d",p[i]); printf("\n");
  }
  char hex[72], par[72]; for(int i=0;i<72;i++) hex[i]=rand()&1;   // 12 гексабит по 6 бит
  encode_reedsolomon_24_12_13(hex,par);
  printf("rsd:"); for(int i=0;i<72;i++) printf("%d",hex[i]); printf("\nrsp:"); for(int i=0;i<72;i++) printf("%d",par[i]); printf("\n");
  return 0; }
