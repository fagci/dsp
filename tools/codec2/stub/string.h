#pragma once
typedef unsigned long size_t;
void* memset(void*,int,size_t);
void* memcpy(void*,const void*,size_t);
void* memmove(void*,const void*,size_t);
static inline size_t strlen(const char* s){ size_t n=0; while(s[n]) n++; return n; }
