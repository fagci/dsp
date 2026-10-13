#ifndef STUB_SYS_TIME_H
#define STUB_SYS_TIME_H
#include <time.h>
struct timeval { long long tv_sec; long tv_usec; };
struct timespec { long long tv_sec; long tv_nsec; };
#define timerclear(tvp) ((tvp)->tv_sec = (tvp)->tv_usec = 0)
int gettimeofday(struct timeval *tv, void *tz);
#endif
