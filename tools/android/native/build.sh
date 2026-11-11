#!/usr/bin/env bash
# Сборка нативных библиотек приложения под arm64-v8a: build.sh <каталог NDK> <куда положить lib*.so>
# Вызывается из Gradle (задача buildNative). Нужны git, cmake, make и сеть (исходники whisper.cpp и заголовки OpenCL тянутся по тегам).
# Результат: libdsp_whisper.so и libdsp_llama.so (CPU: dotprod + fp16), libdsp_whisper_cl.so и libdsp_llama_cl.so (то же + GPU через OpenCL).
set -euo pipefail
NDK="${1:?NDK}"; OUT="${2:?out}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${DSP_NATIVE_WORK:-$OUT/../native-work}"; mkdir -p "$WORK" "$OUT/arm64-v8a"
TC="$NDK/build/cmake/android.toolchain.cmake"
STRIP="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"
JOBS="$(nproc 2>/dev/null || echo 4)"
CL_TAG="${DSP_OPENCL_TAG:-v2024.10.24}"
COMMON=(-G "Unix Makefiles" -DCMAKE_TOOLCHAIN_FILE="$TC" -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 -DANDROID_STL=c++_static
        -DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON -DCMAKE_BUILD_TYPE=Release)

# --- OpenCL: заголовки и ICD-загрузчик — только чтобы слинковаться. В APK libOpenCL.so не кладём: на телефоне берётся системная (uses-native-library в манифесте).
CL="$WORK/opencl"
if [ ! -f "$CL/build/libOpenCL.so" ]; then
  rm -rf "$CL"; mkdir -p "$CL"
  git clone --depth 1 --branch "$CL_TAG" https://github.com/KhronosGroup/OpenCL-Headers "$CL/headers"
  git clone --depth 1 --branch "$CL_TAG" https://github.com/KhronosGroup/OpenCL-ICD-Loader "$CL/icd"
  cmake -S "$CL/icd" -B "$CL/build" "${COMMON[@]}" -DOPENCL_ICD_LOADER_HEADERS_DIR="$CL/headers" -DBUILD_TESTING=OFF -DOPENCL_ICD_LOADER_BUILD_TESTING=OFF
  cmake --build "$CL/build" -j "$JOBS"
fi

build() {  # имя библиотеки, OpenCL on/off, каталог проекта
  local lib="$1" cl="$2" src="${3:-$HERE}" dir="$WORK/$1"
  local extra=()
  if [ "$cl" = ON ]; then extra=(-DDSP_OPENCL=ON -DOpenCL_INCLUDE_DIR="$CL/headers" -DOpenCL_LIBRARY="$CL/build/libOpenCL.so"); fi
  cmake -S "$src" -B "$dir" "${COMMON[@]}" -DDSP_LIB="$lib" "${extra[@]}"
  cmake --build "$dir" -j "$JOBS" --target "$lib"
  cp "$dir/lib$lib.so" "$OUT/arm64-v8a/"
  "$STRIP" --strip-unneeded "$OUT/arm64-v8a/lib$lib.so"
  ls -la "$OUT/arm64-v8a/lib$lib.so"
}
build dsp_whisper OFF
build dsp_whisper_cl ON
build dsp_llama OFF "$HERE/llama"
build dsp_llama_cl ON "$HERE/llama"
