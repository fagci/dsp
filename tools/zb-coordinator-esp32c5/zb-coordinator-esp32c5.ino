/* ESP32-C5 Zigbee Coordinator Bridge for DSP
 * Arduino ESP32 core >= 3.3 (Zigbee on ESP32-C5). IDE settings:
 *   USB CDC On Boot: Enabled
 *   Tools -> Zigbee mode: Coordinator (ZCZR)
 *   Partition scheme: Zigbee 4MB with spiffs
 * The C5 is the Zigbee COORDINATOR (it forms the network; a router only relays).
 * Any ZHA temperature/humidity sensor (Aqara, Sonoff SNZB-02, Tuya, or a DIY
 * ESP32-C6/H2 running the Zigbee_TemperatureSensor example) joins while the
 * network is open and is bound automatically to the temperature measurement
 * (0x0402) and relative humidity measurement (0x0405) clusters - many sensors
 * at once, each new device is found on its announce. Based on the
 * ZigbeeThermostat client clusters of the arduino-esp32 Zigbee library.
 * RX lines (JSON, one per measurement - the DSP Serial Port node parses them
 * into records):
 *   {"zb":"temp","addr":"0x1234","ep":1,"v":23.45}
 *   {"zb":"hum","addr":"0x1234","ep":1,"v":48.20}
 *   {"zb":"join","addr":"0x1234","ep":1}
 * addr is the short address, or the IEEE xx:xx:xx:xx:xx:xx:xx:xx when only a
 * long address is known. Non-JSON status lines (ZB ...) come as plain text.
 * TX commands (one per line): HELP, INFO, OPEN s, REPORT min s max s delta,
 * POLL, POLLALL s, RESET, DEBUG. The network re-opens for joining every
 * OPEN_REPEAT_S seconds and every bound sensor is polled every POLL_ALL_S
 * seconds (0 = off) - fine for a lab, close it for anything reachable by
 * others.
 * Values that cannot be real (the Zigbee "invalid" 0x8000 = -327.68, a reading
 * outside the sensor range, NaN) are not passed on as measurements:
 *   {"zb":"bad","kind":"temp","addr":"0x1234","ep":1,"v":-327.68}
 * Temperature is accepted only inside the sensor's own range (TEMP_MIN_C..TEMP_MAX_C, -10..50 C for the test sensor: below that it showed -35..-20 C at -7 C outside), humidity from 0 up to (not including) 100 % - the sensor sends 125.00 C and 100.00 % together after a pause.
 * Hardware status: tested on an ESP32-C5 with one sensor - network forming,
 * join, INFO, REPORT and POLLALL commands. Measurements seen on hardware over ser2net
 * (readings outside the sensor range were wrong); the "bad" filter itself is not yet seen running.
 */
#include <Arduino.h>
#ifndef ZIGBEE_MODE_ZCZR
#error "Zigbee coordinator mode is not selected in Tools->Zigbee mode"
#endif
#include "Zigbee.h"

#define GW_ENDPOINT   1
#define MAX_DEVICES   32
#define OPEN_ON_BOOT  180  // seconds the network stays open after boot
#define OPEN_REPEAT_S 300  // reopen for joining this often (0 = only OPEN cmd)
#define POLL_ALL_S    60   // poll every bound sensor this often (0 = off)
// Паспортный диапазон датчика, °C: что за его пределами, датчик не измеряет, а выдаёт мусор (проверено: при -7 на улице он показывал -35...-20).
// Поставьте диапазон своей модели; для датчика с запасом можно расширить.
#define TEMP_MIN_C    -10.0f
#define TEMP_MAX_C    50.0f

static uint16_t repMinS = 10, repMaxS = 300;  // reporting: min / max interval, seconds
static float repDeltaT = 0.5, repDeltaH = 1.0;  // report on change: °C / %
static unsigned pollAllCfgS = POLL_ALL_S;  // POLLALL runtime value

ZigbeeThermostat zbThermostat(GW_ENDPOINT);

struct DevCfg { uint8_t ieee[8]; uint8_t endpoint; };
static DevCfg devCfg[MAX_DEVICES];
static uint8_t devCfgN = 0;
static bool debugOn = false;

static void fmtZclAddr(const esp_zb_zcl_addr_t &a, char *buf, size_t n) {
  if (a.addr_type == ESP_ZB_ZCL_ADDR_TYPE_SHORT) {
    snprintf(buf, n, "0x%04x", a.u.short_addr);
  } else {
    snprintf(buf, n, "%02x:%02x:%02x:%02x:%02x:%02x:%02x:%02x", a.u.ieee_addr[7], a.u.ieee_addr[6], a.u.ieee_addr[5], a.u.ieee_addr[4], a.u.ieee_addr[3],
            a.u.ieee_addr[2], a.u.ieee_addr[1], a.u.ieee_addr[0]);
  }
}

