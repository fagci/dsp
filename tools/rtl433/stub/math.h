#ifndef STUB_MATH_H
#define STUB_MATH_H
#define M_PI 3.14159265358979323846
#define M_PI_2 1.57079632679489661923
#define M_PI_4 0.78539816339744830962
#define M_E 2.71828182845904523536
#define M_LN2 0.69314718055994530942
#define HUGE_VAL (__builtin_huge_val())
#define INFINITY (__builtin_inff())
#define NAN (__builtin_nanf(""))
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
#define sqrt(x) __builtin_sqrt(x)
#define sqrtf(x) __builtin_sqrtf(x)
#define floor(x) __builtin_floor(x)
#define floorf(x) __builtin_floorf(x)
#define ceil(x) __builtin_ceil(x)
#define ceilf(x) __builtin_ceilf(x)
#define fabs(x) __builtin_fabs(x)
#define fabsf(x) __builtin_fabsf(x)
#define trunc(x) __builtin_trunc(x)
#define truncf(x) __builtin_truncf(x)
#define fmin(a, b) __builtin_fmin(a, b)
#define fmax(a, b) __builtin_fmax(a, b)
double round(double x);
float roundf(float x);
long lround(double x);
long long llround(double x);
long lroundf(float x);
double rint(double x);
double nearbyint(double x);
long lrint(double x);
double fmod(double a, double b);
float fmodf(float a, float b);
/* ниже — импорты env.* (страница подставляет Math.*) */
double pow(double a, double b);
float powf(float a, float b);
double exp(double x);
float expf(float x);
double log(double x);
float logf(float x);
double log10(double x);
float log10f(float x);
double log2(double x);
double sin(double x);
double cos(double x);
double tan(double x);
float sinf(float x);
float cosf(float x);
double atan(double x);
double atan2(double y, double x);
float atan2f(float y, float x);
double asin(double x);
double acos(double x);
double sinh(double x);
double cosh(double x);
double tanh(double x);
double hypot(double a, double b);
double exp10(double x);
#define _exp10f(x) ((float)exp10((double)(x)))
#endif
