/*
 * ============================================================
 *  ESP32-C5 USB Radio Bridge
 *  WiFi / BLE / Zigbee (IEEE 802.15.4) <-> USB CDC
 * ============================================================
 *
 * Среда: Arduino IDE + ядро "esp32 by Espressif Systems" >= 3.3.10
 *        (плата "ESP32C5 Dev Module", Tools -> USB CDC On Boot -> Enabled,
 *         Tools -> Partition Scheme -> "No FS 4MB (2MB APP x2)" или 8MB)
 *        Библиотека: NimBLE-Arduino (h2zero) >= 2.5.1
 *
 * Прошивка превращает ESP32-C5 в простой USB-мост к радио.
 * Всё управление и данные - текстовые строки через USB CDC (Serial).
 * Пакеты передаются hex-строками.
 *
 * Команды (регистр не важен):
 *   MODE WIFI|BLE|ZB|OFF   - переключение режима (радио одно на все протоколы)
 *   CH <n>                - канал: WiFi 1..14 (2.4G) или 36..177 (5G), ZB 11..26
 *   BAND 2G|5G            - диапазон WiFi (перезапускает режим WIFI)
 *   TX WIFI <hex>         - сырой кадр 802.11: beacon / probe req / probe resp /
 *                           action / non-QoS data, длина 24..1500, БЕЗ FCS
 *   TX BLE <hex>           - payload BLE-рекламы, до 31 байта (AD-структуры);
 *                           запускает ПОВТОРЯЮЩУЮСЯЮЮ рекламу (до следующей
 *                           TX BLE или смены режима)
 *   TX ZB <hex> [CSMA]     - кадр 802.15.4: FCF(2)+Seq(1)+...+payload,
 *                           без байта длины и без FCS (их добавит прошивка),
 *                           максимум 125 байт; CSMA - с проверкой канала
 *   INFO                   - текущий режим/канал/потери
 *   HELP                   - справка
 *
 * Вывод:
 *   RX WIFI [!] <hex>                       - принятый mgmt/ctrl кадр (вкл. FCS),
 *                                             ! = кадр обрезан до 320 байт
 *   RX BLE <mac> <rssi> <hex>               - принятая реклама
 *   RX ZB <rssi> <lqi> <hex>                - принятый кадр 802.15.4 (вкл. FCS)
 *   OK ... / ERR ...                        - подтверждения
 *   TXZB OK / TXZB ERR <code>               - результат передачи 802.15.4
 *
 * Ограничения (аппаратные/стековые, это нормально):
 *  - WiFi и 802.15.4 используют одно радио -> активен только один режим,
 *    переключение командой MODE.
 *  - WiFi: приём - только mgmt/ctrl кадры (data пропускаются), передача -
 *    только beacon/probe/action/non-QoS-data кадры (ограничение драйвера).
 *  - BLE: приём - рекламные пакеты (adv, пассивное сканирование), передача -
 *    payload рекламы (полностью произвольный PDU хост отправить не может).
 *  - Zigbee: приём/передача сырых кадров 802.15.4 (кадры Zigbee без разбора
 *    сетевого стека), режим promiscuous.
 */

#include <Arduino.h>
#include "esp32-hal-alloc-ble-mem.h"   // чтобы initArduino() не освобождал память BLE
#include <NimBLEDevice.h>              // приносит и низкоуровневый хост NimBLE (ble_gap_*)
#include "esp_wifi.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "esp_ieee802154.h"

// ---------------- настройки ----------------
#define MAX_PKT    320                 // макс. размер пакета в очереди
#define ZB_MAX     125                 // PSDU 802.15.4 без FCS (127 с FCS)
#define QUEUE_LEN  24                  // глубина очереди событий
#define EVENTS_PER_LOOP 8              // максимум событий за проход loop()

enum Proto    { P_WIFI, P_BLE, P_ZB };
enum RadioMode { MODE_OFF, MODE_WIFI, MODE_BLE, MODE_ZB };

typedef struct {
  uint8_t  type;                       // 0 = пакет, 1 = статус TX ZB
  uint8_t  proto;                       // Proto
  uint16_t len;                         // пакет: длина; статус: 0 = ok, 1 = ошибка
  int8_t   rssi;
  uint8_t   lqi;                       // пакет: LQI; статус: код ошибки
  uint16_t origLen;                     // исходная длина (обрезка)
  char     addr[18];                   // MAC BLE "xx:xx:xx:xx:xx:xx"
  uint8_t  data[MAX_PKT];
} Event;

