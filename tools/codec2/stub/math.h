#pragma once
#define M_PI 3.14159265358979323846
#define M_PI_2 1.57079632679489661923
#define M_SQRT2 1.41421356237309504880
#define M_E 2.71828182845904523536
/* transcendental functions come from the JS host; sqrt / abs / floor are wasm instructions */
double cos(double); double sin(double); double exp(double); double log(double); double log10(double); double pow(double,double); double atan2(double,double); double atan(double); double tan(double);
float cosf(float); float sinf(float); float expf(float); float logf(float); float log10f(float); float powf(float,float); float atan2f(float,float); float atanf(float); float acosf(float); float asinf(float); double acos(double); double asin(double); float tanf(float);
#define sqrt(x) __builtin_sqrt(x)
#define sqrtf(x) __builtin_sqrtf(x)
#define fabs(x) __builtin_fabs(x)
#define fabsf(x) __builtin_fabsf(x)
#define floor(x) __builtin_floor(x)
#define floorf(x) __builtin_floorf(x)
#define ceilf(x) __builtin_ceilf(x)
#define round(x) __builtin_round(x)
#define roundf(x) __builtin_roundf(x)
#define lrintf(x) ((long)__builtin_rintf(x))
#define lrint(x) ((long)__builtin_rint(x))
#define rintf(x) __builtin_rintf(x)
#define fmaxf(a,b) __builtin_fmaxf(a,b)
#define fminf(a,b) __builtin_fminf(a,b)
