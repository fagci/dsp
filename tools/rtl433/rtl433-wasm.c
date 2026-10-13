/* Обёртка rtl_433 для wasm: каналы (детектор импульсов + слайсеры + декодеры устройств), вывод — строки JSON.
   Логика r_flow.c / r_api.c (run_ook_demods, run_fsk_demods), без SDR, файлов и вывода в консоль. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <limits.h>
#include "r_device.h"
#include "bitbuffer.h"
#include "pulse_data.h"
#include "pulse_detect.h"
#include "pulse_slicer.h"
#include "baseband.h"
#include "data.h"
#include "logger.h"
#include "rtl_433_devices.h"

#define EXPORT(n) __attribute__((export_name(n)))
void rt_persist(int on);
void rt_scratch_reset(void);

#define MAX_DEVICES 512
#define MAX_CHANNELS 64
#define MAX_BLOCK 8192
#define OUT_SIZE (1u << 18)
#define UNK_SIZE (1u << 17)

static r_device devs[MAX_DEVICES];
static uint8_t dev_on[MAX_DEVICES];
static unsigned ndev;

typedef struct {
    int used;
    uint32_t sr;
    double freq;                       /* центр канала, Гц */
    unsigned fpdm;                     /* FSK_PULSE_DETECT_OLD / NEW */
    int mag;                           /* огибающая — оценка модуля (cs16) */
    pulse_detect_t *pd;
    filter_state_t lp;
    demodfm_state_t fm;
    pulse_data_t ook, fsk;
    uint64_t pos;
    float base_db, snr_db;             /* заданные границы уровня */
    int hinted;                        /* нижняя граница поднята по прошлому пакету */
    uint64_t hint_pos;
} chan_t;
static chan_t chans[MAX_CHANNELS];
static chan_t *cur;

static uint16_t am_buf[MAX_BLOCK];
static uint16_t am_tmp[MAX_BLOCK];
static int16_t am_lp[MAX_BLOCK];
static int16_t fm_buf[MAX_BLOCK];
static int16_t in16[2 * MAX_BLOCK];
static uint8_t in8[2 * MAX_BLOCK];

static char out_buf[OUT_SIZE];
static unsigned out_len;
static char unk_buf[UNK_SIZE];
static unsigned unk_len;
static int want_unknown;
static int total_events;
static unsigned min_pulses;

/* ---------- заглушки логирования и pulse_data (pulse_data.c тянет файлы и rfraw) ---------- */
void print_log(log_level_t level, char const *src, char const *msg) { (void)level; (void)src; (void)msg; }
void print_logf(log_level_t level, char const *src, char const *fmt, ...) { (void)level; (void)src; (void)fmt; }
void pulse_data_clear(pulse_data_t *data) { memset(data, 0, sizeof(*data)); }
void pulse_data_shift(pulse_data_t *data) {
    int offs = PD_MAX_PULSES / 2;
    memmove(data->pulse, &data->pulse[offs], (PD_MAX_PULSES - offs) * sizeof(*data->pulse));
    memmove(data->gap, &data->gap[offs], (PD_MAX_PULSES - offs) * sizeof(*data->gap));
    data->num_pulses -= offs;
    data->offset += offs;
}

static void out_append(char *dst, unsigned *len, unsigned cap, const char *s, unsigned n) {
    if (*len + n + 2 > cap) return;                       /* переполнение: запись теряется целиком */
    memcpy(dst + *len, s, n); *len += n; dst[(*len)++] = '\n'; dst[*len] = 0;
}