static QueueHandle_t evtQueue = NULL;
static RadioMode mode = MODE_OFF;
static uint8_t  wifiChan = 6;          // 2.4G: 1..14, 5G: 36..177
static bool     wifi5g   = false;
static uint8_t  zbChan   = 11;          // 802.15.4: 11..26
static bool     zbTxPending = false;   // идёт передача 802.15.4
static volatile uint32_t dropped = 0;   // потеряно при переполнении очереди (WiFi/BLE)
static volatile uint32_t zbDropped = 0; // потеряно при переполнении очереди (ZB, ISR)
static portMUX_TYPE zbMux = portMUX_INITIALIZER_UNLOCKED;  // защита zbTxPending (ISR/task)
static uint8_t  zbTxBuf[ZB_MAX + 4];  // [len][psdu...][fcs fcs]
static char     lineBuf[4700];          // TX WIFI до 1500 байт = 3000 hex-символов
static size_t   linePos = 0;
static bool     lineOverflow = false;

// ---------------- колбэки (extern "C") ----------------
extern "C" {
  void IRAM_ATTR esp_ieee802154_receive_done(uint8_t *frame,
                                             esp_ieee802154_frame_info_t *frame_info);
  void IRAM_ATTR esp_ieee802154_transmit_done(const uint8_t *frame, const uint8_t *ack,
                                             esp_ieee802154_frame_info_t *ack_frame_info);
  void IRAM_ATTR esp_ieee802154_transmit_failed(const uint8_t *frame,
                                                esp_ieee802154_tx_error_t error);
  int  bleGapEventCb(struct ble_gap_event *event, void *arg);
  void wifiPromiscCb(void *buf, wifi_promiscuous_pkt_type_t type);
}

// ---------------- утилиты ----------------
static int parseHex(const char *s, uint8_t *out, int maxLen) {
  int n = 0, hi = -1;
  for (; *s; s++) {
    if (*s == ' ' || *s == '\t') continue;
    int v;
    if (*s >= '0' && *s <= '9')      v = *s - '0';
    else if (*s >= 'a' && *s <= 'f') v = *s - 'a' + 10;
    else if (*s >= 'A' && *s <= 'F') v = *s - 'A' + 10;
    else return -1;
    if (hi < 0) hi = v;
    else {
      if (n >= maxLen) return -1;
      out[n++] = (hi << 4) | v;
      hi = -1;
    }
  }
  return (hi >= 0) ? -1 : n;
}

static void printHex(const uint8_t *d, int len) {
  for (int i = 0; i < len; i++) Serial.printf("%02x", d[i]);
}

// из ISR: только числа, строки формируются в loop()
static void IRAM_ATTR queueZbStatusFromISR(bool ok, uint8_t code) {
  Event e = {};
  e.type  = 1;
  e.proto = P_ZB;
  e.len   = ok ? 0 : 1;
  e.lqi   = code;
  BaseType_t woken = pdFALSE;
  xQueueSendFromISR(evtQueue, &e, &woken);
}

static const char *modeName(RadioMode m) {
  switch (m) {
    case MODE_WIFI: return "WIFI";
    case MODE_BLE:  return "BLE";
    case MODE_ZB:   return "ZB";
    default:        return "OFF";
  }
}

// ---------------- запуск/остановка режимов ----------------
static void stopRadio() {
  if (mode == MODE_WIFI) {
    esp_wifi_set_promiscuous(false);
    esp_wifi_stop();
    esp_wifi_deinit();
  } else if (mode == MODE_BLE) {
    ble_gap_disc_cancel();             // может вернуть ошибку - не страшно
    ble_gap_adv_stop();
    NimBLEDevice::deinit();
  } else if (mode == MODE_ZB) {
    esp_ieee802154_disable();
    zbTxPending = false;
  }
  mode = MODE_OFF;
}

