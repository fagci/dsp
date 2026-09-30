#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <stdbool.h>
unsigned char Hamming_12_8_m_corr[16]; //!< single bit error correction by syndrome index

//!< Generator matrix of bits
const unsigned char Hamming_12_8_m_G[12*8] = {
        1, 0, 0, 0, 0, 0, 0, 0,   1, 1, 1, 0,
        0, 1, 0, 0, 0, 0, 0, 0,   0, 1, 1, 1,
        0, 0, 1, 0, 0, 0, 0, 0,   1, 0, 1, 0,
        0, 0, 0, 1, 0, 0, 0, 0,   0, 1, 0, 1,
        0, 0, 0, 0, 1, 0, 0, 0,   1, 0, 1, 1,
        0, 0, 0, 0, 0, 1, 0, 0,   1, 1, 0, 0,
        0, 0, 0, 0, 0, 0, 1, 0,   0, 1, 1, 0,
        0, 0, 0, 0, 0, 0, 0, 1,   0, 0, 1, 1,
};

//!< Parity check matrix of bits
const unsigned char Hamming_12_8_m_H[12*4] = {
        1, 0, 1, 0, 1, 1, 0, 0,   1, 0, 0, 0,
        1, 1, 0, 1, 0, 1, 1, 0,   0, 1, 0, 0,
        1, 1, 1, 0, 1, 0, 1, 1,   0, 0, 1, 0,
        0, 1, 0, 1, 1, 0, 0, 1,   0, 0, 0, 1
//      0  1  2  3  4  5  6  7 <- correctable bit positions
};
void ScrambledPMRBit(uint32_t * LfsrValue, uint8_t * BufferIn, uint8_t * BufferOut, uint32_t NbOfBitToScramble)
{
  uint8_t  S[9] = {0};
  uint32_t i;
  uint8_t  Temp;
  uint32_t LFSRValue;

  LFSRValue = *LfsrValue;

  /* Load the initial LFSR value */
  for(i = 0; i < 9; i++)
  {
    S[i] = LFSRValue & 1;
    LFSRValue >>= 1;
  }

  /* There are 72 bit to descramble for voice and 288 bit for data */
  for(i = 0; i < NbOfBitToScramble; i++)
  {
    BufferOut[i] = (BufferIn[i] ^ S[0]) & 0x01;

    /* Shift registers */
    Temp = S[4] ^ S[0];
    S[0] = S[1];
    S[1] = S[2];
    S[2] = S[3];
    S[3] = S[4];
    S[4] = S[5];
    S[5] = S[6];
    S[6] = S[7];
    S[7] = S[8];
    S[8] = Temp;
  }

  /* Save the final LFSR value */
  LFSRValue = 0;
  for(i = 9; i > 0; i--)
  {
    LFSRValue <<= 1;
    LFSRValue |= S[i - 1] & 1;
  }

  *LfsrValue = LFSRValue;
} /* End ScrambleDPmrBit() */
void DeInterleave6x12DPmrBit(uint8_t * BufferIn, uint8_t * BufferOut)
{
  uint8_t Matrix[12][6] = {0};
  uint32_t i, j, k;

  /* Step 1 : Filling the 12 x 6 bit matrix */
  k = 0;
  for(i = 0; i < 12; i++)
  {
    for(j = 0; j < 6; j++)
    {
      Matrix[i][j] = BufferIn[k++];
    }
  }

  /* Step 2 : Filling the output buffer with deinterleaved data */
  k = 0;
  for(j = 0; j < 6; j++)
  {
    for(i = 0; i < 12; i++)
    {
      BufferOut[k++] = Matrix[i][j];
    }
  }
} /* End DeInterleave6x12DPmrBit() */
uint8_t CRC7BitdPMR(uint8_t * BufferIn, uint32_t BitLength)
{
  uint8_t  ShiftRegister = 0x00; /* All bit to '0' (7 LSBit only used) */
  uint8_t  Polynome = 0x09;      /* X^7 + X^3 + 1 */
  uint32_t i;

  for(i = 0; i < BitLength; i++)
  {
    if(((ShiftRegister >> 6) & 1) ^ BufferIn[i])
    {
      ShiftRegister = ((ShiftRegister << 1) ^ Polynome) & 0x7F;
    }
    else
    {
      ShiftRegister = (ShiftRegister << 1) & 0x7F;
    }
  }

  return ShiftRegister;
} /* End CRC7BitdPMR() */
void ConvertAirInterfaceID(uint32_t AI_ID, uint8_t ID[8])
{
  uint32_t AI_ID_Temp = AI_ID;
  uint32_t Digit;

  /* 1st digit */
  Digit = AI_ID_Temp / 1464100;
  AI_ID_Temp = AI_ID_Temp % 1464100;
  if(Digit == 10) ID[0] = '*';
  else ID[0] = Digit + '0';

  /* 2nd digit */
  Digit = AI_ID_Temp / 146410;
  AI_ID_Temp = AI_ID_Temp % 146410;
  if(Digit == 10) ID[1] = '*';
  else ID[1] = Digit + '0';

  /* 3rd digit */
  Digit = AI_ID_Temp / 14641;
  AI_ID_Temp = AI_ID_Temp % 14641;
  if(Digit == 10) ID[2] = '*';
  else ID[2] = Digit + '0';

  /* 4th digit */
  Digit = AI_ID_Temp / 1331;
  AI_ID_Temp = AI_ID_Temp % 1331;
  if(Digit == 10) ID[3] = '*';
  else ID[3] = Digit + '0';

  /* 5th digit */
  Digit = AI_ID_Temp / 121;
  AI_ID_Temp = AI_ID_Temp % 121;
  if(Digit == 10) ID[4] = '*';
  else ID[4] = Digit + '0';

  /* 6th digit */
  Digit = AI_ID_Temp / 11;
  AI_ID_Temp = AI_ID_Temp % 11;
  if(Digit == 10) ID[5] = '*';
  else ID[5] = Digit + '0';

  /* 7th digit */
  Digit = AI_ID_Temp;
  if(Digit == 10) ID[6] = '*';
  else ID[6] = Digit + '0';

  /* Add the "end of string" */
  ID[7] = '\0';

} /* End convertAirInterfaceID() */

