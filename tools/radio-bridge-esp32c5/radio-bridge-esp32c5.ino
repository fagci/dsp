/* ESP32-C5 USB Radio Bridge
 * Arduino ESP32 >=3.3.10; NimBLE-Arduino >=2.5.1
 * USB CDC On Boot: Enabled
 * MODE WIFI|BLE|ZB|OFF; CH n; BAND 2G|5G; HOP ON|OFF [ms];
 * TYPES MGMT,CTRL,DATA|ALL (WiFi RX, default MGMT,CTRL); SNAP n (bytes kept per WiFi frame);
 * DSNAP n (bytes kept per WiFi DATA frame, default 96); STAT ms|OFF (per-channel level / airtime lines);
 * CSI ON [ms]|OFF (WiFi channel state info); BLESCAN PASSIVE|ACTIVE; TX WIFI hex; TX BLE hex; TX ZB hex [CSMA]; INFO; HELP
 * RX lines (hex without FCS):
 *   RX WIFI <ch> <rssi> <hex>              (RX WIFI! - cut by SNAP)
 *   RX BLE <addr> <rssi> <evtype> <atype> <hex>   evtype 0 ADV_IND 1 DIRECT 2 SCAN 3 NONCONN 4 SCAN_RSP; atype 0 public 1 random
 *   RX ZB <ch> <rssi> <lqi> <hex>          (802.15.4: Zigbee, Thread, Matter-over-Thread)
 *   STAT <ch> <ms> <frames> <bytes> <rssiMax> <rssiAvg> <busy permille> <dropped>   (WiFi, every window or hop; rssiMax -127 = nothing heard)
 *   CSI <ch> <rssi> <mac> <hex int8 imag,real pairs per subcarrier>
 * Capture: frames go through a variable-length ring buffer (no 540-byte copies), output is one write per line,
 * DATA frames are cut to DSNAP bytes. STAT counts every frame the driver delivers (all types), regardless of TYPES.
 * WiFi RX: up to MAX_PKT bytes. TX: 24..1500 without FCS.
 * BLE: legacy advertisement payload <=31 bytes (no extended advertising / coded PHY).
 * ZB: raw IEEE802.15.4, TX <=125 bytes without length/FCS.
 * WiFi startup fixed: start -> set_band_mode -> set_channel.
 * This file has not been hardware-tested.
 */
#include <Arduino.h>
#include "esp32-hal-alloc-ble-mem.h"
#include <NimBLEDevice.h>
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_err.h"
#include "nvs_flash.h"
#include "esp_ieee802154.h"
#include "freertos/ringbuf.h"
#define MAX_PKT 512
#define EV_MAX 640                                  // CSI can be longer than a SNAP
#define ZB_MAX 125
#define RING_BYTES 49152
#define LOOP_US 8000                                // output time budget per loop pass
#define WITH_CSI 1                                  // 0 if the SDK has no wifi_csi_config_t fields used below

enum Proto { P_WIFI, P_BLE, P_ZB };
enum RadioMode { MODE_OFF, MODE_WIFI, MODE_BLE, MODE_ZB };
struct Event {
  uint8_t type, proto, ch, evtype, atype;
  uint16_t len;
  int8_t rssi;
  uint8_t lqi;
  uint16_t origLen;
  char addr[18];
  uint8_t data[EV_MAX];
};
#define EV_HDR offsetof(Event, data)
struct Stat { uint32_t frames, bytes, air; int32_t rssiSum; int8_t rssiMax; };
static RingbufHandle_t evRing = NULL;
static RadioMode mode = MODE_OFF;
static uint8_t wifiChan = 6, zbChan = 11;
static bool wifi5g = false;
static uint8_t wifiTypes = 3;                       // bit0 mgmt, bit1 ctrl, bit2 data
static uint16_t snapLen = 320, dataSnap = 96;
static bool bleActive = false;
static bool hopOn = false;
static uint16_t hopMs = 250;
static uint32_t hopT = 0;
static uint8_t hopIdx = 0;
static const uint8_t HOP5G[] = {36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165};
static bool zbTxPending = false;
static volatile uint32_t dropped = 0, zbDropped = 0;
static Stat st = {0, 0, 0, 0, -127};
static bool statOn = false, csiOn = false;
static uint16_t statMs = 1000, csiMs = 100;
static uint32_t statT = 0, csiT = 0, statDrop0 = 0;
static uint8_t statCh = 0;
static portMUX_TYPE stMux = portMUX_INITIALIZER_UNLOCKED;
static char outBuf[EV_MAX * 2 + 80];
static portMUX_TYPE zbMux = portMUX_INITIALIZER_UNLOCKED;
static uint8_t zbTxBuf[ZB_MAX + 4];
static char lineBuf[4700];
static size_t linePos = 0;
static bool lineOverflow = false;
static bool platformReady = false;