static bool startWifi() {
  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  esp_err_t err = esp_wifi_init(&cfg);
  if (err != ESP_OK) return false;
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  err = esp_wifi_set_mode(WIFI_MODE_AP);  // AP-интерфейс нужен для esp_wifi_80211_tx
  if (err != ESP_OK) { esp_wifi_deinit(); return false; }
  wifi_config_t wc = {};
  memcpy(wc.ap.ssid, "bridge", 6);    // скрытая точка - минимум шума в эфире
  wc.ap.ssid_len       = 6;
  wc.ap.channel        = wifiChan;
  wc.ap.authmode      = WIFI_AUTH_OPEN;
  wc.ap.ssid_hidden   = 1;
  wc.ap.max_connection = 0;
  if (esp_wifi_set_config(WIFI_IF_AP, &wc) != ESP_OK) {
    esp_wifi_deinit();
    return false;
  }
  if (esp_wifi_set_band_mode(wifi5g ? WIFI_BAND_MODE_5G_ONLY
                                    : WIFI_BAND_MODE_2G_ONLY) != ESP_OK ||
      esp_wifi_start() != ESP_OK) {
    esp_wifi_stop();
    esp_wifi_deinit();
    return false;
  }
  if (esp_wifi_set_channel(wifiChan, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
    esp_wifi_stop();
    esp_wifi_deinit();
    return false;
  }
  wifi_promiscuous_filter_t filt = {
    .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_CTRL
  };
  if (esp_wifi_set_promiscuous_filter(&filt) != ESP_OK ||          // data пропускаем
      esp_wifi_set_promiscuous_rx_cb(wifiPromiscCb) != ESP_OK ||
      esp_wifi_set_promiscuous(true) != ESP_OK) {
    esp_wifi_set_promiscuous(false);
    esp_wifi_stop();
    esp_wifi_deinit();
    return false;
  }
  return true;
}

static bool startBle() {
  if (!NimBLEDevice::init("bridge")) return false;
  struct ble_gap_disc_params dp = {};
  dp.passive           = 1;           // без активных scan-request
  dp.filter_duplicates = 0;           // присылать все пакеты
  dp.itvl              = 0x0060;     // 37.5 мс
  dp.window            = 0x0030;     // 30 мс
  if (ble_gap_disc(BLE_OWN_ADDR_PUBLIC, BLE_HS_FOREVER, &dp,
                   bleGapEventCb, NULL) != 0) {
    NimBLEDevice::deinit();          // откат: стек инициализирован, но скан не запущен
    return false;
  }
  return true;
}

static bool startZb() {
  esp_err_t err = esp_ieee802154_enable();
  if (err != ESP_OK) return false;
  if (esp_ieee802154_set_channel(zbChan) != ESP_OK ||
      esp_ieee802154_set_promiscuous(true) != ESP_OK ||
      esp_ieee802154_set_rx_when_idle(true) != ESP_OK ||  // авто-возврат в приём
      esp_ieee802154_receive() != ESP_OK) {
    esp_ieee802154_disable();
    return false;
  }
  return true;
}

static bool applyMode(RadioMode m) {
  stopRadio();
  bool ok = true;
  if (m == MODE_WIFI) ok = startWifi();
  else if (m == MODE_BLE) ok = startBle();
  else if (m == MODE_ZB) ok = startZb();
  if (ok) mode = m;
  return ok;
}

// ---------------- обработчики команд ----------------
static void cmdMode(const char *m) {
  RadioMode nm;
  if      (!strcasecmp(m, "OFF"))            nm = MODE_OFF;
  else if (!strcasecmp(m, "WIFI"))           nm = MODE_WIFI;
  else if (!strcasecmp(m, "BLE"))            nm = MODE_BLE;
  else if (!strcasecmp(m, "ZB") || !strcasecmp(m, "ZIGBEE")) nm = MODE_ZB;
  else { Serial.println("ERR MODE NAME"); return; }
  // не переключаемся, пока идёт передача 802.15.4
  if (mode == MODE_ZB && zbTxPending) { Serial.println("ERR TX BUSY"); return; }

  if (applyMode(nm)) Serial.printf("OK MODE %s\r\n", modeName(mode));
  else { mode = MODE_OFF; Serial.println("ERR MODE START"); }
}

static void cmdChannel(int ch) {
  if (mode == MODE_WIFI) {
    if (ch < 1 || ch > 200) { Serial.println("ERR CH"); return; }
    if (esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
      Serial.println("ERR CH SET"); return;
    }
    wifiChan = ch;
    Serial.printf("OK CH %d\r\n", ch);
  } else if (mode == MODE_ZB) {
    if (ch < 11 || ch > 26) { Serial.println("ERR CH 11..26"); return; }
    if (esp_ieee802154_set_channel(ch) != ESP_OK) {
      Serial.println("ERR CH SET"); return;
    }
    zbChan = ch;
    Serial.printf("OK CH %d\r\n", ch);
  } else {
    Serial.println("ERR NO ACTIVE RADIO");
  }
}

static void cmdBand(const char *b) {
  if (!strcasecmp(b, "2G"))      wifi5g = false;
  else if (!strcasecmp(b, "5G")) wifi5g = true;
  else { Serial.println("ERR BAND"); return; }
  // канал должен соответствовать диапазону
  wifiChan = wifi5g ? 36 : 6;
  if (mode == MODE_WIFI) {        // применяем перезапуском WiFi
    if (applyMode(MODE_WIFI)) Serial.printf("OK BAND %s\r\n", wifi5g ? "5G" : "2G");
    else { mode = MODE_OFF; Serial.println("ERR MODE START"); }
  } else {
    Serial.printf("OK BAND %s\r\n", wifi5g ? "5G" : "2G");
  }
}

static void cmdTxWifi(const char *hex) {
  if (mode != MODE_WIFI) { Serial.println("ERR NOT WIFI MODE"); return; }
  static uint8_t buf[1500];
  int n = parseHex(hex, buf, sizeof(buf));
  // драйвер принимает только кадры 24..1500 байт (без FCS)
  if (n < 24 || n > 1500) { Serial.println("ERR HEX 24..1500"); return; }
  // en_sys_seq=false: seq из кадра сохраняется (драйвер не подменяет его)
  esp_err_t err = esp_wifi_80211_tx(WIFI_IF_AP, buf, n, false);
  Serial.println(err == ESP_OK ? "OK TX WIFI" : "ERR TX WIFI");
}

static void cmdTxBle(const char *hex) {
  if (mode != MODE_BLE) { Serial.println("ERR NOT BLE MODE"); return; }
  uint8_t buf[31];
  int n = parseHex(hex, buf, sizeof(buf));
  if (n < 1) { Serial.println("ERR HEX"); return; }
  ble_gap_adv_stop();              // если реклама уже идёт - останавливаем
  struct ble_gap_adv_params ap = {};
  ap.conn_mode = BLE_GAP_CONN_MODE_NON;   // неконнектируемая реклама
  ap.disc_mode = BLE_GAP_DISC_MODE_GEN;
  ap.itvl_min  = 0x20;                   // 20 мс
  ap.itvl_max  = 0x40;                   // 40 мс
  int rc = ble_gap_adv_set_data(buf, n);
  if (rc == 0) rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL,
                                     BLE_HS_FOREVER, &ap, bleGapEventCb, NULL);
  Serial.println(rc == 0 ? "OK TX BLE" : "ERR TX BLE");
}

