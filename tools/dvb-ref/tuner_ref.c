/* Reference for modules/dvb-kernels.js: the R820T / R828D tuner functions of the Linux kernel (drivers/media/tuners/r820t.c,
   GPL-2.0-or-later, Copyright (c) Mauro Carvalho Chehab) between stubs. It prints every I2C operation; see README.md. */

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>
struct tuner_i2c_props { int dummy; };
typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef uint64_t u64;
typedef int bool_t;
#define ARRAY_SIZE(a) (sizeof(a)/sizeof((a)[0]))
#define true 1
#define false 0
#define bool int
#define tuner_dbg(...) do{}while(0)
#define tuner_info(...) do{}while(0)
#define usleep_range(a,b) do{}while(0)
#define msleep(a) do{}while(0)
#define EINVAL 22
#define EREMOTEIO 121
enum { SYS_UNDEFINED, SYS_DVBT, SYS_DVBT2, SYS_ISDBT, SYS_DVBC_ANNEX_A, SYS_DVBC_ANNEX_C };
enum v4l2_tuner_type { V4L2_TUNER_RADIO=1, V4L2_TUNER_ANALOG_TV=2, V4L2_TUNER_DIGITAL_TV=3 };
typedef u64 v4l2_std_id;
enum r820t_chip { CHIP_R820T, CHIP_R620D, CHIP_R828D, CHIP_R828, CHIP_R828S, CHIP_R820C };
struct r820t_config { u8 i2c_addr; u32 xtal; enum r820t_chip rafael_chip; unsigned max_i2c_msg_len; bool use_diplexer; bool use_predetect; };
#define REG_SHADOW_START 5
#define NUM_REGS 27
#define NUM_IMR 5
#define VER_NUM 49
#define VCO_POWER_REF 0x02
#define DIP_FREQ 32000000
enum xtal_cap_value { XTAL_LOW_CAP_30P = 0, XTAL_LOW_CAP_20P, XTAL_LOW_CAP_10P, XTAL_LOW_CAP_0P, XTAL_HIGH_CAP_0P };
struct r820t_sect_type { u8 phase_y; u8 gain_x; u16 value; };
struct r820t_priv {
  struct tuner_i2c_props i2c_props;
  const struct r820t_config *cfg;
  u8 regs[NUM_REGS]; u8 buf[NUM_REGS+1];
  enum xtal_cap_value xtal_cap_sel; u16 pll; u32 int_freq; u8 fil_cal_code; bool imr_done; bool has_lock; bool init_done;
  struct r820t_sect_type imr_data[NUM_IMR];
  u32 delsys; enum v4l2_tuner_type type; v4l2_std_id std; u32 bw;
};
struct r820t_freq_range { u32 freq; u8 open_d; u8 rf_mux_ploy; u8 tf_c; u8 xtal_cap20p; u8 xtal_cap10p; u8 xtal_cap0p; u8 imr_mem; };
static int rdn=0;
static int tuner_i2c_xfer_send(struct tuner_i2c_props*p,u8*buf,int len){ printf("W %02x %02x\n",buf[0],buf[1]); return len; }
static int tuner_i2c_xfer_send_recv(struct tuner_i2c_props*p,u8*buf,int sl,u8*r,int rl){ for(int i=0;i<rl;i++) r[i]=(u8)(0x5a+37*i+11*rdn); rdn++; printf("R %02x %d\n",buf[0],rl); return rl; }
static inline u8 bitrev8(u8 v){ u8 r=0; for(int i=0;i<8;i++) if(v&(1<<i)) r|=0x80>>i; return r; }
#define memcpy_s memcpy
static struct tuner_i2c_props i2c_props_dummy;
static const u8 r820t_init_array[NUM_REGS] = {
	0x83, 0x32, 0x75,			/* 05 to 07 */
	0xc0, 0x40, 0xd6, 0x6c,			/* 08 to 0b */
	0xf5, 0x63, 0x75, 0x68,			/* 0c to 0f */
	0x6c, 0x83, 0x80, 0x00,			/* 10 to 13 */
	0x0f, 0x00, 0xc0, 0x30,			/* 14 to 17 */
	0x48, 0xcc, 0x60, 0x00,			/* 18 to 1b */
	0x54, 0xae, 0x4a, 0xc0			/* 1c to 1f */
};
static const struct r820t_freq_range freq_ranges[] = {
	{
		.freq = 0,
		.open_d = 0x08,		/* low */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0xdf,		/* R27[7:0]  band2,band0 */
		.xtal_cap20p = 0x02,	/* R16[1:0]  20pF (10)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 50,		/* Start freq, in MHz */
		.open_d = 0x08,		/* low */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0xbe,		/* R27[7:0]  band4,band1  */
		.xtal_cap20p = 0x02,	/* R16[1:0]  20pF (10)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 55,		/* Start freq, in MHz */
		.open_d = 0x08,		/* low */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x8b,		/* R27[7:0]  band7,band4 */
		.xtal_cap20p = 0x02,	/* R16[1:0]  20pF (10)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 60,		/* Start freq, in MHz */
		.open_d = 0x08,		/* low */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x7b,		/* R27[7:0]  band8,band4 */
		.xtal_cap20p = 0x02,	/* R16[1:0]  20pF (10)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 65,		/* Start freq, in MHz */
		.open_d = 0x08,		/* low */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x69,		/* R27[7:0]  band9,band6 */
		.xtal_cap20p = 0x02,	/* R16[1:0]  20pF (10)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 70,		/* Start freq, in MHz */
		.open_d = 0x08,		/* low */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x58,		/* R27[7:0]  band10,band7 */
		.xtal_cap20p = 0x02,	/* R16[1:0]  20pF (10)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 75,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x44,		/* R27[7:0]  band11,band11 */
		.xtal_cap20p = 0x02,	/* R16[1:0]  20pF (10)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 80,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x44,		/* R27[7:0]  band11,band11 */
		.xtal_cap20p = 0x02,	/* R16[1:0]  20pF (10)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 90,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x34,		/* R27[7:0]  band12,band11 */
		.xtal_cap20p = 0x01,	/* R16[1:0]  10pF (01)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 100,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x34,		/* R27[7:0]  band12,band11 */
		.xtal_cap20p = 0x01,	/* R16[1:0]  10pF (01)    */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 0,
	}, {
		.freq = 110,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x24,		/* R27[7:0]  band13,band11 */
		.xtal_cap20p = 0x01,	/* R16[1:0]  10pF (01)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 1,
	}, {
		.freq = 120,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x24,		/* R27[7:0]  band13,band11 */
		.xtal_cap20p = 0x01,	/* R16[1:0]  10pF (01)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 1,
	}, {
		.freq = 140,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x14,		/* R27[7:0]  band14,band11 */
		.xtal_cap20p = 0x01,	/* R16[1:0]  10pF (01)   */
		.xtal_cap10p = 0x01,
		.xtal_cap0p = 0x00,
		.imr_mem = 1,
	}, {
		.freq = 180,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x13,		/* R27[7:0]  band14,band12 */
		.xtal_cap20p = 0x00,	/* R16[1:0]  0pF (00)   */
		.xtal_cap10p = 0x00,
		.xtal_cap0p = 0x00,
		.imr_mem = 1,
	}, {
		.freq = 220,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x13,		/* R27[7:0]  band14,band12 */
		.xtal_cap20p = 0x00,	/* R16[1:0]  0pF (00)   */
		.xtal_cap10p = 0x00,
		.xtal_cap0p = 0x00,
		.imr_mem = 2,
	}, {
		.freq = 250,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x11,		/* R27[7:0]  highest,highest */
		.xtal_cap20p = 0x00,	/* R16[1:0]  0pF (00)   */
		.xtal_cap10p = 0x00,
		.xtal_cap0p = 0x00,
		.imr_mem = 2,
	}, {
		.freq = 280,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x02,	/* R26[7:6]=0 (LPF)  R26[1:0]=2 (low) */
		.tf_c = 0x00,		/* R27[7:0]  highest,highest */
		.xtal_cap20p = 0x00,	/* R16[1:0]  0pF (00)   */
		.xtal_cap10p = 0x00,
		.xtal_cap0p = 0x00,
		.imr_mem = 2,
	}, {
		.freq = 310,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x41,	/* R26[7:6]=1 (bypass)  R26[1:0]=1 (middle) */
		.tf_c = 0x00,		/* R27[7:0]  highest,highest */
		.xtal_cap20p = 0x00,	/* R16[1:0]  0pF (00)   */
		.xtal_cap10p = 0x00,
		.xtal_cap0p = 0x00,
		.imr_mem = 2,
	}, {
		.freq = 450,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x41,	/* R26[7:6]=1 (bypass)  R26[1:0]=1 (middle) */
		.tf_c = 0x00,		/* R27[7:0]  highest,highest */
		.xtal_cap20p = 0x00,	/* R16[1:0]  0pF (00)   */
		.xtal_cap10p = 0x00,
		.xtal_cap0p = 0x00,
		.imr_mem = 3,
	}, {
		.freq = 588,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x40,	/* R26[7:6]=1 (bypass)  R26[1:0]=0 (highest) */
		.tf_c = 0x00,		/* R27[7:0]  highest,highest */
		.xtal_cap20p = 0x00,	/* R16[1:0]  0pF (00)   */
		.xtal_cap10p = 0x00,
		.xtal_cap0p = 0x00,
		.imr_mem = 3,
	}, {
		.freq = 650,		/* Start freq, in MHz */
		.open_d = 0x00,		/* high */
		.rf_mux_ploy = 0x40,	/* R26[7:6]=1 (bypass)  R26[1:0]=0 (highest) */
		.tf_c = 0x00,		/* R27[7:0]  highest,highest */
		.xtal_cap20p = 0x00,	/* R16[1:0]  0pF (00)   */
		.xtal_cap10p = 0x00,
		.xtal_cap0p = 0x00,
		.imr_mem = 4,
	}
};
static void shadow_store(struct r820t_priv *priv, u8 reg, const u8 *val,
			 int len)
{
	int r = reg - REG_SHADOW_START;

	if (r < 0) {
		len += r;
		r = 0;
	}
	if (len <= 0)
		return;
	if (len > NUM_REGS - r)
		len = NUM_REGS - r;

	tuner_dbg("%s: prev  reg=%02x len=%d: %*ph\n",
		  __func__, r + REG_SHADOW_START, len, len, val);

	memcpy(&priv->regs[r], val, len);
}
static int r820t_write(struct r820t_priv *priv, u8 reg, const u8 *val,
		       int len)
{
	int rc, size, pos = 0;

	/* Store the shadow registers */
	shadow_store(priv, reg, val, len);

	do {
		if (len > priv->cfg->max_i2c_msg_len - 1)
			size = priv->cfg->max_i2c_msg_len - 1;
		else
			size = len;

		/* Fill I2C buffer */
		priv->buf[0] = reg;
		memcpy(&priv->buf[1], &val[pos], size);

		rc = tuner_i2c_xfer_send(&priv->i2c_props, priv->buf, size + 1);
		if (rc != size + 1) {
			tuner_info("%s: i2c wr failed=%d reg=%02x len=%d: %*ph\n",
				   __func__, rc, reg, size, size, &priv->buf[1]);
			if (rc < 0)
				return rc;
			return -EREMOTEIO;
		}
		tuner_dbg("%s: i2c wr reg=%02x len=%d: %*ph\n",
			  __func__, reg, size, size, &priv->buf[1]);

		reg += size;
		len -= size;
		pos += size;
	} while (len > 0);

	return 0;
}
static inline int r820t_write_reg(struct r820t_priv *priv, u8 reg, u8 val)
{
	u8 tmp = val; /* work around GCC PR81715 with asan-stack=1 */

	return r820t_write(priv, reg, &tmp, 1);
}
static int r820t_read_cache_reg(struct r820t_priv *priv, int reg)
{
	reg -= REG_SHADOW_START;

	if (reg >= 0 && reg < NUM_REGS)
		return priv->regs[reg];
	else
		return -EINVAL;
}
static inline int r820t_write_reg_mask(struct r820t_priv *priv, u8 reg, u8 val,
				u8 bit_mask)
{
	u8 tmp = val;
	int rc = r820t_read_cache_reg(priv, reg);

	if (rc < 0)
		return rc;

	tmp = (rc & ~bit_mask) | (tmp & bit_mask);

	return r820t_write(priv, reg, &tmp, 1);
}
static int r820t_read(struct r820t_priv *priv, u8 reg, u8 *val, int len)
{
	int rc, i;
	u8 *p = &priv->buf[1];

	priv->buf[0] = reg;

	rc = tuner_i2c_xfer_send_recv(&priv->i2c_props, priv->buf, 1, p, len);
	if (rc != len) {
		tuner_info("%s: i2c rd failed=%d reg=%02x len=%d: %*ph\n",
			   __func__, rc, reg, len, len, p);
		if (rc < 0)
			return rc;
		return -EREMOTEIO;
	}

	/* Copy data to the output buffer */
	for (i = 0; i < len; i++)
		val[i] = bitrev8(p[i]);

	tuner_dbg("%s: i2c rd reg=%02x len=%d: %*ph\n",
		  __func__, reg, len, len, val);

	return 0;
}
static int r820t_set_mux(struct r820t_priv *priv, u32 freq)
{
	const struct r820t_freq_range *range;
	int i, rc;
	u8 val, reg08, reg09;

	/* Get the proper frequency range */
	freq = freq / 1000000;
	for (i = 0; i < ARRAY_SIZE(freq_ranges) - 1; i++) {
		if (freq < freq_ranges[i + 1].freq)
			break;
	}
	range = &freq_ranges[i];

	tuner_dbg("set r820t range#%d for frequency %d MHz\n", i, freq);

	/* Open Drain */
	rc = r820t_write_reg_mask(priv, 0x17, range->open_d, 0x08);
	if (rc < 0)
		return rc;

	/* RF_MUX,Polymux */
	rc = r820t_write_reg_mask(priv, 0x1a, range->rf_mux_ploy, 0xc3);
	if (rc < 0)
		return rc;

	/* TF BAND */
	rc = r820t_write_reg(priv, 0x1b, range->tf_c);
	if (rc < 0)
		return rc;

	/* XTAL CAP & Drive */
	switch (priv->xtal_cap_sel) {
	case XTAL_LOW_CAP_30P:
	case XTAL_LOW_CAP_20P:
		val = range->xtal_cap20p | 0x08;
		break;
	case XTAL_LOW_CAP_10P:
		val = range->xtal_cap10p | 0x08;
		break;
	case XTAL_HIGH_CAP_0P:
		val = range->xtal_cap0p | 0x00;
		break;
	default:
	case XTAL_LOW_CAP_0P:
		val = range->xtal_cap0p | 0x08;
		break;
	}
	rc = r820t_write_reg_mask(priv, 0x10, val, 0x0b);
	if (rc < 0)
		return rc;

	if (priv->imr_done) {
		reg08 = priv->imr_data[range->imr_mem].gain_x;
		reg09 = priv->imr_data[range->imr_mem].phase_y;
	} else {
		reg08 = 0;
		reg09 = 0;
	}
	rc = r820t_write_reg_mask(priv, 0x08, reg08, 0x3f);
	if (rc < 0)
		return rc;

	rc = r820t_write_reg_mask(priv, 0x09, reg09, 0x3f);

	return rc;
}
static int r820t_set_pll(struct r820t_priv *priv, enum v4l2_tuner_type type,
			 u32 freq)
{
	u32 vco_freq;
	int rc, i;
	unsigned sleep_time = 10000;
	u32 vco_fra;		/* VCO contribution by SDM (kHz) */
	u32 vco_min  = 1770000;
	u32 vco_max  = vco_min * 2;
	u32 pll_ref;
	u16 n_sdm = 2;
	u16 sdm = 0;
	u8 mix_div = 2;
	u8 div_buf = 0;
	u8 div_num = 0;
	u8 refdiv2 = 0;
	u8 ni, si, nint, vco_fine_tune, val;
	u8 data[5];

	/* Frequency in kHz */
	freq = freq / 1000;
	pll_ref = priv->cfg->xtal / 1000;

#if 0
	/* Doesn't exist on rtl-sdk, and on field tests, caused troubles */
	if ((priv->cfg->rafael_chip == CHIP_R620D) ||
	   (priv->cfg->rafael_chip == CHIP_R828D) ||
	   (priv->cfg->rafael_chip == CHIP_R828)) {
		/* ref set refdiv2, reffreq = Xtal/2 on ATV application */
		if (type != V4L2_TUNER_DIGITAL_TV) {
			pll_ref /= 2;
			refdiv2 = 0x10;
			sleep_time = 20000;
		}
	} else {
		if (priv->cfg->xtal > 24000000) {
			pll_ref /= 2;
			refdiv2 = 0x10;
		}
	}
#endif

	rc = r820t_write_reg_mask(priv, 0x10, refdiv2, 0x10);
	if (rc < 0)
		return rc;

	/* set pll autotune = 128kHz */
	rc = r820t_write_reg_mask(priv, 0x1a, 0x00, 0x0c);
	if (rc < 0)
		return rc;

	/* set VCO current = 100 */
	rc = r820t_write_reg_mask(priv, 0x12, 0x80, 0xe0);
	if (rc < 0)
		return rc;

	/* Calculate divider */
	while (mix_div <= 64) {
		if (((freq * mix_div) >= vco_min) &&
		   ((freq * mix_div) < vco_max)) {
			div_buf = mix_div;
			while (div_buf > 2) {
				div_buf = div_buf >> 1;
				div_num++;
			}
			break;
		}
		mix_div = mix_div << 1;
	}

	rc = r820t_read(priv, 0x00, data, sizeof(data));
	if (rc < 0)
		return rc;

	vco_fine_tune = (data[4] & 0x30) >> 4;

	tuner_dbg("mix_div=%d div_num=%d vco_fine_tune=%d\n",
			mix_div, div_num, vco_fine_tune);

	/*
	 * XXX: R828D/16MHz seems to have always vco_fine_tune=1.
	 * Due to that, this calculation goes wrong.
	 */
	if (priv->cfg->rafael_chip != CHIP_R828D) {
		if (vco_fine_tune > VCO_POWER_REF)
			div_num = div_num - 1;
		else if (vco_fine_tune < VCO_POWER_REF)
			div_num = div_num + 1;
	}

	rc = r820t_write_reg_mask(priv, 0x10, div_num << 5, 0xe0);
	if (rc < 0)
		return rc;

	vco_freq = freq * mix_div;
	nint = vco_freq / (2 * pll_ref);
	vco_fra = vco_freq - 2 * pll_ref * nint;

	/* boundary spur prevention */
	if (vco_fra < pll_ref / 64) {
		vco_fra = 0;
	} else if (vco_fra > pll_ref * 127 / 64) {
		vco_fra = 0;
		nint++;
	} else if ((vco_fra > pll_ref * 127 / 128) && (vco_fra < pll_ref)) {
		vco_fra = pll_ref * 127 / 128;
	} else if ((vco_fra > pll_ref) && (vco_fra < pll_ref * 129 / 128)) {
		vco_fra = pll_ref * 129 / 128;
	}

	ni = (nint - 13) / 4;
	si = nint - 4 * ni - 13;

	rc = r820t_write_reg(priv, 0x14, ni + (si << 6));
	if (rc < 0)
		return rc;

	/* pw_sdm */
	if (!vco_fra)
		val = 0x08;
	else
		val = 0x00;

	rc = r820t_write_reg_mask(priv, 0x12, val, 0x08);
	if (rc < 0)
		return rc;

	/* sdm calculator */
	while (vco_fra > 1) {
		if (vco_fra > (2 * pll_ref / n_sdm)) {
			sdm = sdm + 32768 / (n_sdm / 2);
			vco_fra = vco_fra - 2 * pll_ref / n_sdm;
			if (n_sdm >= 0x8000)
				break;
		}
		n_sdm = n_sdm << 1;
	}

	tuner_dbg("freq %d kHz, pll ref %d%s, sdm=0x%04x\n",
		  freq, pll_ref, refdiv2 ? " / 2" : "", sdm);

	rc = r820t_write_reg(priv, 0x16, sdm >> 8);
	if (rc < 0)
		return rc;
	rc = r820t_write_reg(priv, 0x15, sdm & 0xff);
	if (rc < 0)
		return rc;

	for (i = 0; i < 2; i++) {
		usleep_range(sleep_time, sleep_time + 1000);

		/* Check if PLL has locked */
		rc = r820t_read(priv, 0x00, data, 3);
		if (rc < 0)
			return rc;
		if (data[2] & 0x40)
			break;

		if (!i) {
			/* Didn't lock. Increase VCO current */
			rc = r820t_write_reg_mask(priv, 0x12, 0x60, 0xe0);
			if (rc < 0)
				return rc;
		}
	}

	if (!(data[2] & 0x40)) {
		priv->has_lock = false;
		return 0;
	}

	priv->has_lock = true;
	tuner_dbg("tuner has lock at frequency %d kHz\n", freq);

	/* set pll autotune = 8kHz */
	rc = r820t_write_reg_mask(priv, 0x1a, 0x08, 0x08);

	return rc;
}
static int r820t_sysfreq_sel(struct r820t_priv *priv, u32 freq,
			     enum v4l2_tuner_type type,
			     v4l2_std_id std,
			     u32 delsys)
{
	int rc;
	u8 mixer_top, lna_top, cp_cur, div_buf_cur, lna_vth_l, mixer_vth_l;
	u8 air_cable1_in, cable2_in, pre_dect, lna_discharge, filter_cur;

	tuner_dbg("adjusting tuner parameters for the standard\n");

	switch (delsys) {
	case SYS_DVBT:
		if ((freq == 506000000) || (freq == 666000000) ||
		   (freq == 818000000)) {
			mixer_top = 0x14;	/* mixer top:14 , top-1, low-discharge */
			lna_top = 0xe5;		/* detect bw 3, lna top:4, predet top:2 */
			cp_cur = 0x28;		/* 101, 0.2 */
			div_buf_cur = 0x20;	/* 10, 200u */
		} else {
			mixer_top = 0x24;	/* mixer top:13 , top-1, low-discharge */
			lna_top = 0xe5;		/* detect bw 3, lna top:4, predet top:2 */
			cp_cur = 0x38;		/* 111, auto */
			div_buf_cur = 0x30;	/* 11, 150u */
		}
		lna_vth_l = 0x53;		/* lna vth 0.84	,  vtl 0.64 */
		mixer_vth_l = 0x75;		/* mixer vth 1.04, vtl 0.84 */
		air_cable1_in = 0x00;
		cable2_in = 0x00;
		pre_dect = 0x40;
		lna_discharge = 14;
		filter_cur = 0x40;		/* 10, low */
		break;
	case SYS_DVBT2:
		mixer_top = 0x24;	/* mixer top:13 , top-1, low-discharge */
		lna_top = 0xe5;		/* detect bw 3, lna top:4, predet top:2 */
		lna_vth_l = 0x53;	/* lna vth 0.84	,  vtl 0.64 */
		mixer_vth_l = 0x75;	/* mixer vth 1.04, vtl 0.84 */
		air_cable1_in = 0x00;
		cable2_in = 0x00;
		pre_dect = 0x40;
		lna_discharge = 14;
		cp_cur = 0x38;		/* 111, auto */
		div_buf_cur = 0x30;	/* 11, 150u */
		filter_cur = 0x40;	/* 10, low */
		break;
	case SYS_ISDBT:
		mixer_top = 0x24;	/* mixer top:13 , top-1, low-discharge */
		lna_top = 0xe5;		/* detect bw 3, lna top:4, predet top:2 */
		lna_vth_l = 0x75;	/* lna vth 1.04	,  vtl 0.84 */
		mixer_vth_l = 0x75;	/* mixer vth 1.04, vtl 0.84 */
		air_cable1_in = 0x00;
		cable2_in = 0x00;
		pre_dect = 0x40;
		lna_discharge = 14;
		cp_cur = 0x38;		/* 111, auto */
		div_buf_cur = 0x30;	/* 11, 150u */
		filter_cur = 0x40;	/* 10, low */
		break;
	case SYS_DVBC_ANNEX_A:
		mixer_top = 0x24;       /* mixer top:13 , top-1, low-discharge */
		lna_top = 0xe5;
		lna_vth_l = 0x62;
		mixer_vth_l = 0x75;
		air_cable1_in = 0x60;
		cable2_in = 0x00;
		pre_dect = 0x40;
		lna_discharge = 14;
		cp_cur = 0x38;          /* 111, auto */
		div_buf_cur = 0x30;     /* 11, 150u */
		filter_cur = 0x40;      /* 10, low */
		break;
	default: /* DVB-T 8M */
		mixer_top = 0x24;	/* mixer top:13 , top-1, low-discharge */
		lna_top = 0xe5;		/* detect bw 3, lna top:4, predet top:2 */
		lna_vth_l = 0x53;	/* lna vth 0.84	,  vtl 0.64 */
		mixer_vth_l = 0x75;	/* mixer vth 1.04, vtl 0.84 */
		air_cable1_in = 0x00;
		cable2_in = 0x00;
		pre_dect = 0x40;
		lna_discharge = 14;
		cp_cur = 0x38;		/* 111, auto */
		div_buf_cur = 0x30;	/* 11, 150u */
		filter_cur = 0x40;	/* 10, low */
		break;
	}

	if (priv->cfg->use_diplexer &&
	   ((priv->cfg->rafael_chip == CHIP_R820T) ||
	   (priv->cfg->rafael_chip == CHIP_R828S) ||
	   (priv->cfg->rafael_chip == CHIP_R820C))) {
		if (freq > DIP_FREQ)
			air_cable1_in = 0x00;
		else
			air_cable1_in = 0x60;
		cable2_in = 0x00;
	}


	if (priv->cfg->use_predetect) {
		rc = r820t_write_reg_mask(priv, 0x06, pre_dect, 0x40);
		if (rc < 0)
			return rc;
	}

	rc = r820t_write_reg_mask(priv, 0x1d, lna_top, 0xc7);
	if (rc < 0)
		return rc;
	rc = r820t_write_reg_mask(priv, 0x1c, mixer_top, 0xf8);
	if (rc < 0)
		return rc;
	rc = r820t_write_reg(priv, 0x0d, lna_vth_l);
	if (rc < 0)
		return rc;
	rc = r820t_write_reg(priv, 0x0e, mixer_vth_l);
	if (rc < 0)
		return rc;

	/* Air-IN only for Astrometa */
	rc = r820t_write_reg_mask(priv, 0x05, air_cable1_in, 0x60);
	if (rc < 0)
		return rc;
	rc = r820t_write_reg_mask(priv, 0x06, cable2_in, 0x08);
	if (rc < 0)
		return rc;

	rc = r820t_write_reg_mask(priv, 0x11, cp_cur, 0x38);
	if (rc < 0)
		return rc;
	rc = r820t_write_reg_mask(priv, 0x17, div_buf_cur, 0x30);
	if (rc < 0)
		return rc;
	rc = r820t_write_reg_mask(priv, 0x0a, filter_cur, 0x60);
	if (rc < 0)
		return rc;
	/*
	 * Original driver initializes regs 0x05 and 0x06 with the
	 * same value again on this point. Probably, it is just an
	 * error there
	 */

	/*
	 * Set LNA
	 */

	tuner_dbg("adjusting LNA parameters\n");
	if (type != V4L2_TUNER_ANALOG_TV) {
		/* LNA TOP: lowest */
		rc = r820t_write_reg_mask(priv, 0x1d, 0, 0x38);
		if (rc < 0)
			return rc;

		/* 0: normal mode */
		rc = r820t_write_reg_mask(priv, 0x1c, 0, 0x04);
		if (rc < 0)
			return rc;

		/* 0: PRE_DECT off */
		rc = r820t_write_reg_mask(priv, 0x06, 0, 0x40);
		if (rc < 0)
			return rc;

		/* agc clk 250hz */
		rc = r820t_write_reg_mask(priv, 0x1a, 0x30, 0x30);
		if (rc < 0)
			return rc;

		msleep(250);

		/* write LNA TOP = 3 */
		rc = r820t_write_reg_mask(priv, 0x1d, 0x18, 0x38);
		if (rc < 0)
			return rc;

		/*
		 * write discharge mode
		 * FIXME: IMHO, the mask here is wrong, but it matches
		 * what's there at the original driver
		 */
		rc = r820t_write_reg_mask(priv, 0x1c, mixer_top, 0x04);
		if (rc < 0)
			return rc;

		/* LNA discharge current */
		rc = r820t_write_reg_mask(priv, 0x1e, lna_discharge, 0x1f);
		if (rc < 0)
			return rc;

		/* agc clk 60hz */
		rc = r820t_write_reg_mask(priv, 0x1a, 0x20, 0x30);
		if (rc < 0)
			return rc;
	} else {
		/* PRE_DECT off */
		rc = r820t_write_reg_mask(priv, 0x06, 0, 0x40);
		if (rc < 0)
			return rc;

		/* write LNA TOP */
		rc = r820t_write_reg_mask(priv, 0x1d, lna_top, 0x38);
		if (rc < 0)
			return rc;

		/*
		 * write discharge mode
		 * FIXME: IMHO, the mask here is wrong, but it matches
		 * what's there at the original driver
		 */
		rc = r820t_write_reg_mask(priv, 0x1c, mixer_top, 0x04);
		if (rc < 0)
			return rc;

		/* LNA discharge current */
		rc = r820t_write_reg_mask(priv, 0x1e, lna_discharge, 0x1f);
		if (rc < 0)
			return rc;

		/* agc clk 1Khz, external det1 cap 1u */
		rc = r820t_write_reg_mask(priv, 0x1a, 0x00, 0x30);
		if (rc < 0)
			return rc;

		rc = r820t_write_reg_mask(priv, 0x10, 0x00, 0x04);
		if (rc < 0)
			return rc;
	}
	return 0;
}
static int r820t_set_tv_standard(struct r820t_priv *priv,
				 unsigned bw,
				 enum v4l2_tuner_type type,
				 v4l2_std_id std, u32 delsys)

