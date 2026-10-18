/* ESP32-C5 USB Radio Bridge
 * Arduino ESP32 >=3.3.10; NimBLE-Arduino >=2.5.1
 * USB CDC On Boot: Enabled
 * MODE WIFI|BLE|ZB|OFF; CH n; BAND 2G|5G;
 * TX WIFI hex; TX BLE hex; TX ZB hex [CSMA]; INFO; HELP
 * WiFi RX: mgmt/ctrl, up to 320 bytes. TX: 24..1500 without FCS.
 * BLE: legacy advertisement payload <=31 bytes.
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
#define MAX_PKT 320
#define ZB_MAX 125
#define QUEUE_LEN 24
#define EVENTS_PER_LOOP 8

enum Proto { P_WIFI, P_BLE, P_ZB };
enum RadioMode { MODE_OFF, MODE_WIFI, MODE_BLE, MODE_ZB };
struct Event {
  uint8_t type, proto;
  uint16_t len;
  int8_t rssi;
  uint8_t lqi;
  uint16_t origLen;
  char addr[18];
  uint8_t data[MAX_PKT];
};
static QueueHandle_t evtQueue = NULL;
static RadioMode mode = MODE_OFF;
static uint8_t wifiChan = 6, zbChan = 11;
static bool wifi5g = false;
static bool zbTxPending = false;
static volatile uint32_t dropped = 0, zbDropped = 0;
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
static void printHex(const uint8_t *d, int len) {
  static const char digits[] = "0123456789abcdef";
  char chunk[129];
  while (len > 0) {
    int n = len > 64 ? 64 : len;
    for (int i = 0; i < n; ++i) {
      chunk[2*i] = digits[d[i] >> 4]; chunk[2*i+1] = digits[d[i] & 15];
    }
    Serial.write((const uint8_t *)chunk, n * 2);
    d += n; len -= n;
  }
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
static void IRAM_ATTR queueZbStatusFromISR(bool ok, uint8_t code) {
  Event e = {}; e.type = 1; e.proto = P_ZB; e.len = ok ? 0 : 1; e.lqi = code;
  BaseType_t woken = pdFALSE;
  if (xQueueSendFromISR(evtQueue, &e, &woken) != pdTRUE) zbDropped++;
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

static bool startWifi() {
  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  if (!checkEsp("esp_wifi_init", esp_wifi_init(&cfg))) return false;
  bool started = false;
  wifi_config_t wc = {};
  wifi_promiscuous_filter_t filt = {};
  filt.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_CTRL;
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
  if (!checkEsp("esp_wifi_set_promiscuous", esp_wifi_set_promiscuous(true))) goto fail;
  return true;
fail:
  if (started) { esp_wifi_set_promiscuous(false); esp_wifi_stop(); }
  esp_wifi_deinit();
  return false;
}
static bool startBle() {
  if (!NimBLEDevice::init("bridge")) { Serial.println("ERR BLE INIT"); return false; }
  struct ble_gap_disc_params dp = {};
  dp.passive = 1; dp.filter_duplicates = 0;
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
    wifiChan = ch;
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
  if (mode == MODE_WIFI) Serial.printf(" CH %d BAND %s", wifiChan, wifi5g ? "5G" : "2G");
  if (mode == MODE_ZB) Serial.printf(" CH %d", zbChan);
  Serial.printf(" DROPPED %lu\r\n", (unsigned long)(dropped + zbDropped));
}
static void printHelp() {
  Serial.println("MODE WIFI|BLE|ZB|OFF");
  Serial.println("CH <n> - WIFI channel (subject to band/country/driver), ZB 11..26");
  Serial.println("BAND 2G|5G - default channel 6/36; restarts active WIFI");
  Serial.println("TX WIFI <hex> - 24..1500 bytes, no FCS");
  Serial.println("TX BLE <hex> - advertisement payload <=31 bytes, repeats");
  Serial.println("TX ZB <hex> [CSMA] - 3..125 bytes, no length/FCS");
  Serial.println("INFO / HELP");
}
static char *skipSpace(char *p) { while (*p == ' ' || *p == '\t') ++p; return p; }
static char *splitToken(char *p) {
  while (*p && *p != ' ' && *p != '\t') ++p;
  if (*p) *p++ = 0;
  return skipSpace(p);
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
  } else if (!strcasecmp(line, "INFO")) cmdInfo();
  else if (!strcasecmp(line, "HELP") || !strcmp(line, "?")) printHelp();
  else Serial.println("ERR CMD (HELP for help)");
}
extern "C" void IRAM_ATTR esp_ieee802154_receive_done(uint8_t *frame, esp_ieee802154_frame_info_t *info) {
  Event e = {}; e.proto = P_ZB; e.len = frame[0]; e.origLen = frame[0];
  e.rssi = info->rssi; e.lqi = info->lqi;
  memcpy(e.data, frame + 1, e.len);
  BaseType_t woken = pdFALSE;
  if (xQueueSendFromISR(evtQueue, &e, &woken) != pdTRUE) zbDropped++;
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
  if (type != WIFI_PKT_MGMT && type != WIFI_PKT_CTRL) return;
  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t *)buf;
  Event e = {}; e.proto = P_WIFI; e.origLen = pkt->rx_ctrl.sig_len;
  e.len = e.origLen > MAX_PKT ? MAX_PKT : e.origLen;
  memcpy(e.data, pkt->payload, e.len);
  if (xQueueSend(evtQueue, &e, 0) != pdTRUE) dropped++;
}
extern "C" int bleGapEventCb(struct ble_gap_event *event, void *arg) {
  if (event->type == BLE_GAP_EVENT_DISC) {
    const struct ble_gap_disc_desc *d = &event->disc;
    Event e = {}; e.proto = P_BLE; e.rssi = d->rssi; e.origLen = d->length_data;
    e.len = e.origLen > MAX_PKT ? MAX_PKT : e.origLen;
    memcpy(e.data, d->data, e.len);
    snprintf(e.addr, sizeof(e.addr), "%02x:%02x:%02x:%02x:%02x:%02x",
      d->addr.val[5], d->addr.val[4], d->addr.val[3], d->addr.val[2], d->addr.val[1], d->addr.val[0]);
    if (xQueueSend(evtQueue, &e, 0) != pdTRUE) dropped++;
  }
  return 0;
}
static void printEvent(const Event &e) {
  if (e.type == 1) {
    if (e.len == 0) Serial.println("TXZB OK"); else Serial.printf("TXZB ERR %u\r\n", e.lqi);
    return;
  }
  switch (e.proto) {
    case P_WIFI: Serial.print(e.origLen > MAX_PKT ? "RX WIFI! " : "RX WIFI "); break;
    case P_BLE: Serial.printf("RX BLE %s %d ", e.addr, e.rssi); break;
    case P_ZB: Serial.printf("RX ZB %d %u ", e.rssi, e.lqi); break;
    default: return;
  }
  printHex(e.data, e.len); Serial.println();
}
void setup() {
  Serial.begin(115200);
  evtQueue = xQueueCreate(QUEUE_LEN, sizeof(Event));
  if (!evtQueue) { Serial.println("ERR QUEUE ALLOC"); return; }
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
  if (evtQueue) {
    Event e;
    for (int i = 0; i < EVENTS_PER_LOOP; ++i) {
      if (xQueueReceive(evtQueue, &e, 0) != pdTRUE) break;
      printEvent(e);
    }
  }
  static uint32_t droppedShown = 0;
  uint32_t total = dropped + zbDropped;
  if (total != droppedShown) { Serial.printf("WARN DROPPED %lu\r\n", (unsigned long)total); droppedShown = total; }
  delay(1);
}