static void cmdTxZb(char *args) {
  if (mode != MODE_ZB) { Serial.println("ERR NOT ZB MODE"); return; }
  // резервируем буфер ДО записи в него и до transmit (гонка с ISR-колбэком)
  portENTER_CRITICAL(&zbMux);
  if (zbTxPending) {
    portEXIT_CRITICAL(&zbMux);
    Serial.println("ERR TX BUSY");   // прошивка ещё передаёт
    return;
  }
  zbTxPending = true;
  portEXIT_CRITICAL(&zbMux);
  bool csma = false;
  char *sp = strrchr(args, ' ');      // последний токен может быть CSMA
  if (sp) {
    if (!strcasecmp(sp + 1, "CSMA")) {
      csma = true;
      *sp = 0;                        // отрезаем токен от hex-строки
    }                                  // иначе считаем это частью hex (с пробелами)
  }
  int n = parseHex(args, zbTxBuf + 1, ZB_MAX);
  if (n < 3 || n > ZB_MAX) {  // FCF(2)+Seq(1) минимум
    portENTER_CRITICAL(&zbMux);
    zbTxPending = false;
    portEXIT_CRITICAL(&zbMux);
    Serial.println("ERR HEX 1..125");
    return;
  }
  zbTxBuf[0]     = n + 2;            // байт длины: psdu + FCS(2)
  zbTxBuf[n + 1] = 0;                // FCS посчитает и подставит железо
  zbTxBuf[n + 2] = 0;
  esp_err_t err = esp_ieee802154_transmit(zbTxBuf, csma);
  if (err == ESP_OK) {
    Serial.println("OK TX ZB");    // флаг сбросится в transmit_done/failed
  } else {
    portENTER_CRITICAL(&zbMux);
    zbTxPending = false;
    portEXIT_CRITICAL(&zbMux);
    Serial.println("ERR TX ZB");
  }
}

