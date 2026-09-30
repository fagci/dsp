#pragma once
#define RAND_MAX 2147483647
#define NULL ((void*)0)
int rand(void);
long strtol(const char*,char**,int);
static inline int abs(int x){ return x<0 ? -x : x; }
