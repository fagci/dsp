// Wi-Fi 802.11 sniffer for ESP32 (Arduino-ESP32 2.x / 3.x). Not tested on hardware.
// Promiscuous mode, channel hopping. One line per frame: WIFI,<channel>,<rssi>,<hex of the frame without FCS>
// Commands (one line each, 115200): CH <n> (stay on a channel) | HOP (hop 1…13) | TYPE <mgmt|ctrl|data|all>
//   | SNAP <bytes> (frame bytes kept, default 160, max 400) | DWELL <ms> (hop dwell, default 250)
// Use only on your own network or with permission; the frames are not decrypted, data payload is cut by SNAP.
#include <WiFi.h>
#include "esp_wifi.h"
#include "freertos/queue.h"

struct Frame { int8_t rssi; uint8_t ch; uint16_t len; uint8_t d[400]; };
static QueueHandle_t q;
static volatile uint8_t gTypes = 0x7;          // bit0 mgmt, bit1 ctrl, bit2 data
static volatile uint16_t gSnap = 160;
static volatile uint8_t gCh = 1;
static bool hop = true;
static uint16_t dwell = 250;

static void onPkt(void *buf, wifi_promiscuous_pkt_type_t type) {
  uint8_t bit = type == WIFI_PKT_MGMT ? 1 : type == WIFI_PKT_CTRL ? 2 : type == WIFI_PKT_DATA ? 4 : 0;
  if (!(gTypes & bit)) return;
  auto *p = (wifi_promiscuous_pkt_t *)buf;
  int len = p->rx_ctrl.sig_len - 4;            // minus FCS
  if (len < 10) return;
  Frame f; f.rssi = p->rx_ctrl.rssi; f.ch = p->rx_ctrl.channel;
  f.len = len < gSnap ? len : gSnap;
  memcpy(f.d, p->payload, f.len);
  xQueueSend(q, &f, 0);
}

static void setCh(uint8_t c) { gCh = c; esp_wifi_set_channel(c, WIFI_SECOND_CHAN_NONE); }

static void command(String s) {
  s.trim(); s.toUpperCase();
  if (s.startsWith("CH ")) { hop = false; setCh(s.substring(3).toInt()); }
  else if (s == "HOP") hop = true;
  else if (s.startsWith("TYPE ")) {
    String t = s.substring(5);
    gTypes = t == "MGMT" ? 1 : t == "CTRL" ? 2 : t == "DATA" ? 4 : 7;
  }
  else if (s.startsWith("SNAP ")) gSnap = constrain(s.substring(5).toInt(), 24, 400);
  else if (s.startsWith("DWELL ")) dwell = constrain(s.substring(6).toInt(), 20, 5000);
}

void setup() {
  Serial.begin(115200);
  q = xQueueCreate(64, sizeof(Frame));
  WiFi.mode(WIFI_STA); WiFi.disconnect();
  esp_wifi_set_promiscuous_rx_cb(&onPkt);
  esp_wifi_set_promiscuous(true);
  setCh(1);
}

void loop() {
  static uint32_t t0 = 0; static String line;
  Frame f;
  while (xQueueReceive(q, &f, 0) == pdTRUE) {
    Serial.printf("WIFI,%u,%d,", f.ch, f.rssi);
    for (int i = 0; i < f.len; i++) Serial.printf("%02x", f.d[i]);
    Serial.println();
  }
  while (Serial.available()) { char c = Serial.read(); if (c == '\n') { command(line); line = ""; } else if (line.length() < 40) line += c; }
  if (hop && millis() - t0 > dwell) { t0 = millis(); setCh(gCh % 13 + 1); }
  delay(2);
}