static void cmdInfo() {
  Serial.printf("MODE %s", modeName(mode));
  if (mode == MODE_WIFI) Serial.printf(" CH %d BAND %s", wifiChan, wifi5g ? "5G" : "2G");
  if (mode == MODE_ZB)   Serial.printf(" CH %d", zbChan);
  Serial.printf(" DROPPED %lu\r\n", (unsigned long)(dropped + zbDropped));
}

static void printHelp() {
  Serial.println("MODE WIFI|BLE|ZB|OFF - режим радио");
  Serial.println("CH <n>               - канал (WIFI 1-14/5G 36-177, ZB 11-26)");
  Serial.println("BAND 2G|5G           - диапазон WiFi");
  Serial.println("TX WIFI <hex>        - кадр 802.11 24..1500 байт (без FCS)");
  Serial.println("TX BLE <hex>         - payload рекламы <=31 байт (повторяется)");
  Serial.println("TX ZB <hex> [CSMA]   - кадр 802.15.4 <=125 байт (без длины и FCS)");
  Serial.println("INFO / HELP          - состояние / справка");
}

static void handleLine(char *line) {
  char *args = strchr(line, ' ');
  if (args) { *args = 0; args++; }
  else args = line + strlen(line);   // пустые аргументы

  if (!strcasecmp(line, "MODE") && *args)        cmdMode(args);
  else if (!strcasecmp(line, "CH") && *args)     cmdChannel(atoi(args));
  else if (!strcasecmp(line, "BAND") && *args)    cmdBand(args);
  else if (!strcasecmp(line, "TX") && *args) {
    char *hex = strchr(args, ' ');
    if (!hex) { Serial.println("ERR TX"); return; }
    *hex++ = 0;
    if      (!strcasecmp(args, "WIFI")) cmdTxWifi(hex);
    else if (!strcasecmp(args, "BLE"))  cmdTxBle(hex);
    else if (!strcasecmp(args, "ZB"))   cmdTxZb(hex);
    else Serial.println("ERR TX PROTO");
  }
  else if (!strcasecmp(line, "INFO"))  cmdInfo();
  else if (!strcasecmp(line, "HELP") || !strcmp(line, "?")) printHelp();
  else Serial.println("ERR CMD (HELP for help)");
}

// ---------------- колбэки радио ----------------
extern "C" void IRAM_ATTR esp_ieee802154_receive_done(
    uint8_t *frame, esp_ieee802154_frame_info_t *frame_info) {
  uint8_t flen = frame[0];                   // длина включает FCS
  if (flen > MAX_PKT) flen = MAX_PKT;
  Event e = {};
  e.type = 0;
  e.proto = P_ZB;
  e.len   = flen;
  e.origLen = frame[0];
  e.rssi  = frame_info->rssi;
  e.lqi   = frame_info->lqi;
  memcpy(e.data, frame + 1, flen);           // содержимое после байта длины
  BaseType_t woken = pdFALSE;
  if (xQueueSendFromISR(evtQueue, &e, &woken) != pdTRUE) {
    zbDropped++;                     // переполнение очереди
  }
  esp_ieee802154_receive_handle_done(frame);  // вернуть буфер драйверу
}

extern "C" void IRAM_ATTR esp_ieee802154_transmit_done(
    const uint8_t *frame, const uint8_t *ack,
    esp_ieee802154_frame_info_t *ack_frame_info) {
  portENTER_CRITICAL_ISR(&zbMux);
  zbTxPending = false;
  portEXIT_CRITICAL_ISR(&zbMux);
  // буфер ACK тоже нужно вернуть драйверу
  if (ack != NULL) esp_ieee802154_receive_handle_done(ack);
  queueZbStatusFromISR(true, 0);
}

