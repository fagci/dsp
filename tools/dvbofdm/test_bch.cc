#include "bch.h"
#include <cstdio>
#include <cstdlib>
using namespace dvbofdm;
// bitwise reference encoder: systematic, parity = m(x) x^par mod g(x)
static void encode(const Bch &b, const uint8_t *msg, uint8_t *cw) {
  std::vector<uint8_t> reg(b.par, 0);
  for (int i = 0; i < b.kbch; i++) {
    uint8_t fb = reg[b.par - 1] ^ msg[i];
    for (int j = b.par - 1; j > 0; j--) reg[j] = reg[j - 1] ^ (fb & b.gen[j]);
    reg[0] = fb & b.gen[0];
    cw[i] = msg[i];
  }
  for (int i = 0; i < b.par; i++) cw[b.kbch + i] = reg[b.par - 1 - i];
}
int main() {
  srand(5); int bad = 0;
  struct C { bool sh; int t, k; } cases[] = {{false, 12, 32208}, {false, 10, 43040}, {true, 12, 7032}, {true, 12, 3072}};
  for (auto &c : cases) {
    Bch b; b.init(c.sh, c.t, c.k);
    std::vector<uint8_t> msg(c.k), cw(b.n);
    for (int i = 0; i < c.k; i++) msg[i] = rand() & 1;
    encode(b, msg.data(), cw.data());
    bool cl = b.clean(cw.data());
    for (int e = 0; e <= c.t + 1; e++) {
      std::vector<uint8_t> r = cw;
      for (int k = 0; k < e; k++) r[rand() % b.n] ^= 1;
      int fixed = b.decode(r.data());
      bool good = (e <= c.t) ? (r == cw) : true;
      if (!good) { bad++; printf("FAIL short=%d t=%d errors=%d fixed=%d\n", c.sh, c.t, e, fixed); }
    }
    printf("short=%d t=%d k=%d clean=%d\n", c.sh, c.t, c.k, cl);
    if (!cl) bad++;
  }
  printf(bad ? "FAILED\n" : "all ok\n");
  return bad;
}