extern "C" {
void IRAM_ATTR esp_ieee802154_receive_done(uint8_t *, esp_ieee802154_frame_info_t *);
void IRAM_ATTR esp_ieee802154_transmit_done(const uint8_t *, const uint8_t *, esp_ieee802154_frame_info_t *);
void IRAM_ATTR esp_ieee802154_transmit_failed(const uint8_t *, esp_ieee802154_tx_error_t);
int bleGapEventCb(struct ble_gap_event *, void *);
void wifiPromiscCb(void *, wifi_promiscuous_pkt_type_t);
}

static char *skipSpace(char *p) { while (*p == ' ' || *p == '\t') ++p; return p; }
static char *splitToken(char *p) {
  while (*p && *p != ' ' && *p != '\t') ++p;
  if (*p) *p++ = 0;
  return skipSpace(p);
}
static bool checkEsp(const char *step, esp_err_t err) {
  if (err == ESP_OK) return true;
  Serial.printf("ERR SDK %s %s (0x%04x)\r\n", step, esp_err_to_name(err), (unsigned)err);
  return false;
}
static int parseHex(const char *s, uint8_t *out, int maxLen) {
  int n = 0, hi = -1;
  for (; *s; ++s) {
    if (*s == ' ' || *s == '\t') continue;
    int v;
    if (*s >= '0' && *s <= '9') v = *s - '0';
    else if (*s >= 'a' && *s <= 'f') v = *s - 'a' + 10;
    else if (*s >= 'A' && *s <= 'F') v = *s - 'A' + 10;
    else return -1;
    if (hi < 0) hi = v;
    else { if (n >= maxLen) return -1; out[n++] = (hi << 4) | v; hi = -1; }
  }
  return hi >= 0 ? -1 : n;
}
static const char *modeName(RadioMode m) {
  switch (m) {
    case MODE_WIFI: return "WIFI"; case MODE_BLE: return "BLE";
    case MODE_ZB: return "ZB"; default: return "OFF";
  }
}
static bool zbBusy() {
  portENTER_CRITICAL(&zbMux);
  bool busy = zbTxPending;
  portEXIT_CRITICAL(&zbMux);
  return busy;
}
static void clearZbBusy() {
  portENTER_CRITICAL(&zbMux); zbTxPending = false; portEXIT_CRITICAL(&zbMux);
}
static bool evPush(const Event &e) {
  return xRingbufferSend(evRing, &e, EV_HDR + e.len, 0) == pdTRUE;
}
static void IRAM_ATTR queueZbStatusFromISR(bool ok, uint8_t code) {
  Event e; memset(&e, 0, EV_HDR); e.type = 1; e.proto = P_ZB; e.len = ok ? 0 : 1; e.lqi = code;
  BaseType_t woken = pdFALSE;
  if (xRingbufferSendFromISR(evRing, &e, EV_HDR + e.len, &woken) != pdTRUE) zbDropped++;
  if (woken) portYIELD_FROM_ISR();
}
static void stopRadio() {
  if (mode == MODE_WIFI) {
    esp_wifi_set_promiscuous(false); esp_wifi_stop(); esp_wifi_deinit();
  } else if (mode == MODE_BLE) {
    ble_gap_disc_cancel(); ble_gap_adv_stop(); NimBLEDevice::deinit();
  } else if (mode == MODE_ZB) {
    esp_ieee802154_disable(); clearZbBusy();
  }
  mode = MODE_OFF;
}

