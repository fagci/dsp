#pragma once
#define M_PI 3.14159265358979323846
#define M_E 2.71828182845904523536
#define M_SQRT2 1.41421356237309504880
/* cosf / powf come from the JS host (imports), the rest are wasm instructions */
float cosf(float);
float sinf(float);
float powf(float,float);
float expf(float);
float logf(float);
double cos(double);
double sin(double);
double pow(double,double);
double exp(double);
double log(double);
#define sqrtf(x) __builtin_sqrtf(x)
#define sqrt(x) __builtin_sqrt(x)
#define fabsf(x) __builtin_fabsf(x)
#define fabs(x) __builtin_fabs(x)
#define floorf(x) __builtin_floorf(x)
#define floor(x) __builtin_floor(x)
#define roundf(x) __builtin_roundf(x)
#define lrintf(x) ((long)__builtin_rintf(x))