/* ---------- вывод устройства ---------- */
static void calc_levels(chan_t *c, pulse_data_t *p) {
    float high = p->ook_high_estimate > 0 ? p->ook_high_estimate : 1, low = p->ook_low_estimate > 0 ? p->ook_low_estimate : 1;
    int maxh = DB_TO_AMP(0);
    if (c->mag) maxh = DB_TO_MAG(0);
    float mx = high < maxh ? high : maxh, snr = mx / low;
    float f1 = (float)p->fsk_f1_est / INT16_MAX * c->sr / 2.0f, f2 = (float)p->fsk_f2_est / INT16_MAX * c->sr / 2.0f;
    p->freq1_hz = f1 + (float)c->freq; p->freq2_hz = f2 + (float)c->freq; p->centerfreq_hz = (float)c->freq;
    if (!c->mag) {
        p->rssi_db = 10.0f * log10f(high) - 42.1442f; p->noise_db = 10.0f * log10f(low) - 42.1442f; p->snr_db = 10.0f * log10f(snr);
    } else {
        p->rssi_db = 20.0f * log10f(high) - 84.2884f; p->noise_db = 20.0f * log10f(low) - 84.2884f; p->snr_db = 20.0f * log10f(snr);
    }
}
static pulse_data_t *cur_pulses;
static int cur_fsk;
static void output_fn(r_device *dev, data_t *data) {
    pulse_data_t *p = cur_pulses;
    data_t *extra = data_str(NULL, "mod", "", NULL, cur_fsk ? "FSK" : "ASK");
    extra = data_dbl(extra, "freq", "", NULL, p->freq1_hz / 1e6);
    if (cur_fsk) extra = data_dbl(extra, "freq2", "", NULL, p->freq2_hz / 1e6);
    extra = data_dbl(extra, "rssi", "", NULL, p->rssi_db);
    extra = data_dbl(extra, "snr", "", NULL, p->snr_db);
    extra = data_dbl(extra, "noise", "", NULL, p->noise_db);
    extra = data_int(extra, "protocol", "", NULL, (int)dev->protocol_num);
    data = data_prepend(extra, data);
    char *s = data_print_jsons_dup(data);
    if (s) out_append(out_buf, &out_len, OUT_SIZE, s, (unsigned)strlen(s));
    data_free(data);
}

/* ---------- запуск слайсеров всех устройств (r_api.c) ---------- */
static int run_demods(pulse_data_t *pd, int fsk) {
    int events = 0;
    unsigned next_priority = 0;
    for (unsigned priority = 0; !events && priority < UINT_MAX; priority = next_priority) {
        next_priority = UINT_MAX;
        for (unsigned i = 0; i < ndev; i++) {
            r_device *d = &devs[i];
            if (d->priority > priority && d->priority < next_priority) next_priority = d->priority;
            if (d->priority != priority || !dev_on[i]) continue;
            switch (d->modulation) {
            case OOK_PULSE_PCM: if (!fsk) events += pulse_slicer_pcm(pd, d); break;
            case OOK_PULSE_PPM: if (!fsk) events += pulse_slicer_ppm(pd, d); break;
            case OOK_PULSE_PWM: if (!fsk) events += pulse_slicer_pwm(pd, d); break;
            case OOK_PULSE_MANCHESTER_ZEROBIT: if (!fsk) events += pulse_slicer_manchester_zerobit(pd, d); break;
            case OOK_PULSE_PIWM_RAW: if (!fsk) events += pulse_slicer_piwm_raw(pd, d); break;
            case OOK_PULSE_PIWM_DC: if (!fsk) events += pulse_slicer_piwm_dc(pd, d); break;
            case OOK_PULSE_DMC: if (!fsk) events += pulse_slicer_dmc(pd, d); break;
            case OOK_PULSE_PWM_OSV1: if (!fsk) events += pulse_slicer_osv1(pd, d); break;
            case OOK_PULSE_NRZS: if (!fsk) events += pulse_slicer_nrzs(pd, d); break;
            case OOK_PULSE_RZI: if (!fsk) events += pulse_slicer_rzi(pd, d); break;
            case FSK_PULSE_PCM: if (fsk) events += pulse_slicer_pcm(pd, d); break;
            case FSK_PULSE_PWM: if (fsk) events += pulse_slicer_pwm(pd, d); break;
            case FSK_PULSE_MANCHESTER_ZEROBIT: if (fsk) events += pulse_slicer_manchester_zerobit(pd, d); break;
            default: break;
            }
        }
    }
    return events;
}

/* пакет импульсов, который не опознал ни один декодер: для общего анализа на странице */
static void emit_unknown(chan_t *c, pulse_data_t *p, int fsk) {
    if (!want_unknown || p->num_pulses < 8) return;
    static char line[UNK_SIZE / 2];
    int n = snprintf(line, sizeof line, "{\"unknown\":1,\"mod\":\"%s\",\"sr\":%u,\"freq\":%.0f,\"rssi\":%.1f,\"snr\":%.1f,\"noise\":%.1f,\"f1\":%.0f,\"f2\":%.0f,\"p\":[",
        fsk ? "FSK" : "OOK", c->sr, c->freq, p->rssi_db, p->snr_db, p->noise_db, (double)p->freq1_hz, (double)p->freq2_hz);
    for (unsigned i = 0; i < p->num_pulses && n < (int)sizeof line - 40; i++) n += snprintf(line + n, sizeof line - n, "%s%d,%d", i ? "," : "", p->pulse[i], p->gap[i]);
    n += snprintf(line + n, sizeof line - n, "]}");
    if (n < (int)sizeof line) out_append(unk_buf, &unk_len, UNK_SIZE, line, (unsigned)n);
}