{
	int rc, i;
	u32 if_khz, filt_cal_lo;
	u8 data[5], val;
	u8 filt_gain, img_r, filt_q, hp_cor, ext_enable, loop_through;
	u8 lt_att, flt_ext_widest, polyfil_cur;
	bool need_calibration;

	tuner_dbg("selecting the delivery system\n");

	if (delsys == SYS_ISDBT) {
		if_khz = 4063;
		filt_cal_lo = 59000;
		filt_gain = 0x10;	/* +3db, 6mhz on */
		img_r = 0x00;		/* image negative */
		filt_q = 0x10;		/* r10[4]:low q(1'b1) */
		hp_cor = 0x6a;		/* 1.7m disable, +2cap, 1.25mhz */
		ext_enable = 0x40;	/* r30[6], ext enable; r30[5]:0 ext at lna max */
		loop_through = 0x00;	/* r5[7], lt on */
		lt_att = 0x00;		/* r31[7], lt att enable */
		flt_ext_widest = 0x80;	/* r15[7]: flt_ext_wide on */
		polyfil_cur = 0x60;	/* r25[6:5]:min */
	} else if (delsys == SYS_DVBC_ANNEX_A) {
		if_khz = 5070;
		filt_cal_lo = 73500;
		filt_gain = 0x10;	/* +3db, 6mhz on */
		img_r = 0x00;		/* image negative */
		filt_q = 0x10;		/* r10[4]:low q(1'b1) */
		hp_cor = 0x0b;		/* 1.7m disable, +0cap, 1.0mhz */
		ext_enable = 0x40;	/* r30[6]=1 ext enable; r30[5]:1 ext at lna max-1 */
		loop_through = 0x00;	/* r5[7], lt on */
		lt_att = 0x00;		/* r31[7], lt att enable */
		flt_ext_widest = 0x00;	/* r15[7]: flt_ext_wide off */
		polyfil_cur = 0x60;	/* r25[6:5]:min */
	} else if (delsys == SYS_DVBC_ANNEX_C) {
		if_khz = 4063;
		filt_cal_lo = 55000;
		filt_gain = 0x10;	/* +3db, 6mhz on */
		img_r = 0x00;		/* image negative */
		filt_q = 0x10;		/* r10[4]:low q(1'b1) */
		hp_cor = 0x6a;		/* 1.7m disable, +0cap, 1.0mhz */
		ext_enable = 0x40;	/* r30[6]=1 ext enable; r30[5]:1 ext at lna max-1 */
		loop_through = 0x00;	/* r5[7], lt on */
		lt_att = 0x00;		/* r31[7], lt att enable */
		flt_ext_widest = 0x80;	/* r15[7]: flt_ext_wide on */
		polyfil_cur = 0x60;	/* r25[6:5]:min */
	} else {
		if (bw <= 6) {
			if_khz = 3570;
			filt_cal_lo = 56000;	/* 52000->56000 */
			filt_gain = 0x10;	/* +3db, 6mhz on */
			img_r = 0x00;		/* image negative */
			filt_q = 0x10;		/* r10[4]:low q(1'b1) */
			hp_cor = 0x6b;		/* 1.7m disable, +2cap, 1.0mhz */
			ext_enable = 0x60;	/* r30[6]=1 ext enable; r30[5]:1 ext at lna max-1 */
			loop_through = 0x00;	/* r5[7], lt on */
			lt_att = 0x00;		/* r31[7], lt att enable */
			flt_ext_widest = 0x00;	/* r15[7]: flt_ext_wide off */
			polyfil_cur = 0x60;	/* r25[6:5]:min */
		} else if (bw == 7) {
#if 0
			/*
			 * There are two 7 MHz tables defined on the original
			 * driver, but just the second one seems to be visible
			 * by rtl2832. Keep this one here commented, as it
			 * might be needed in the future
			 */

			if_khz = 4070;
			filt_cal_lo = 60000;
			filt_gain = 0x10;	/* +3db, 6mhz on */
			img_r = 0x00;		/* image negative */
			filt_q = 0x10;		/* r10[4]:low q(1'b1) */
			hp_cor = 0x2b;		/* 1.7m disable, +1cap, 1.0mhz */
			ext_enable = 0x60;	/* r30[6]=1 ext enable; r30[5]:1 ext at lna max-1 */
			loop_through = 0x00;	/* r5[7], lt on */
			lt_att = 0x00;		/* r31[7], lt att enable */
			flt_ext_widest = 0x00;	/* r15[7]: flt_ext_wide off */
			polyfil_cur = 0x60;	/* r25[6:5]:min */
#endif
			/* 7 MHz, second table */
			if_khz = 4570;
			filt_cal_lo = 63000;
			filt_gain = 0x10;	/* +3db, 6mhz on */
			img_r = 0x00;		/* image negative */
			filt_q = 0x10;		/* r10[4]:low q(1'b1) */
			hp_cor = 0x2a;		/* 1.7m disable, +1cap, 1.25mhz */
			ext_enable = 0x60;	/* r30[6]=1 ext enable; r30[5]:1 ext at lna max-1 */
			loop_through = 0x00;	/* r5[7], lt on */
			lt_att = 0x00;		/* r31[7], lt att enable */
			flt_ext_widest = 0x00;	/* r15[7]: flt_ext_wide off */
			polyfil_cur = 0x60;	/* r25[6:5]:min */
		} else {
			if_khz = 4570;
			filt_cal_lo = 68500;
			filt_gain = 0x10;	/* +3db, 6mhz on */
			img_r = 0x00;		/* image negative */
			filt_q = 0x10;		/* r10[4]:low q(1'b1) */
			hp_cor = 0x0b;		/* 1.7m disable, +0cap, 1.0mhz */
			ext_enable = 0x60;	/* r30[6]=1 ext enable; r30[5]:1 ext at lna max-1 */
			loop_through = 0x00;	/* r5[7], lt on */
			lt_att = 0x00;		/* r31[7], lt att enable */
			flt_ext_widest = 0x00;	/* r15[7]: flt_ext_wide off */
			polyfil_cur = 0x60;	/* r25[6:5]:min */
		}
	}

	/* Initialize the shadow registers */
	memcpy(priv->regs, r820t_init_array, sizeof(r820t_init_array));

	/* Init Flag & Xtal_check Result */
	if (priv->imr_done)
		val = 1 | priv->xtal_cap_sel << 1;
	else
		val = 0;
	rc = r820t_write_reg_mask(priv, 0x0c, val, 0x0f);
	if (rc < 0)
		return rc;

	/* version */
	rc = r820t_write_reg_mask(priv, 0x13, VER_NUM, 0x3f);
	if (rc < 0)
		return rc;

	/* for LT Gain test */
	if (type != V4L2_TUNER_ANALOG_TV) {
		rc = r820t_write_reg_mask(priv, 0x1d, 0x00, 0x38);
		if (rc < 0)
			return rc;
		usleep_range(1000, 2000);
	}
	priv->int_freq = if_khz * 1000;

	/* Check if standard changed. If so, filter calibration is needed */
	if (type != priv->type)
		need_calibration = true;
	else if ((type == V4L2_TUNER_ANALOG_TV) && (std != priv->std))
		need_calibration = true;
	else if ((type == V4L2_TUNER_DIGITAL_TV) &&
		 ((delsys != priv->delsys) || bw != priv->bw))
		need_calibration = true;
	else
		need_calibration = false;

	if (need_calibration) {
		tuner_dbg("calibrating the tuner\n");
		for (i = 0; i < 2; i++) {
			/* Set filt_cap */
			rc = r820t_write_reg_mask(priv, 0x0b, hp_cor, 0x60);
			if (rc < 0)
				return rc;

			/* set cali clk =on */
			rc = r820t_write_reg_mask(priv, 0x0f, 0x04, 0x04);
			if (rc < 0)
				return rc;

			/* X'tal cap 0pF for PLL */
			rc = r820t_write_reg_mask(priv, 0x10, 0x00, 0x03);
			if (rc < 0)
				return rc;

			rc = r820t_set_pll(priv, type, filt_cal_lo * 1000);
			if (rc < 0 || !priv->has_lock)
				return rc;

			/* Start Trigger */
			rc = r820t_write_reg_mask(priv, 0x0b, 0x10, 0x10);
			if (rc < 0)
				return rc;

			usleep_range(1000, 2000);

			/* Stop Trigger */
			rc = r820t_write_reg_mask(priv, 0x0b, 0x00, 0x10);
			if (rc < 0)
				return rc;

			/* set cali clk =off */
			rc = r820t_write_reg_mask(priv, 0x0f, 0x00, 0x04);
			if (rc < 0)
				return rc;

			/* Check if calibration worked */
			rc = r820t_read(priv, 0x00, data, sizeof(data));
			if (rc < 0)
				return rc;

			priv->fil_cal_code = data[4] & 0x0f;
			if (priv->fil_cal_code && priv->fil_cal_code != 0x0f)
				break;
		}
		/* narrowest */
		if (priv->fil_cal_code == 0x0f)
			priv->fil_cal_code = 0;
	}

	rc = r820t_write_reg_mask(priv, 0x0a,
				  filt_q | priv->fil_cal_code, 0x1f);
	if (rc < 0)
		return rc;

	/* Set BW, Filter_gain, & HP corner */
	rc = r820t_write_reg_mask(priv, 0x0b, hp_cor, 0xef);
	if (rc < 0)
		return rc;


	/* Set Img_R */
	rc = r820t_write_reg_mask(priv, 0x07, img_r, 0x80);
	if (rc < 0)
		return rc;

	/* Set filt_3dB, V6MHz */
	rc = r820t_write_reg_mask(priv, 0x06, filt_gain, 0x30);
	if (rc < 0)
		return rc;

	/* channel filter extension */
	rc = r820t_write_reg_mask(priv, 0x1e, ext_enable, 0x60);
	if (rc < 0)
		return rc;

	/* Loop through */
	rc = r820t_write_reg_mask(priv, 0x05, loop_through, 0x80);
	if (rc < 0)
		return rc;

	/* Loop through attenuation */
	rc = r820t_write_reg_mask(priv, 0x1f, lt_att, 0x80);
	if (rc < 0)
		return rc;

	/* filter extension widest */
	rc = r820t_write_reg_mask(priv, 0x0f, flt_ext_widest, 0x80);
	if (rc < 0)
		return rc;

	/* RF poly filter current */
	rc = r820t_write_reg_mask(priv, 0x19, polyfil_cur, 0x60);
	if (rc < 0)
		return rc;

	/* Store current standard. If it changes, re-calibrate the tuner */
	priv->delsys = delsys;
	priv->type = type;
	priv->std = std;
	priv->bw = bw;

	return 0;
}

int main(int argc,char**argv){
  static struct r820t_config cfg={0x3a,16000000,CHIP_R828D,2,0,0};
  struct r820t_priv p; memset(&p,0,sizeof p); p.cfg=&cfg;
  p.xtal_cap_sel=XTAL_LOW_CAP_20P;
  u32 delsys=atoi(argv[1]), freq=strtoul(argv[2],0,10), bw=atoi(argv[3]);
  // r820t_init: массив, затем generic_set_freq
  r820t_write(&p,0x05,r820t_init_array,sizeof(r820t_init_array));
  int rc=r820t_set_tv_standard(&p,bw,V4L2_TUNER_DIGITAL_TV,0,delsys);
  printf("# std rc=%d\n",rc);
  u32 lo=freq+p.int_freq;
  rc=r820t_set_mux(&p,lo); printf("# mux rc=%d\n",rc);
  rc=r820t_set_pll(&p,V4L2_TUNER_DIGITAL_TV,lo); printf("# pll rc=%d lock=%d\n",rc,p.has_lock);
  rc=r820t_sysfreq_sel(&p,freq,V4L2_TUNER_DIGITAL_TV,0,delsys); printf("# sys rc=%d\n",rc);
  return 0;
}