static void fmtIeee(const uint8_t *e, char *buf, size_t n) {
  snprintf(buf, n, "%02x:%02x:%02x:%02x:%02x:%02x:%02x:%02x", e[7], e[6], e[5], e[4], e[3], e[2], e[1], e[0]);
}

/********************* sensor reports -> JSON lines *********************/
// Температура — по паспорту датчика (TEMP_MIN_C / TEMP_MAX_C); влажность 100.00 % приходит заглушкой вместе с 125.00 °C после паузы
static bool tempOk(float v) { return v >= TEMP_MIN_C && v <= TEMP_MAX_C; }   // NaN fails both comparisons
static bool humOk(float v) { return v >= 0.0f && v < 100.0f; }

static void onTemp(float v, uint8_t ep, esp_zb_zcl_addr_t src) {
  char a[24];
  fmtZclAddr(src, a, sizeof(a));
  if (!tempOk(v)) {
    Serial.printf("{\"zb\":\"bad\",\"kind\":\"temp\",\"addr\":\"%s\",\"ep\":%u,\"v\":%.2f}\r\n", a, ep, isnan(v) ? 0.0f : v);
    return;
  }
  Serial.printf("{\"zb\":\"temp\",\"addr\":\"%s\",\"ep\":%u,\"v\":%.2f}\r\n", a, ep, v);
}

static void onHum(float v, uint8_t ep, esp_zb_zcl_addr_t src) {
  char a[24];
  fmtZclAddr(src, a, sizeof(a));
  if (!humOk(v)) {
    Serial.printf("{\"zb\":\"bad\",\"kind\":\"hum\",\"addr\":\"%s\",\"ep\":%u,\"v\":%.2f}\r\n", a, ep, isnan(v) ? 0.0f : v);
    return;
  }
  Serial.printf("{\"zb\":\"hum\",\"addr\":\"%s\",\"ep\":%u,\"v\":%.2f}\r\n", a, ep, v);
}

static bool cfgDone(const uint8_t *ieee, uint8_t ep) {
  for (uint8_t i = 0; i < devCfgN; i++) {
    if (devCfg[i].endpoint == ep && memcmp(devCfg[i].ieee, ieee, 8) == 0) return true;
  }
  return false;
}

static void pollDevice(zb_device_params_t *d) {
  bool byIeee = (d->short_addr == 0x0000 || d->short_addr == 0xFFFF);
  if (byIeee) {
    zbThermostat.getTemperature(d->endpoint, d->ieee_addr);
    zbThermostat.getHumidity(d->endpoint, d->ieee_addr);
  } else {
    zbThermostat.getTemperature(d->endpoint, d->short_addr);
    zbThermostat.getHumidity(d->endpoint, d->short_addr);
  }
}

/* Bindings appear here after a sensor joins (or are recalled from the binding
 * table after a reboot). For every new one: set the reporting it should send
 * us and poll it once so a value arrives immediately. */
static void maintain() {
  std::list<zb_device_params_t *> devs = zbThermostat.getBoundDevices();
  for (auto d : devs) {
    if (cfgDone(d->ieee_addr, d->endpoint)) continue;
    bool byIeee = (d->short_addr == 0x0000 || d->short_addr == 0xFFFF);
    if (byIeee) {
      zbThermostat.setTemperatureReporting(d->endpoint, d->ieee_addr, repMinS, repMaxS, repDeltaT);
      zbThermostat.setHumidityReporting(d->endpoint, d->ieee_addr, repMinS, repMaxS, repDeltaH);
    } else {
      zbThermostat.setTemperatureReporting(d->endpoint, d->short_addr, repMinS, repMaxS, repDeltaT);
      zbThermostat.setHumidityReporting(d->endpoint, d->short_addr, repMinS, repMaxS, repDeltaH);
    }
    pollDevice(d);
    if (devCfgN < MAX_DEVICES) {
      memcpy(devCfg[devCfgN].ieee, d->ieee_addr, 8);
      devCfg[devCfgN].endpoint = d->endpoint;
      devCfgN++;
    }
    char a[24];
    if (byIeee) fmtIeee(d->ieee_addr, a, sizeof(a));
    else snprintf(a, sizeof(a), "0x%04x", d->short_addr);
    Serial.printf("{\"zb\":\"join\",\"addr\":\"%s\",\"ep\":%u}\r\n", a, d->endpoint);
  }
}

/***************************** serial commands *****************************/
static void printInfo() {
  Serial.printf("ZB INFO PAN 0x%04x CH %u SHORT 0x%04x DEV %u REPORT %us %us %.1fC %.1f%%\r\n", esp_zb_get_pan_id(), esp_zb_get_current_channel(),
                esp_zb_get_short_address(), (unsigned)zbThermostat.getBoundDevices().size(), repMinS, repMaxS, repDeltaT, repDeltaH);
  uint8_t i = 0;
  for (auto d : zbThermostat.getBoundDevices()) {
    char a[24];
    if (d->short_addr == 0x0000 || d->short_addr == 0xFFFF) fmtIeee(d->ieee_addr, a, sizeof(a));
    else snprintf(a, sizeof(a), "0x%04x", d->short_addr);
    Serial.printf("ZB DEV %u %s EP %u\r\n", i++, a, d->endpoint);
  }
}