/* Повторы пакета приходят подряд: порог следующего берём по уровню предыдущего (нижняя граница импульса = его уровень − 8 дБ),
   иначе первый импульс при низком пороге «прилипает» к шуму перед ним. Через 3 с без пакетов граница возвращается к заданной. */
static void hint_level(chan_t *c, pulse_data_t *p) {
    float hi = p->ook_high_estimate > 0 ? (float)p->ook_high_estimate : 0;
    if (hi < 1) return;
    float db = c->mag ? 20.0f * log10f(hi) - 84.2884f : 10.0f * log10f(hi) - 42.1442f;
    float lv = db - 8.0f;
    if (lv < c->base_db) lv = c->base_db;
    pulse_detect_set_levels(c->pd, c->mag, 0.0f, lv, c->snr_db, 0);
    c->hinted = 1; c->hint_pos = c->pos;
}
static void handle_package(chan_t *c, int type) {
    if ((type == PULSE_DATA_OOK ? c->ook.num_pulses : c->fsk.num_pulses) < min_pulses) return;
    if (type == PULSE_DATA_OOK) {
        calc_levels(c, &c->ook);
        hint_level(c, &c->ook);
        cur_pulses = &c->ook; cur_fsk = 0;
        int ev = run_demods(&c->ook, 0);
        total_events += ev;
        if (!ev) emit_unknown(c, &c->ook, 0);
    } else if (type == PULSE_DATA_FSK) {
        calc_levels(c, &c->fsk);
        hint_level(c, &c->fsk);
        cur_pulses = &c->fsk; cur_fsk = 1;
        int ev = run_demods(&c->fsk, 1);
        total_events += ev;
        if (!ev) emit_unknown(c, &c->fsk, 1);
    }
}

static void run_block(chan_t *c, unsigned n) {
    int type = PULSE_DATA_OOK;
    baseband_low_pass_filter(&c->lp, am_tmp, am_lp, n);
    (void)type;
    while (type) {
        type = pulse_detect_package(c->pd, (int16_t const *)am_lp, fm_buf, n, c->sr, c->pos, &c->ook, &c->fsk, c->fpdm);
        if (type) handle_package(c, type);
    }
    c->pos += n;
    if (c->hinted && c->pos - c->hint_pos > 3ull * c->sr) { pulse_detect_set_levels(c->pd, c->mag, 0.0f, c->base_db, c->snr_db, 0); c->hinted = 0; }
}

/* ---------- экспорт ---------- */
EXPORT("rt_init") int rt_init(void) {
    rt_persist(1);
    baseband_init();
    ndev = 0;
    r_device list[] = {
#define DECL(name) name,
        DEVICES
#undef DECL
    };
    unsigned total = sizeof(list) / sizeof(*list);
    for (unsigned i = 0; i < total && ndev < MAX_DEVICES; i++) {
        if (list[i].create_fn || !list[i].decode_fn) continue;
        devs[ndev] = list[i];
        devs[ndev].protocol_num = i + 1;
        devs[ndev].output_fn = output_fn;
        devs[ndev].verbose = 0;
        dev_on[ndev] = list[i].disabled == 0;
        ndev++;
    }
    rt_persist(0);
    return (int)ndev;
}
EXPORT("rt_dev_count") int rt_dev_count(void) { return (int)ndev; }
EXPORT("rt_dev_name") const char *rt_dev_name(int i) { return i >= 0 && (unsigned)i < ndev ? devs[i].name : 0; }
EXPORT("rt_dev_proto") int rt_dev_proto(int i) { return (int)devs[i].protocol_num; }
EXPORT("rt_dev_mod") int rt_dev_mod(int i) { return (int)devs[i].modulation; }
EXPORT("rt_dev_disabled") int rt_dev_disabled(int i) { return (int)devs[i].disabled; }
EXPORT("rt_dev_get") int rt_dev_get(int i) { return dev_on[i]; }
EXPORT("rt_dev_set") void rt_dev_set(int i, int on) { if (i >= 0 && (unsigned)i < ndev) dev_on[i] = on != 0; }
EXPORT("rt_dev_timing") float rt_dev_timing(int i, int k) {
    r_device *d = &devs[i];
    switch (k) { case 0: return d->short_width; case 1: return d->long_width; case 2: return d->reset_limit; case 3: return d->gap_limit; case 4: return d->sync_width; default: return d->tolerance; }
}
EXPORT("rt_unknown") void rt_unknown(int on) { want_unknown = on; }