/* End of file */
void Hamming_12_8_encode(unsigned char *origBits, unsigned char *encodedBits)
{
    int i = 0, j = 0;

    memset(encodedBits, 0, 12);

    for (i = 0; i < 8; i++)
    {
        for (j = 0; j < 12; j++)
        {
            encodedBits[j] += origBits[i] * Hamming_12_8_m_G[12*i + j];
        }
    }

    for (i = 0; i < 12; i++)
    {
        encodedBits[i] %= 2;
    }
}

bool Hamming_12_8_decode(unsigned char *rxBits, unsigned char *decodedBits, int nbCodewords)
{
    bool correctable = true;
    int ic = 0;
    int is = 0;
    int syndromeI = 0; // syndrome index

    for (ic = 0; ic < nbCodewords; ic++)
    {
        // calculate syndrome

        syndromeI = 0; // syndrome index

        for (is = 0; is < 4; is++)
        {
            syndromeI += (((rxBits[12*ic +  0] * Hamming_12_8_m_H[12*is +  0])
                         + (rxBits[12*ic +  1] * Hamming_12_8_m_H[12*is +  1])
                         + (rxBits[12*ic +  2] * Hamming_12_8_m_H[12*is +  2])
                         + (rxBits[12*ic +  3] * Hamming_12_8_m_H[12*is +  3])
                         + (rxBits[12*ic +  4] * Hamming_12_8_m_H[12*is +  4])
                         + (rxBits[12*ic +  5] * Hamming_12_8_m_H[12*is +  5])
                         + (rxBits[12*ic +  6] * Hamming_12_8_m_H[12*is +  6])
                         + (rxBits[12*ic +  7] * Hamming_12_8_m_H[12*is +  7])
                         + (rxBits[12*ic +  8] * Hamming_12_8_m_H[12*is +  8])
                         + (rxBits[12*ic +  9] * Hamming_12_8_m_H[12*is +  9])
                         + (rxBits[12*ic + 10] * Hamming_12_8_m_H[12*is + 10])
                         + (rxBits[12*ic + 11] * Hamming_12_8_m_H[12*is + 11])) % 2) << (3-is);
        }

        // correct bit

        if (syndromeI > 0) // single bit error correction
        {
            if (Hamming_12_8_m_corr[syndromeI] == 0xFF) // uncorrectable error
            {
                correctable = false;
            }
            else
            {
                rxBits[Hamming_12_8_m_corr[syndromeI]] ^= 1; // flip bit
            }
        }

        // move information bits
        memcpy(&decodedBits[8*ic], &rxBits[12*ic], 8);
    }

    return correctable;
}
void initH(){
    memset(Hamming_12_8_m_corr, 0xFF, 16);
    Hamming_12_8_m_corr[0b1110] = 0; Hamming_12_8_m_corr[0b0111] = 1; Hamming_12_8_m_corr[0b1010] = 2; Hamming_12_8_m_corr[0b0101] = 3;
    Hamming_12_8_m_corr[0b1011] = 4; Hamming_12_8_m_corr[0b1100] = 5; Hamming_12_8_m_corr[0b0110] = 6; Hamming_12_8_m_corr[0b0011] = 7;
    Hamming_12_8_m_corr[0b1000] = 8; Hamming_12_8_m_corr[0b0100] = 9; Hamming_12_8_m_corr[0b0010] = 10; Hamming_12_8_m_corr[0b0001] = 11; }
int main(){
  initH(); srand(12345);
  for(int t=0;t<6;t++){
    uint8_t in[72], desc[72], deint[72], data[48];
    for(int i=0;i<72;i++) in[i]=rand()&1;
    uint32_t lfsr=0x1FF; ScrambledPMRBit(&lfsr,in,desc,72); DeInterleave6x12DPmrBit(desc,deint);
    uint8_t cor[72]; memcpy(cor,deint,72); bool ok=true; for(int j=0;j<6;j++) ok = Hamming_12_8_decode(&cor[12*j],&data[8*j],1) && ok;   // как в dsd: по одному слову
    printf("in%d:",t); for(int i=0;i<72;i++) printf("%d",in[i]); printf("\n");
    printf("deint%d:",t); for(int i=0;i<72;i++) printf("%d",deint[i]); printf("\n");
    printf("ham%d:%d ",t,(int)ok); for(int i=0;i<48;i++) printf("%d",data[i]); printf("\n");
    printf("crc%d:%02X\n",t,CRC7BitdPMR(data,41));
  }
  uint8_t id[8]; unsigned vals[]={0u,1806845u,4321987u,16777215u,1464100u}; for(int k=0;k<5;k++){ ConvertAirInterfaceID(vals[k],id); printf("ai%u:%s\n",vals[k],id); }
  uint8_t d[8]={1,0,1,1,0,0,1,0}, e[12]; Hamming_12_8_encode(d,e); printf("henc:"); for(int i=0;i<12;i++) printf("%d",e[i]); printf("\n");
  return 0; }
