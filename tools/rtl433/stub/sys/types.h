#ifndef STUB_SYS_TIME_H
#define STUB_SYS_TIME_H
#include <time.h>
struct timeval { long long tv_sec; long tv_usec; };
struct timespec { long long tv_sec; long tv_nsec; };
#endif