EXPORT("rt_chan_new") int rt_chan_new(uint32_t sr, double freq, int mag) {
    for (int i = 0; i < MAX_CHANNELS; i++) {
        chan_t *c = &chans[i];
        if (c->used) continue;
        pulse_detect_t *keep = c->pd;
        memset(c, 0, sizeof(*c));
        c->pd = keep;
        c->used = 1; c->sr = sr; c->freq = freq; c->mag = mag;
        c->fpdm = freq > 800e6 ? FSK_PULSE_DETECT_NEW : FSK_PULSE_DETECT_OLD;
        if (!c->pd) { rt_persist(1); c->pd = pulse_detect_create(); rt_persist(0); }
        c->base_db = -12.1442f; c->snr_db = 9.0f; pulse_detect_set_levels(c->pd, mag, 0.0f, c->base_db, c->snr_db, 0);
        pulse_detect_reset(c->pd);
        baseband_low_pass_filter_reset(&c->lp);
        baseband_demod_FM_reset(&c->fm);
        return i;
    }
    return -1;
}
EXPORT("rt_chan_free") void rt_chan_free(int i) { if (i >= 0 && i < MAX_CHANNELS) chans[i].used = 0; }
EXPORT("rt_chan_freq") void rt_chan_freq(int i, double f) { chans[i].freq = f; chans[i].fpdm = f > 800e6 ? FSK_PULSE_DETECT_NEW : FSK_PULSE_DETECT_OLD; }
EXPORT("rt_chan_levels") void rt_chan_levels(int i, float min_level, float min_snr) { chans[i].base_db = min_level; chans[i].snr_db = min_snr; chans[i].hinted = 0; pulse_detect_set_levels(chans[i].pd, chans[i].mag, 0.0f, min_level, min_snr, 0); }
EXPORT("rt_min_pulses") void rt_min_pulses(unsigned n) { min_pulses = n; }
EXPORT("rt_chan_reset") void rt_chan_reset(int i) {
    chan_t *c = &chans[i];
    pulse_detect_reset(c->pd); baseband_low_pass_filter_reset(&c->lp); baseband_demod_FM_reset(&c->fm); c->pos = 0;
}
EXPORT("rt_in16") int16_t *rt_in16(void) { return in16; }
EXPORT("rt_in8") uint8_t *rt_in8(void) { return in8; }
EXPORT("rt_max_block") int rt_max_block(void) { return MAX_BLOCK; }

/* n отсчётов IQ (чередуются I, Q) из rt_in16() (cs16, масштаб ±32768 — полная шкала) */
EXPORT("rt_feed16") int rt_feed16(int ch, unsigned n) {
    chan_t *c = &chans[ch]; cur = c; total_events = 0;
    if (n > MAX_BLOCK) n = MAX_BLOCK;
    magnitude_est_cs16(in16, am_tmp, n);
    float lowpass = c->fpdm == FSK_PULSE_DETECT_NEW ? 0.2f : 0.1f;
    baseband_demod_FM_cs16(&c->fm, in16, fm_buf, n, c->sr, lowpass);
    run_block(c, n);
    rt_scratch_reset();
    return total_events;
}
/* то же для cu8 (rt_in8()); огибающая — амплитуда, как в rtl_433 по умолчанию; канал должен быть создан с mag=0 */
EXPORT("rt_feed8") int rt_feed8(int ch, unsigned n) {
    chan_t *c = &chans[ch]; cur = c; total_events = 0;
    if (n > MAX_BLOCK) n = MAX_BLOCK;
    envelope_detect_nolut(in8, am_tmp, n);
    float lowpass = c->fpdm == FSK_PULSE_DETECT_NEW ? 0.2f : 0.1f;
    baseband_demod_FM(&c->fm, in8, fm_buf, n, c->sr, lowpass);
    run_block(c, n);
    rt_scratch_reset();
    return total_events;
}
/* конец данных: выдать незавершённый пакет */
EXPORT("rt_flush") int rt_flush(int ch) {
    chan_t *c = &chans[ch]; cur = c; total_events = 0;
    int type = pulse_detect_package(c->pd, am_lp, fm_buf, 0, c->sr, c->pos, &c->ook, &c->fsk, c->fpdm);
    if (type) handle_package(c, type);
    rt_scratch_reset();
    return total_events;
}
EXPORT("rt_out") char *rt_out(void) { return out_buf; }
EXPORT("rt_out_len") unsigned rt_out_len(void) { return out_len; }
EXPORT("rt_out_clear") void rt_out_clear(void) { out_len = 0; out_buf[0] = 0; }
EXPORT("rt_unk") char *rt_unk(void) { return unk_buf; }
EXPORT("rt_unk_len") unsigned rt_unk_len(void) { return unk_len; }
EXPORT("rt_unk_clear") void rt_unk_clear(void) { unk_len = 0; unk_buf[0] = 0; }
