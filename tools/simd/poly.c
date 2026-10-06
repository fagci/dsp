// Полифазный фильтр кадра для IQ Channelizer (WASM SIMD, f32x4): ur/ui[k] = Σp h[p·N+k]·x[b−p·N−k].
// Вход и коэффициенты переданы развёрнутыми (hrev[i] = h[N·P−1−i], окно x[(b−N·P+1)+i]), чтобы все чтения шли подряд;
// результат пишется в обычном порядке k (блок из 4 разворачивается при записи). N кратно 4.
#include <wasm_simd128.h>
void poly(const float *hrev, const float *xr, const float *xi, float *ur, float *ui, int N, int P){
  for(int k=0; k<N; k+=4){
    v128_t sr=wasm_f32x4_splat(0), si=wasm_f32x4_splat(0);
    for(int p=0; p<P; p++){
      v128_t g=wasm_v128_load(hrev+p*N+k);
      sr=wasm_f32x4_add(sr, wasm_f32x4_mul(g, wasm_v128_load(xr+p*N+k)));
      si=wasm_f32x4_add(si, wasm_f32x4_mul(g, wasm_v128_load(xi+p*N+k)));
    }
    wasm_v128_store(ur+N-4-k, wasm_i32x4_shuffle(sr,sr,3,2,1,0));
    wasm_v128_store(ui+N-4-k, wasm_i32x4_shuffle(si,si,3,2,1,0));
  }
}
