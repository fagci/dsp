#pragma once
/* mbelib prints diagnostics with printf / fprintf: not needed in the wasm build */
#define printf(...) ((void)0)
#define fprintf(...) ((void)0)
#define stderr 0
#define stdout 0
#define sprintf(...) 0
