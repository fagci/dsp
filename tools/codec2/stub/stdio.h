#pragma once
#define printf(...) ((void)0)
#define fprintf(...) ((void)0)
#define fopen(...) ((void*)0)
#define fclose(...) 0
#define fflush(...) 0
#define stderr 0
#define stdout 0
typedef void FILE;

#define fwrite(...) 0
#define fread(...) 0
#define fputs(...) 0
#define putchar(...) 0