static void handleLine(char *l) {
  char *tok = strtok(l, " \t");
  if (!tok) return;
  if (!strcasecmp(tok, "HELP")) {
    Serial.println("OPEN s | REPORT min max delta | POLL | POLLALL s | INFO | RESET | DEBUG");
  } else if (!strcasecmp(tok, "INFO")) {
    printInfo();
  } else if (!strcasecmp(tok, "OPEN")) {
    tok = strtok(NULL, " \t");
    unsigned s = tok ? atoi(tok) : OPEN_ON_BOOT;
    Zigbee.openNetwork(s > 254 ? 254 : s);
    Serial.printf("ZB OPEN %us\r\n", s > 254 ? 254 : s);
  } else if (!strcasecmp(tok, "REPORT")) {
    char *p1 = strtok(NULL, " \t"), *p2 = strtok(NULL, " \t"), *p3 = strtok(NULL, " \t");
    if (!p1 || !p2 || !p3) Serial.println("ERR use: REPORT min s max s delta");
    else {
      repMinS = atoi(p1);
      repMaxS = atoi(p2);
      repDeltaT = atof(p3);
      repDeltaH = repDeltaT * 2;
      devCfgN = 0;  // reconfigure all bound sensors on the next pass
      Serial.printf("ZB REPORT %us %us %.1f\r\n", repMinS, repMaxS, repDeltaT);
    }
  } else if (!strcasecmp(tok, "POLL")) {
    for (auto d : zbThermostat.getBoundDevices()) pollDevice(d);
    Serial.println("ZB POLL");
  } else if (!strcasecmp(tok, "POLLALL")) {
    tok = strtok(NULL, " \t");
    if (!tok) Serial.printf("ZB POLLALL %us\r\n", POLL_ALL_S);
    else {
      pollAllCfgS = atoi(tok);
      Serial.printf("ZB POLLALL %us\r\n", pollAllCfgS);
    }
  } else if (!strcasecmp(tok, "RESET")) {
    Serial.println("ZB RESET - factory reset, rebooting");
    delay(100);
    Zigbee.factoryReset(true);
  } else if (!strcasecmp(tok, "DEBUG")) {
    debugOn = !debugOn;
    esp_log_level_set("*", debugOn ? ESP_LOG_DEBUG : ESP_LOG_WARN);
    Serial.printf("ZB LOG %s\r\n", debugOn ? "DEBUG" : "WARN");
  } else {
    Serial.println("ERR unknown command, HELP for list");
  }
}

/***************************** Arduino functions *****************************/
void setup() {
  Serial.begin(115200);
  esp_log_level_set("*", ESP_LOG_WARN);  // keep the JSON lines clean of stack logs

  zbThermostat.onTempReceiveWithSource(onTemp);
  zbThermostat.onHumidityReceiveWithSource(onHum);
  zbThermostat.allowMultipleBinding(true);
  Zigbee.allowMultiEndpointBinding(true);
  zbThermostat.setManufacturerAndModel("DSP", "ZBSensorGateway");
  Zigbee.addEndpoint(&zbThermostat);
  Zigbee.setRebootOpenNetwork(OPEN_ON_BOOT);

  Serial.println("ZB GW starting (coordinator)...");
  if (!Zigbee.begin(ZIGBEE_COORDINATOR)) {
    Serial.println("Zigbee failed to start, rebooting");
    ESP.restart();
  }
  Serial.printf("ZB GW ready PAN 0x%04x CH %u, network open %us, HELP for commands\r\n", esp_zb_get_pan_id(), esp_zb_get_current_channel(), OPEN_ON_BOOT);
}

void loop() {
  static char lineBuf[96];
  static size_t linePos = 0;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (linePos) {
        lineBuf[linePos] = 0;
        handleLine(lineBuf);
        linePos = 0;
      }
    } else if (linePos < sizeof(lineBuf) - 1) lineBuf[linePos++] = c;
  }

  static uint32_t lastCfg = 0, lastOpen = 0, lastPollAll = 0;
  uint32_t now = millis();
  if (now - lastCfg >= 5000) {
    lastCfg = now;
    maintain();
  }
  if (pollAllCfgS > 0 && now - lastPollAll >= pollAllCfgS * 1000UL) {
    lastPollAll = now;
    for (auto d : zbThermostat.getBoundDevices()) pollDevice(d);
  }
#if OPEN_REPEAT_S > 0
  if (now - lastOpen >= (uint32_t)OPEN_REPEAT_S * 1000) {
    lastOpen = now;
    if (Zigbee.connected()) Zigbee.openNetwork(OPEN_ON_BOOT);
  }
#endif
}
