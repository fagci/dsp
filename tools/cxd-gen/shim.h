/* Stubs for the functions cut out of the Linux kernel's cxd2841er.c: kernel types, the register helpers that record instead of talking to I2C. */
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef uint64_t u64; typedef int64_t s64; typedef int32_t s32;
typedef uint8_t __u8;
#define bool int
#define true 1
#define false 0
#define KBUILD_MODNAME "cxd2841er"
#define EINVAL 22
#define E2BIG 7
#define EIO 5
#define HZ 250
#define dev_dbg(...) do{}while(0)
#define dev_warn(...) do{}while(0)
#define dev_err(...) do{}while(0)
#define dev_info(...) do{}while(0)
#define div_u64(a,b) ((u64)(a)/(u64)(b))
#define MAX_WRITE_REGSIZE 16
#define I2C_SLVX 0
#define I2C_SLVT 1
enum fe_status { FE_HAS_SIGNAL=1, FE_HAS_CARRIER=2, FE_HAS_VITERBI=4, FE_HAS_SYNC=8, FE_HAS_LOCK=16 };
enum fe_delivery_system { SYS_UNDEFINED, SYS_DVBC_ANNEX_A, SYS_DVBC_ANNEX_B, SYS_DVBT, SYS_DSS, SYS_DVBS, SYS_DVBS2, SYS_DVBH, SYS_ISDBT, SYS_ISDBS, SYS_ISDBC, SYS_ATSC, SYS_ATSCMH, SYS_DTMB, SYS_CMMB, SYS_DAB, SYS_DVBT2, SYS_TURBO, SYS_DVBC_ANNEX_C, SYS_DVBC2 };
#define CXD2841ER_USE_GATECTRL 1
#define CXD2841er_AUTO_IFHZ 2
#define CXD2841ER_AUTO_IFHZ 2
#define CXD2841ER_TS_SERIAL 4
#define CXD2841ER_ASCOT 8
#define CXD2841ER_EARLY_TUNE 16
#define CXD2841ER_NO_WAIT_LOCK 32
#define CXD2841ER_NO_AGCNEG 64
#define CXD2841ER_TSBITS 128
enum cxd2841er_xtal { SONY_XTAL_20500, SONY_XTAL_24000, SONY_XTAL_41000 };
enum cxd2841er_state { STATE_SHUTDOWN = 0, STATE_SLEEP_S, STATE_ACTIVE_S, STATE_SLEEP_TC, STATE_ACTIVE_TC };
enum cxd2841er_dvbt2_profile_t { DVBT2_PROFILE_ANY = 0, DVBT2_PROFILE_BASE = 1, DVBT2_PROFILE_LITE = 2 };
#define NO_STREAM_ID_FILTER (~0U)
struct dvb_frontend;
struct dtv_frontend_properties { u32 delivery_system; u32 bandwidth_hz; u32 stream_id; u32 symbol_rate; u32 frequency; };
struct dvb_frontend {
  void *demodulator_priv;
  struct { struct { int (*get_if_frequency)(struct dvb_frontend*, u32*); int (*set_params)(struct dvb_frontend*); } tuner_ops;
           int (*i2c_gate_ctrl)(struct dvb_frontend*, int); } ops;
  struct dtv_frontend_properties dtv_property_cache;
};
struct cxd2841er_priv {
  struct dvb_frontend frontend; struct { int dev; } *i2c;
  u8 i2c_addr_slvx; u8 i2c_addr_slvt; enum cxd2841er_state state; u8 system; enum cxd2841er_xtal xtal; u32 flags; unsigned long stats_time;
};
/* priv->i2c->dev is only an argument of dev_dbg() and never evaluated */