static uint32_t wifiFilterMask() {
  uint32_t m = 0;
  if (wifiTypes & 1) m |= WIFI_PROMIS_FILTER_MASK_MGMT;
  if (wifiTypes & 2) m |= WIFI_PROMIS_FILTER_MASK_CTRL;
  if (wifiTypes & 4) m |= WIFI_PROMIS_FILTER_MASK_DATA;
  return m;
}
static uint32_t rxFilterMask() {                    // STAT needs to see every frame; forwarding is decided in the callback
  return statOn ? (WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_CTRL | WIFI_PROMIS_FILTER_MASK_DATA) : wifiFilterMask();
}
static void statReset() {
  portENTER_CRITICAL(&stMux); st = {0, 0, 0, 0, -127}; portEXIT_CRITICAL(&stMux);
  statT = millis(); statCh = wifiChan; statDrop0 = dropped;
}
// rx_ctrl fields differ between chips: pick bb format (cur_bb_format | sig_mode) and mcs when the SDK has them
template <class T> static auto bbFmt(const T &c, int) -> decltype((void)c.cur_bb_format, uint8_t()) { return c.cur_bb_format; }
template <class T> static auto bbFmt(const T &c, long) -> decltype((void)c.sig_mode, uint8_t()) { return c.sig_mode; }
template <class T> static uint8_t bbFmt(const T &, ...) { return 0; }
template <class T> static auto mcsOf(const T &c, int) -> decltype((void)c.mcs, uint8_t()) { return c.mcs; }
template <class T> static uint8_t mcsOf(const T &, ...) { return 7; }
// airtime estimate, us: legacy rate by table, HT/VHT/HE by HT20 MCS 0..7 (overestimates fast HE frames)
static uint32_t airtimeUs(uint8_t sigMode, uint8_t rate, uint8_t mcs, uint32_t bytes) {
  static const uint16_t leg[16] = {10, 20, 55, 110, 10, 20, 55, 110, 480, 240, 120, 60, 540, 360, 180, 90};   // x100 kbit/s
  static const uint16_t ht[8] = {65, 130, 195, 260, 390, 520, 585, 650};
  uint32_t r, pre;
  if (sigMode == 0) { r = leg[rate & 15]; pre = (rate & 15) < 4 ? 192 : (rate & 15) < 8 ? 96 : 20; }
  else { r = ht[mcs & 7]; pre = 36; }
  return pre + bytes * 80 / r;
}
static void statFlush() {
  if (!statOn || mode != MODE_WIFI) return;
  uint32_t now = millis(), el = now - statT;
  Stat s;
  portENTER_CRITICAL(&stMux); s = st; st = {0, 0, 0, 0, -127}; portEXIT_CRITICAL(&stMux);
  uint32_t busy = el ? s.air / el : 0;               // us per ms = permille
  if (busy > 1000) busy = 1000;
  int avg = s.frames ? (int)(s.rssiSum / (int32_t)s.frames) : -127;
  Serial.printf("STAT %u %lu %lu %lu %d %d %lu %lu\r\n", statCh, (unsigned long)el, (unsigned long)s.frames, (unsigned long)s.bytes,
    s.rssiMax, avg, (unsigned long)busy, (unsigned long)(dropped - statDrop0));
  statT = now; statCh = wifiChan; statDrop0 = dropped;
}
#if WITH_CSI
static void wifiCsiCb(void *, wifi_csi_info_t *info) {
  if (!csiOn || !info || !info->buf || info->len <= 0) return;
  uint32_t now = millis();
  if (now - csiT < csiMs) return;
  csiT = now;
  Event e; memset(&e, 0, EV_HDR);
  e.type = 2; e.proto = P_WIFI; e.ch = info->rx_ctrl.channel; e.rssi = info->rx_ctrl.rssi;
  snprintf(e.addr, sizeof(e.addr), "%02x:%02x:%02x:%02x:%02x:%02x",
    info->mac[0], info->mac[1], info->mac[2], info->mac[3], info->mac[4], info->mac[5]);
  e.len = info->len > EV_MAX ? EV_MAX : info->len; e.origLen = info->len;
  memcpy(e.data, info->buf, e.len);
  if (!evPush(e)) dropped++;
}
static bool applyCsi() {
  if (!csiOn) return checkEsp("esp_wifi_set_csi", esp_wifi_set_csi(false));
  wifi_csi_config_t cc = {};
  cc.enable = 1; cc.acquire_csi_legacy = 1; cc.acquire_csi_ht20 = 1;
  return checkEsp("esp_wifi_set_csi_config", esp_wifi_set_csi_config(&cc)) &&
         checkEsp("esp_wifi_set_csi_rx_cb", esp_wifi_set_csi_rx_cb(wifiCsiCb, NULL)) &&
         checkEsp("esp_wifi_set_csi", esp_wifi_set_csi(true));
}
#else
static bool applyCsi() { return !csiOn; }
#endif
static bool startWifi() {
  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  cfg.static_rx_buf_num = 16; cfg.dynamic_rx_buf_num = 64; cfg.nvs_enable = 0;   // deeper driver RX queue: fewer silent drops
  if (!checkEsp("esp_wifi_init", esp_wifi_init(&cfg))) return false;
  bool started = false;
  wifi_config_t wc = {};
  wifi_promiscuous_filter_t filt = {};
  filt.filter_mask = rxFilterMask();
  memcpy(wc.ap.ssid, "bridge", 6);
  wc.ap.ssid_len = 6;
  // Start on a known 2.4 GHz channel; select requested band AFTER start.
  wc.ap.channel = 6;
  wc.ap.authmode = WIFI_AUTH_OPEN;
  wc.ap.ssid_hidden = 1;
  wc.ap.max_connection = 0;
  wc.ap.beacon_interval = 100;

  if (!checkEsp("esp_wifi_set_storage", esp_wifi_set_storage(WIFI_STORAGE_RAM))) goto fail;
  if (!checkEsp("esp_wifi_set_mode", esp_wifi_set_mode(WIFI_MODE_AP))) goto fail;
  if (!checkEsp("esp_wifi_set_config", esp_wifi_set_config(WIFI_IF_AP, &wc))) goto fail;
  if (!checkEsp("esp_wifi_start", esp_wifi_start())) goto fail;
  started = true;
  // esp_wifi_set_band_mode requires an already started WiFi driver.
  if (!checkEsp("esp_wifi_set_band_mode", esp_wifi_set_band_mode(
          wifi5g ? WIFI_BAND_MODE_5G_ONLY : WIFI_BAND_MODE_2G_ONLY))) goto fail;
  if (!checkEsp("esp_wifi_set_channel", esp_wifi_set_channel(wifiChan, WIFI_SECOND_CHAN_NONE))) goto fail;
  if (!checkEsp("esp_wifi_set_promiscuous_filter", esp_wifi_set_promiscuous_filter(&filt))) goto fail;
  if (!checkEsp("esp_wifi_set_promiscuous_rx_cb", esp_wifi_set_promiscuous_rx_cb(wifiPromiscCb))) goto fail;
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW20);
  if (!checkEsp("esp_wifi_set_promiscuous", esp_wifi_set_promiscuous(true))) goto fail;
  if (csiOn) applyCsi();
  statReset();
  return true;
