// Open Drone ID sniffer for ESP32-C5 (Arduino-ESP32 3.x). Not tested on hardware.
// Wi-Fi: beacons with the ODID vendor IE and NAN service discovery frames, hopping channels (2.4 and 5 GHz).
// BLE: service data 0xFFFA (app code 0x0D). Output, one line per frame: ODID,<wifi|ble>,<rssi>,<mac>,<hex>
// <hex> is the Message Pack or a single 25-byte message, optionally with the message counter in front.
#include <WiFi.h>
#include "esp_wifi.h"
#include "freertos/queue.h"
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

struct Frame { uint8_t src; int8_t rssi; uint8_t mac[6]; uint16_t len; uint8_t data[250]; };
static QueueHandle_t q;
static const uint8_t CH[] = {6, 1, 11, 149, 36};
static const uint8_t NAN_SID[6] = {0x88, 0x69, 0x19, 0x9D, 0x92, 0x09};   // service id "org.opendroneid.remoteid"

static void push(uint8_t src, int rssi, const uint8_t *mac, const uint8_t *d, size_t len) {
  if (len < 25 || len > sizeof(Frame::data)) return;
  Frame f; f.src = src; f.rssi = rssi; f.len = len;
  memcpy(f.mac, mac, 6); memcpy(f.data, d, len);
  xQueueSend(q, &f, 0);
}

static void onWifi(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT) return;
  auto *p = (wifi_promiscuous_pkt_t *)buf;
  const uint8_t *d = p->payload; int len = p->rx_ctrl.sig_len - 4;     // minus FCS
  if (len < 40) return;
  const uint8_t *mac = d + 10;                                         // transmitter address
  if (d[0] == 0x80) {                                                  // beacon: IEs start after the 24 + 12 byte header
    for (int i = 36; i + 2 <= len;) {
      int tl = d[i], l = d[i + 1];
      if (i + 2 + l > len) break;
      if (tl == 221 && l > 6 && d[i + 2] == 0xFA && d[i + 3] == 0x0B && d[i + 4] == 0xBC && d[i + 5] == 0x0D)
        push(0, p->rx_ctrl.rssi, mac, d + i + 6, l - 4);               // counter + pack
      i += 2 + l;
    }
  } else if (d[0] == 0xD0) {                                           // action frame: look for the NAN service id
    for (int i = 24; i + 6 + 10 < len; i++) {
      if (memcmp(d + i, NAN_SID, 6)) continue;
      int il = d[i + 9], o = i + 10;                                   // service info length, then counter + pack
      if (o + il <= len) push(0, p->rx_ctrl.rssi, mac, d + o, il);
      break;
    }
  }
}

class Cb : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice dev) override {
    if (!dev.haveServiceData()) return;
    for (int k = 0; k < dev.getServiceDataCount(); k++) {
      if (!dev.getServiceDataUUID(k).equals(BLEUUID((uint16_t)0xFFFA))) continue;
      String s = dev.getServiceData(k);
      if (s.length() < 27 || (uint8_t)s[0] != 0x0D) continue;          // app code, counter, message
      push(1, dev.getRSSI(), dev.getAddress().getNative(), (const uint8_t *)s.c_str() + 1, s.length() - 1);
    }
  }
};

void setup() {
  Serial.begin(115200);
  q = xQueueCreate(16, sizeof(Frame));
  WiFi.mode(WIFI_STA); WiFi.disconnect();
  wifi_promiscuous_filter_t flt = {.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT};
  esp_wifi_set_promiscuous_filter(&flt);
  esp_wifi_set_promiscuous_rx_cb(&onWifi);
  esp_wifi_set_promiscuous(true);
  BLEDevice::init("");
  BLEScan *sc = BLEDevice::getScan();
  sc->setAdvertisedDeviceCallbacks(new Cb(), true);
  sc->setActiveScan(false); sc->setInterval(100); sc->setWindow(99);
  sc->start(0, nullptr, false);
}

void loop() {
  static uint32_t hop = 0; static uint8_t ci = 0;
  if (millis() - hop > 300) { hop = millis(); esp_wifi_set_channel(CH[ci++ % sizeof(CH)], WIFI_SECOND_CHAN_NONE); }
  Frame f;
  while (xQueueReceive(q, &f, 0) == pdTRUE) {
    Serial.printf("ODID,%s,%d,%02x:%02x:%02x:%02x:%02x:%02x,", f.src ? "ble" : "wifi", f.rssi, f.mac[0], f.mac[1], f.mac[2], f.mac[3], f.mac[4], f.mac[5]);
    for (int i = 0; i < f.len; i++) Serial.printf("%02x", f.data[i]);
    Serial.println();
  }
  delay(2);
}
