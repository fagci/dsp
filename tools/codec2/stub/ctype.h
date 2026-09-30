#pragma once
static inline int isdigit(int c){ return c>=48 && c<=57; }
static inline int isalpha(int c){ return (c>=65 && c<=90) || (c>=97 && c<=122); }
static inline int toupper(int c){ return c>=97 && c<=122 ? c-32 : c; }
