#include "t2p1.h"
#include <cstdio>
using namespace dvbofdm;
int main(int argc, char **argv) {
  FILE *f = fopen(argv[1], "rb"); size_t total = argc > 2 ? atol(argv[2]) : 8000000;
  std::vector<cf> x(total); size_t got = fread(x.data(), 8, total, f); fclose(f); x.resize(got);
  P1 p1; const int C = 1 << 20;
  for (size_t s = 0; s + 4096 < got; s += C - 4096) {
    int n = (int)std::min<size_t>(C, got - s);
    float met; int64_t p = p1.scan(x.data() + s, n, 0.0f, &met);
    if (p < 0) continue;
    P1Info r = p1.identify(x.data() + s, n, (int)p, met);
    printf("chunk@%zu pos %lld metric %.3f ok %d s1 %d s2 %d cfo %.1f Hz@9.14M score %.3f\n", s, (long long)(s + p), met, r.ok, r.s1, r.s2, r.cfo * 9142857.0 / (2 * PI), r.idScore);
  }
}