extern "C" void IRAM_ATTR esp_ieee802154_transmit_failed(
    const uint8_t *frame, esp_ieee802154_tx_error_t error) {
  portENTER_CRITICAL_ISR(&zbMux);
  zbTxPending = false;
  portEXIT_CRITICAL_ISR(&zbMux);
  queueZbStatusFromISR(false, (uint8_t)error);
}

extern "C" void wifiPromiscCb(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT && type != WIFI_PKT_CTRL) return;  // data пропускаем
  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t *)buf;
  Event e = {};
  e.type = 0;
  e.proto = P_WIFI;
  e.origLen = pkt->rx_ctrl.sig_len;          // включает FCS (4 байта в конце)
  e.len = e.origLen > MAX_PKT ? MAX_PKT : e.origLen;
  memcpy(e.data, pkt->payload, e.len);
  if (xQueueSend(evtQueue, &e, 0) != pdTRUE) dropped++;
}

extern "C" int bleGapEventCb(struct ble_gap_event *event, void *arg) {
  if (event->type == BLE_GAP_EVENT_DISC) {
    const struct ble_gap_disc_desc *d = &event->disc;
    Event e = {};
    e.type = 0;
    e.proto = P_BLE;
    e.rssi = d->rssi;
    e.origLen = d->length_data;
    e.len = e.origLen > MAX_PKT ? MAX_PKT : e.origLen;
    memcpy(e.data, d->data, e.len);
    snprintf(e.addr, sizeof(e.addr), "%02x:%02x:%02x:%02x:%02x:%02x",
             d->addr.val[5], d->addr.val[4], d->addr.val[3],
             d->addr.val[2], d->addr.val[1], d->addr.val[0]);
    if (xQueueSend(evtQueue, &e, 0) != pdTRUE) dropped++;
  }
  return 0;   // сканирование продолжается
}

// ---------------- вывод событий ----------------
static void printEvent(const Event &e) {
  if (e.type == 1) {                        // статус TX ZB
    if (e.len == 0) Serial.println("TXZB OK");
    else Serial.printf("TXZB ERR %u\r\n", e.lqi);
    return;
  }
  switch (e.proto) {
    case P_WIFI:
      Serial.print(e.origLen > MAX_PKT ? "RX WIFI! " : "RX WIFI ");  // ! = обрезан
      printHex(e.data, e.len);
      Serial.println();
      break;
    case P_BLE:
      Serial.printf("RX BLE %s %d ", e.addr, e.rssi);
      printHex(e.data, e.len);
      Serial.println();
      break;
    case P_ZB:
      Serial.printf("RX ZB %d %u ", e.rssi, e.lqi);
      printHex(e.data, e.len);
      Serial.println();
      break;
  }
}

// ---------------- arduino ----------------
void setup() {
  Serial.begin(115200);            // USB CDC: скорость игнорируется
  evtQueue = xQueueCreate(QUEUE_LEN, sizeof(Event));
  nvs_flash_init();                // нужно WiFi и NimBLE (повторный вызов безвреден)
  esp_netif_init();
  Serial.println();
  Serial.println("ESP32-C5 USB radio bridge ready. Type HELP.");
}

void loop() {
  // приём строк из USB
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineOverflow) {           // остаток длинной строки отброшен целиком
        lineOverflow = false;
        linePos = 0;
        Serial.println("ERR LINE TOO LONG");
      } else if (linePos) {
        lineBuf[linePos] = 0;
        handleLine(lineBuf);
        linePos = 0;
      }
    } else if (lineOverflow) {
      // пропускаем всё до конца строки
    } else if (linePos < sizeof(lineBuf) - 1) {
      lineBuf[linePos++] = c;
    } else {
      lineOverflow = true;          // дальше до перевода строки игнорируем
    }
  }

  // печать событий из очереди (ограниченно - чтобы команды не голодали)
  Event e;
  for (int i = 0; i < EVENTS_PER_LOOP; i++) {
    if (xQueueReceive(evtQueue, &e, 0) != pdTRUE) break;
    printEvent(e);
  }

  // потери при переполнении очереди (WiFi/BLE + ZB)
  static uint32_t droppedShown = 0;
  uint32_t total = dropped + zbDropped;
  if (total != droppedShown) {
    Serial.printf("WARN DROPPED %lu\r\n", (unsigned long)total);
    droppedShown = total;
  }

  delay(1);
}
