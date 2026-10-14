#include "shim.h"
/* ---- recorder instead of I2C ---- */
static int nops = 0;
static void rec_w(u8 slv, u8 reg, const u8 *d, u32 len) {
  printf("[\"w\",%d,%d,[", slv, reg);
  for (u32 i = 0; i < len; i++) printf("%s%d", i ? "," : "", d[i]);
  printf("]]\n");
}
static int cxd2841er_write_regs(struct cxd2841er_priv *priv, u8 addr, u8 reg, const u8 *data, u32 len) { rec_w(addr, reg, data, len); return 0; }
static int cxd2841er_write_reg(struct cxd2841er_priv *priv, u8 addr, u8 reg, u8 val) { u8 t = val; return cxd2841er_write_regs(priv, addr, reg, &t, 1); }
static int cxd2841er_read_regs(struct cxd2841er_priv *priv, u8 addr, u8 reg, u8 *val, u32 len) { memset(val, 0, len); return 0; }
static int cxd2841er_read_reg(struct cxd2841er_priv *priv, u8 addr, u8 reg, u8 *val) { *val = 0; return 0; }
static int cxd2841er_set_reg_bits(struct cxd2841er_priv *priv, u8 addr, u8 reg, u8 data, u8 mask) {
  if (mask != 0xff) printf("[\"m\",%d,%d,%d,%d]\n", addr, reg, data, mask);
  else cxd2841er_write_reg(priv, addr, reg, data);
  return 0;
}
static void usleep_range(unsigned a, unsigned b) { printf("[\"s\",%u]\n", (b + 999) / 1000); }
static void msleep(unsigned ms) { printf("[\"s\",%u]\n", ms); }
static void cxd2841er_init_stats(struct dvb_frontend *fe) {}
static int cxd2841er_read_status_tc(struct dvb_frontend *fe, enum fe_status *status) { *status = FE_HAS_LOCK; return 0; }
/* DVB-S2 and ISDB-T are not used by this stick */
static int cxd2841er_dvbs2_set_symbol_rate(struct cxd2841er_priv *priv, u32 rate) { return 0; }
static int cxd2841er_sleep_tc_to_active_i(struct cxd2841er_priv *priv, u32 bw) { return 0; }
static int cxd2841er_active_i_to_sleep_tc(struct cxd2841er_priv *priv) { return 0; }
/* forward declarations as in the kernel file */
static int cxd2841er_sleep_tc_to_active_t_band(struct cxd2841er_priv *priv, u32 bandwidth);
static int cxd2841er_sleep_tc_to_active_t2_band(struct cxd2841er_priv *priv, u32 bandwidth);
static int cxd2841er_sleep_tc_to_active_c_band(struct cxd2841er_priv *priv, u32 bandwidth);
static int cxd2841er_sleep_tc_to_shutdown(struct cxd2841er_priv *priv);
static int cxd2841er_shutdown_to_sleep_tc(struct cxd2841er_priv *priv);
static int cxd2841er_sleep_tc(struct dvb_frontend *fe);
static void cxd2841er_set_ts_clock_mode(struct cxd2841er_priv *priv, u8 system);
static int cxd2841er_active_t_to_sleep_tc(struct cxd2841er_priv *priv);

/*BODY*/

/* ---- scenarios ---- */
static struct cxd2841er_priv P;
static u32 g_if;
static int tuner_set_params(struct dvb_frontend *fe) { printf("[\"t\"]\n"); return 0; }
static int tuner_get_if(struct dvb_frontend *fe, u32 *hz) { *hz = g_if; return 0; }
static void setup(enum cxd2841er_state st, u8 sys) {
  memset(&P, 0, sizeof P);
  P.frontend.demodulator_priv = &P;
  P.frontend.ops.tuner_ops.get_if_frequency = tuner_get_if;
  P.frontend.ops.tuner_ops.set_params = tuner_set_params;
  P.xtal = SONY_XTAL_20500;
  P.flags = CXD2841ER_AUTO_IFHZ | CXD2841ER_NO_AGCNEG | CXD2841ER_TSBITS | CXD2841ER_EARLY_TUNE | CXD2841ER_TS_SERIAL;
  P.state = st; P.system = sys;
}
static u32 if_for(u32 sys, u32 bw) {
  if (sys == SYS_DVBC_ANNEX_A) return 5070000;
  u32 b = (bw + 500000) / 1000000;
  return b <= 6 ? 3570000 : 4570000;
}
static void prep(u32 sys, u32 bw) {
  struct dtv_frontend_properties *p = &P.frontend.dtv_property_cache;
  p->delivery_system = sys; p->bandwidth_hz = bw; p->stream_id = NO_STREAM_ID_FILTER; p->frequency = 474000000;
  g_if = if_for(sys, bw);
}
int main(void) {
  static const u32 systems[3] = { SYS_DVBT, SYS_DVBT2, SYS_DVBC_ANNEX_A };
  static const char *sn[3] = { "T", "T2", "C" };
  static const u32 bws[3] = { 6000000, 7000000, 8000000 };
  printf("#init\n"); setup(STATE_SHUTDOWN, 0); prep(SYS_DVBT, 8000000); cxd2841er_init_tc(&P.frontend);
  printf("#shutdown\n"); setup(STATE_SLEEP_TC, 0); cxd2841er_sleep_tc_to_shutdown(&P);
  for (int s = 0; s < 3; s++) {
    printf("#sleep.%s\n", sn[s]); setup(STATE_ACTIVE_TC, systems[s]); prep(systems[s], 8000000); cxd2841er_sleep_tc(&P.frontend);
    for (int b = 0; b < 3; b++) {
      printf("#ifhz.%s.%u\n[%u]\n", sn[s], bws[b] / 1000000, if_for(systems[s], bws[b]));
      printf("#act.%s.%u\n", sn[s], bws[b] / 1000000);
      setup(STATE_SLEEP_TC, 0); prep(systems[s], bws[b]); cxd2841er_set_frontend_tc(&P.frontend);
      printf("#retune.%s.%u\n", sn[s], bws[b] / 1000000);
      setup(STATE_ACTIVE_TC, systems[s]); prep(systems[s], bws[b]); cxd2841er_set_frontend_tc(&P.frontend);
      for (int o = 0; o < 3; o++) if (o != s) {
        printf("#switch.%s.%s.%u\n", sn[o], sn[s], bws[b] / 1000000);
        setup(STATE_ACTIVE_TC, systems[o]); prep(systems[s], bws[b]); cxd2841er_set_frontend_tc(&P.frontend);
      }
    }
  }
  return 0;
}