fail:
  if (started) { esp_wifi_set_promiscuous(false); esp_wifi_stop(); }
  esp_wifi_deinit();
  return false;
}
static bool startBle() {
  if (!NimBLEDevice::init("bridge")) { Serial.println("ERR BLE INIT"); return false; }
  struct ble_gap_disc_params dp = {};
  dp.passive = bleActive ? 0 : 1; dp.filter_duplicates = 0;
  dp.itvl = 0x0060; dp.window = 0x0030; // 60 ms interval, 30 ms window
  int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, BLE_HS_FOREVER, &dp, bleGapEventCb, NULL);
  if (rc != 0) { Serial.printf("ERR BLE SCAN %d\r\n", rc); NimBLEDevice::deinit(); return false; }
  return true;
}
static bool startZb() {
  if (!checkEsp("esp_ieee802154_enable", esp_ieee802154_enable())) return false;
  if (!checkEsp("esp_ieee802154_set_channel", esp_ieee802154_set_channel(zbChan)) ||
      !checkEsp("esp_ieee802154_set_promiscuous", esp_ieee802154_set_promiscuous(true)) ||
      !checkEsp("esp_ieee802154_set_rx_when_idle", esp_ieee802154_set_rx_when_idle(true)) ||
      !checkEsp("esp_ieee802154_receive", esp_ieee802154_receive())) {
    esp_ieee802154_disable(); return false;
  }
  return true;
}
static bool applyMode(RadioMode m) {
  stopRadio();
  bool ok = true;
  if (m != MODE_OFF && !platformReady) { Serial.println("ERR PLATFORM INIT"); return false; }
  if (m == MODE_WIFI) ok = startWifi();
  else if (m == MODE_BLE) ok = startBle();
  else if (m == MODE_ZB) ok = startZb();
  if (ok) mode = m;
  return ok;
}
static void cmdMode(const char *m) {
  RadioMode nm;
  if (!strcasecmp(m, "OFF")) nm = MODE_OFF;
  else if (!strcasecmp(m, "WIFI")) nm = MODE_WIFI;
  else if (!strcasecmp(m, "BLE")) nm = MODE_BLE;
  else if (!strcasecmp(m, "ZB") || !strcasecmp(m, "ZIGBEE")) nm = MODE_ZB;
  else { Serial.println("ERR MODE NAME"); return; }
  if (mode == MODE_ZB && zbBusy()) { Serial.println("ERR TX BUSY"); return; }
  if (applyMode(nm)) Serial.printf("OK MODE %s\r\n", modeName(mode));
  else Serial.println("ERR MODE START");
}
static void cmdChannel(int ch) {
  if (mode == MODE_WIFI) {
    if (ch < 1 || ch > 200 || (wifi5g ? ch <= 14 : ch > 14)) {
      Serial.println("ERR CH BAND"); return;
    }
    if (!checkEsp("esp_wifi_set_channel", esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE))) return;
    statFlush(); wifiChan = ch; statReset();
  } else if (mode == MODE_ZB) {
    if (ch < 11 || ch > 26) { Serial.println("ERR CH 11..26"); return; }
    if (zbBusy()) { Serial.println("ERR TX BUSY"); return; }
    if (!checkEsp("esp_ieee802154_set_channel", esp_ieee802154_set_channel(ch))) return;
    zbChan = ch;
  } else { Serial.println("ERR NO ACTIVE RADIO"); return; }
  Serial.printf("OK CH %d\r\n", ch);
}
static void cmdBand(const char *b) {
  if (!strcasecmp(b, "2G")) wifi5g = false;
  else if (!strcasecmp(b, "5G")) wifi5g = true;
  else { Serial.println("ERR BAND"); return; }
  wifiChan = wifi5g ? 36 : 6;
  if (mode == MODE_WIFI && !applyMode(MODE_WIFI)) { Serial.println("ERR MODE START"); return; }
  Serial.printf("OK BAND %s\r\n", wifi5g ? "5G" : "2G");
}
static void cmdTypes(const char *a) {
  uint8_t t = 0;
  char buf[40]; strncpy(buf, a, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0;
  for (char *tok = strtok(buf, ", \t"); tok; tok = strtok(NULL, ", \t")) {
    if (!strcasecmp(tok, "ALL")) t |= 7;
    else if (!strcasecmp(tok, "MGMT")) t |= 1;
    else if (!strcasecmp(tok, "CTRL")) t |= 2;
    else if (!strcasecmp(tok, "DATA")) t |= 4;
    else { Serial.println("ERR TYPES"); return; }
  }
  if (!t) { Serial.println("ERR TYPES"); return; }
  wifiTypes = t;
  if (mode == MODE_WIFI) {
    wifi_promiscuous_filter_t filt = {};
    filt.filter_mask = rxFilterMask();
    if (!checkEsp("esp_wifi_set_promiscuous_filter", esp_wifi_set_promiscuous_filter(&filt))) return;
  }
  Serial.printf("OK TYPES %u\r\n", (unsigned)wifiTypes);
}
static void cmdSnap(int n) {
  if (n < 24 || n > MAX_PKT) { Serial.printf("ERR SNAP 24..%d\r\n", MAX_PKT); return; }
  snapLen = n;
  Serial.printf("OK SNAP %d\r\n", n);
}
static void cmdDsnap(int n) {
  if (n < 24 || n > MAX_PKT) { Serial.printf("ERR DSNAP 24..%d\r\n", MAX_PKT); return; }
  dataSnap = n;
  Serial.printf("OK DSNAP %d\r\n", n);
}
static void cmdStat(const char *a) {
  if (!strcasecmp(a, "OFF")) statOn = false;
  else {
    char *tail; long v = strtol(a, &tail, 10);
    if (*tail || v < 100 || v > 60000) { Serial.println("ERR STAT 100..60000 ms|OFF"); return; }
    statMs = (uint16_t)v; statOn = true;
  }
  if (mode == MODE_WIFI) {
    wifi_promiscuous_filter_t filt = {};
    filt.filter_mask = rxFilterMask();
    if (!checkEsp("esp_wifi_set_promiscuous_filter", esp_wifi_set_promiscuous_filter(&filt))) return;
    statReset();
  }
  Serial.printf("OK STAT %s %u\r\n", statOn ? "ON" : "OFF", (unsigned)statMs);
}
static void cmdCsi(char *a) {
  char *ms = splitToken(a);
  if (!strcasecmp(a, "ON")) {
    if (*ms) { long v = strtol(ms, NULL, 10); if (v < 0 || v > 5000) { Serial.println("ERR CSI 0..5000 ms"); return; } csiMs = (uint16_t)v; }
    csiOn = true;
  } else if (!strcasecmp(a, "OFF")) csiOn = false;
  else { Serial.println("ERR CSI"); return; }
  if (mode == MODE_WIFI && !applyCsi()) { Serial.println("ERR CSI SDK"); return; }
  Serial.printf("OK CSI %s %u\r\n", csiOn ? "ON" : "OFF", (unsigned)csiMs);
}
static void cmdBleScan(const char *a) {
  if (!strcasecmp(a, "ACTIVE")) bleActive = true;
  else if (!strcasecmp(a, "PASSIVE")) bleActive = false;
  else { Serial.println("ERR BLESCAN"); return; }
  if (mode == MODE_BLE && !applyMode(MODE_BLE)) { Serial.println("ERR MODE START"); return; }
  Serial.printf("OK BLESCAN %s\r\n", bleActive ? "ACTIVE" : "PASSIVE");
}
static void cmdHop(char *a) {
  char *ms = a;
  while (*ms && *ms != ' ' && *ms != '\t') ++ms;
  if (*ms) { *ms++ = 0; while (*ms == ' ' || *ms == '\t') ++ms; }
  if (!strcasecmp(a, "ON")) {
    if (*ms) { long v = strtol(ms, NULL, 10); if (v < 20 || v > 5000) { Serial.println("ERR HOP 20..5000 ms"); return; } hopMs = (uint16_t)v; }
    hopOn = true; hopT = millis();
  } else if (!strcasecmp(a, "OFF")) hopOn = false;
  else { Serial.println("ERR HOP"); return; }
  Serial.printf("OK HOP %s %u\r\n", hopOn ? "ON" : "OFF", (unsigned)hopMs);
}
// шаг перебора каналов: WiFi 2.4 — 1..13, 5 ГГц — список HOP5G, 802.15.4 — 11..26
static void hopStep() {
  if (mode == MODE_WIFI) {
    statFlush();
    uint8_t ch;
    if (wifi5g) { hopIdx = (hopIdx + 1) % sizeof(HOP5G); ch = HOP5G[hopIdx]; }
    else { hopIdx = (hopIdx + 1) % 13; ch = hopIdx + 1; }
    if (esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE) == ESP_OK) wifiChan = ch;
    statReset();
  } else if (mode == MODE_ZB && !zbBusy()) {
    hopIdx = (hopIdx + 1) % 16;
    if (esp_ieee802154_set_channel(11 + hopIdx) == ESP_OK) zbChan = 11 + hopIdx;
  }
}
static void cmdTxWifi(const char *hex) {
  if (mode != MODE_WIFI) { Serial.println("ERR NOT WIFI MODE"); return; }
  static uint8_t buf[1500];
  int n = parseHex(hex, buf, sizeof(buf));
  if (n < 24) { Serial.println("ERR HEX 24..1500"); return; }
  if (checkEsp("esp_wifi_80211_tx", esp_wifi_80211_tx(WIFI_IF_AP, buf, n, false))) Serial.println("OK TX WIFI");
  else Serial.println("ERR TX WIFI");
}
static void cmdTxBle(const char *hex) {
  if (mode != MODE_BLE) { Serial.println("ERR NOT BLE MODE"); return; }
  uint8_t buf[31]; int n = parseHex(hex, buf, sizeof(buf));
  if (n < 1) { Serial.println("ERR HEX"); return; }
  ble_gap_adv_stop();
  struct ble_gap_adv_params ap = {};
  ap.conn_mode = BLE_GAP_CONN_MODE_NON; ap.disc_mode = BLE_GAP_DISC_MODE_GEN;
  ap.itvl_min = 0x20; ap.itvl_max = 0x40;
  int rc = ble_gap_adv_set_data(buf, n);
  if (rc == 0) rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER, &ap, bleGapEventCb, NULL);
  if (rc == 0) Serial.println("OK TX BLE"); else Serial.printf("ERR TX BLE %d\r\n", rc);
}
static void cmdTxZb(char *args) {
  if (mode != MODE_ZB) { Serial.println("ERR NOT ZB MODE"); return; }
  portENTER_CRITICAL(&zbMux);
  if (zbTxPending) { portEXIT_CRITICAL(&zbMux); Serial.println("ERR TX BUSY"); return; }
  zbTxPending = true; portEXIT_CRITICAL(&zbMux);
  bool csma = false;
  char *sp = args + strlen(args);
  while (sp > args && sp[-1] != ' ' && sp[-1] != '\t') --sp;
  if (!strcasecmp(sp, "CSMA")) { csma = true; *sp = 0; }
  int n = parseHex(args, zbTxBuf + 1, ZB_MAX);
  if (n < 3) { clearZbBusy(); Serial.println("ERR HEX 3..125"); return; }
  zbTxBuf[0] = n + 2; zbTxBuf[n+1] = 0; zbTxBuf[n+2] = 0;
  esp_err_t err = esp_ieee802154_transmit(zbTxBuf, csma);
  if (checkEsp("esp_ieee802154_transmit", err)) Serial.println("OK TX ZB");
  else { clearZbBusy(); Serial.println("ERR TX ZB"); }
}
static void cmdInfo() {
  Serial.printf("MODE %s", modeName(mode));
  if (mode == MODE_WIFI) Serial.printf(" CH %d BAND %s TYPES %u SNAP %u DSNAP %u STAT %s CSI %s", wifiChan, wifi5g ? "5G" : "2G", (unsigned)wifiTypes, (unsigned)snapLen, (unsigned)dataSnap, statOn ? "ON" : "OFF", csiOn ? "ON" : "OFF");
  if (mode == MODE_ZB) Serial.printf(" CH %d", zbChan);
  if (mode == MODE_BLE) Serial.printf(" SCAN %s", bleActive ? "ACTIVE" : "PASSIVE");
  Serial.printf(" HOP %s %u", hopOn ? "ON" : "OFF", (unsigned)hopMs);
  Serial.printf(" DROPPED %lu RINGFREE %u\r\n", (unsigned long)(dropped + zbDropped), (unsigned)xRingbufferGetCurFreeSize(evRing));
}
static void printHelp() {
  Serial.println("MODE WIFI|BLE|ZB|OFF");
  Serial.println("CH <n> - WIFI channel (subject to band/country/driver), ZB 11..26");
  Serial.println("BAND 2G|5G - default channel 6/36; restarts active WIFI");
  Serial.println("HOP ON|OFF [ms] - cycle channels (WIFI 1..13 or 5G list, ZB 11..26), default 250 ms");
  Serial.println("TYPES MGMT,CTRL,DATA|ALL - WIFI frame classes to receive (default MGMT,CTRL)");
  Serial.println("SNAP <n> - WIFI bytes kept per frame, 24..512 (default 320)");
  Serial.println("DSNAP <n> - WIFI bytes kept per DATA frame, 24..512 (default 96)");
  Serial.println("STAT <ms>|OFF - WIFI per-channel lines: frames, bytes, max/avg RSSI, airtime (counts all frame types)");
  Serial.println("CSI ON [min ms between reports]|OFF - WIFI channel state info");
  Serial.println("BLESCAN PASSIVE|ACTIVE - ACTIVE also returns scan responses");
  Serial.println("TX WIFI <hex> - 24..1500 bytes, no FCS");
  Serial.println("TX BLE <hex> - advertisement payload <=31 bytes, repeats");
  Serial.println("TX ZB <hex> [CSMA] - 3..125 bytes, no length/FCS");
  Serial.println("INFO / HELP");
}
static void handleLine(char *line) {
  line = skipSpace(line);
  char *end = line + strlen(line);
  while (end > line && (end[-1] == ' ' || end[-1] == '\t')) *--end = 0;
  if (!*line) return;
  char *args = splitToken(line);
  if (!strcasecmp(line, "MODE") && *args) cmdMode(args);
  else if (!strcasecmp(line, "CH") && *args) {
    char *tail; long ch = strtol(args, &tail, 10);
    if (*tail || ch < 1 || ch > 200) Serial.println("ERR CH"); else cmdChannel((int)ch);
  } else if (!strcasecmp(line, "BAND") && *args) cmdBand(args);
  else if (!strcasecmp(line, "TX") && *args) {
    char *hex = splitToken(args);
    if (!*hex) { Serial.println("ERR TX"); return; }
    if (!strcasecmp(args, "WIFI")) cmdTxWifi(hex);
    else if (!strcasecmp(args, "BLE")) cmdTxBle(hex);
    else if (!strcasecmp(args, "ZB")) cmdTxZb(hex);
    else Serial.println("ERR TX PROTO");
  } else if (!strcasecmp(line, "HOP") && *args) cmdHop(args);
  else if (!strcasecmp(line, "TYPES") && *args) cmdTypes(args);
  else if (!strcasecmp(line, "SNAP") && *args) {
    char *tail; long n = strtol(args, &tail, 10);
    if (*tail) Serial.println("ERR SNAP"); else cmdSnap((int)n);
  } else if (!strcasecmp(line, "DSNAP") && *args) {
    char *tail; long n = strtol(args, &tail, 10);
    if (*tail) Serial.println("ERR DSNAP"); else cmdDsnap((int)n);
  } else if (!strcasecmp(line, "STAT") && *args) cmdStat(args);
  else if (!strcasecmp(line, "CSI") && *args) cmdCsi(args);
  else if (!strcasecmp(line, "BLESCAN") && *args) cmdBleScan(args);
  else if (!strcasecmp(line, "INFO")) cmdInfo();
  else if (!strcasecmp(line, "HELP") || !strcmp(line, "?")) printHelp();
  else Serial.println("ERR CMD (HELP for help)");
}
extern "C" void IRAM_ATTR esp_ieee802154_receive_done(uint8_t *frame, esp_ieee802154_frame_info_t *info) {
  Event e; memset(&e, 0, EV_HDR); e.proto = P_ZB; e.ch = zbChan;
  e.len = frame[0] >= 2 ? frame[0] - 2 : 0;          // PSDU length includes the 2-byte FCS
  if (e.len > MAX_PKT) e.len = MAX_PKT;
  e.origLen = e.len;
  e.rssi = info->rssi; e.lqi = info->lqi;
  memcpy(e.data, frame + 1, e.len);
  BaseType_t woken = pdFALSE;
  if (xRingbufferSendFromISR(evRing, &e, EV_HDR + e.len, &woken) != pdTRUE) zbDropped++;
  esp_ieee802154_receive_handle_done(frame);
  if (woken) portYIELD_FROM_ISR();
}
extern "C" void IRAM_ATTR esp_ieee802154_transmit_done(const uint8_t *frame, const uint8_t *ack, esp_ieee802154_frame_info_t *info) {
  portENTER_CRITICAL_ISR(&zbMux); zbTxPending = false; portEXIT_CRITICAL_ISR(&zbMux);
  if (ack) esp_ieee802154_receive_handle_done(ack);
  queueZbStatusFromISR(true, 0);
}
extern "C" void IRAM_ATTR esp_ieee802154_transmit_failed(const uint8_t *frame, esp_ieee802154_tx_error_t error) {
  portENTER_CRITICAL_ISR(&zbMux); zbTxPending = false; portEXIT_CRITICAL_ISR(&zbMux);
  queueZbStatusFromISR(false, (uint8_t)error);
}
extern "C" void wifiPromiscCb(void *buf, wifi_promiscuous_pkt_type_t type) {
  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t *)buf;
  uint32_t sig = pkt->rx_ctrl.sig_len;
  if (statOn) {
    int8_t rs = pkt->rx_ctrl.rssi;
    uint32_t air = airtimeUs(bbFmt(pkt->rx_ctrl, 0), pkt->rx_ctrl.rate, mcsOf(pkt->rx_ctrl, 0), sig);
    portENTER_CRITICAL(&stMux);
    st.frames++; st.bytes += sig; st.air += air; st.rssiSum += rs;
    if (rs > st.rssiMax) st.rssiMax = rs;
    portEXIT_CRITICAL(&stMux);
  }
  uint8_t bit = type == WIFI_PKT_MGMT ? 1 : type == WIFI_PKT_CTRL ? 2 : type == WIFI_PKT_DATA ? 4 : 0;
  if (!(wifiTypes & bit) || sig < 14) return;
  sig -= 4;                                           // drop FCS
  uint16_t snap = bit == 4 ? dataSnap : snapLen;
  Event e; memset(&e, 0, EV_HDR);
  e.proto = P_WIFI; e.ch = pkt->rx_ctrl.channel; e.rssi = pkt->rx_ctrl.rssi; e.origLen = sig;
  e.len = sig > snap ? snap : sig;
  memcpy(e.data, pkt->payload, e.len);
  if (!evPush(e)) dropped++;
}
extern "C" int bleGapEventCb(struct ble_gap_event *event, void *arg) {
  if (event->type == BLE_GAP_EVENT_DISC) {
    const struct ble_gap_disc_desc *d = &event->disc;
    Event e; memset(&e, 0, EV_HDR); e.proto = P_BLE; e.rssi = d->rssi; e.origLen = d->length_data;
    e.evtype = d->event_type; e.atype = d->addr.type;
    e.len = e.origLen > MAX_PKT ? MAX_PKT : e.origLen;
    memcpy(e.data, d->data, e.len);
    snprintf(e.addr, sizeof(e.addr), "%02x:%02x:%02x:%02x:%02x:%02x",
      d->addr.val[5], d->addr.val[4], d->addr.val[3], d->addr.val[2], d->addr.val[1], d->addr.val[0]);
    if (!evPush(e)) dropped++;
  }
  return 0;
}
static void printEvent(const Event &e) {
  if (e.type == 1) {
    if (e.len == 0) Serial.println("TXZB OK"); else Serial.printf("TXZB ERR %u\r\n", e.lqi);
    return;
  }
  int h;
  if (e.type == 2) h = snprintf(outBuf, 80, "CSI %u %d %s ", e.ch, e.rssi, e.addr);
  else switch (e.proto) {
    case P_WIFI: h = snprintf(outBuf, 80, e.origLen > e.len ? "RX WIFI! %u %d " : "RX WIFI %u %d ", e.ch, e.rssi); break;
    case P_BLE: h = snprintf(outBuf, 80, "RX BLE %s %d %u %u ", e.addr, e.rssi, e.evtype, e.atype); break;
    case P_ZB: h = snprintf(outBuf, 80, "RX ZB %u %d %u ", e.ch, e.rssi, e.lqi); break;
    default: return;
  }
  static const char digits[] = "0123456789abcdef";
  char *p = outBuf + h;
  for (int i = 0; i < e.len; ++i) { *p++ = digits[e.data[i] >> 4]; *p++ = digits[e.data[i] & 15]; }
  *p++ = '\r'; *p++ = '\n';
  Serial.write((const uint8_t *)outBuf, p - outBuf);
}
void setup() {
  Serial.setTxBufferSize(16384);                      // before begin(): a burst of frames must not block on the host
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  evRing = xRingbufferCreate(RING_BYTES, RINGBUF_TYPE_NOSPLIT);
  if (!evRing) { Serial.println("ERR RING ALLOC"); return; }
  esp_err_t err = nvs_flash_init();
  // Do not erase NVS automatically: report errors instead of deleting user data.
  if (!checkEsp("nvs_flash_init", err)) return;
  if (!checkEsp("esp_netif_init", esp_netif_init())) return;
  err = esp_event_loop_create_default();
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
    checkEsp("esp_event_loop_create_default", err); return;
  }
  platformReady = true;
  Serial.println(); Serial.println("ESP32-C5 USB radio bridge ready. Type HELP.");
}
void loop() {
  unsigned budget = 512;
  while (budget-- && Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineOverflow) { lineOverflow = false; linePos = 0; Serial.println("ERR LINE TOO LONG"); }
      else if (linePos) { lineBuf[linePos] = 0; handleLine(lineBuf); linePos = 0; }
    } else if (lineOverflow) {
    } else if (linePos < sizeof(lineBuf)-1) lineBuf[linePos++] = c;
    else lineOverflow = true;
  }
  bool busy = false;
  if (evRing) {
    uint32_t t0 = micros();
    size_t sz;
    while (Event *e = (Event *)xRingbufferReceive(evRing, &sz, 0)) {
      printEvent(*e); vRingbufferReturnItem(evRing, e); busy = true;
      if (micros() - t0 > LOOP_US) break;
    }
  }
  if (hopOn && (mode == MODE_WIFI || mode == MODE_ZB) && millis() - hopT >= hopMs) { hopT = millis(); hopStep(); }
  if (statOn && mode == MODE_WIFI && millis() - statT >= statMs) statFlush();
  static uint32_t droppedShown = 0;
  uint32_t total = dropped + zbDropped;
  if (total != droppedShown) { Serial.printf("WARN DROPPED %lu\r\n", (unsigned long)total); droppedShown = total; }
  if (!busy) delay(1);
}
