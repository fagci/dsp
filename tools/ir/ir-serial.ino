// Мост «ИК ↔ последовательный порт» для IR Serial (WebSerial), режим «sketch (tools/ir)».
// Библиотека IRremote 4.x (Arduino IDE → Library Manager), платы AVR / ESP32 / ESP8266 / RP2040.
// В устройство:  TX <Гц> <мкс> <мкс> …\n     Из устройства:  RX <мкс> <мкс> …\n   (метка, пауза, метка, …)
#include <IRremote.hpp>

const uint8_t PIN_RX = 2;                  // выход ИК-приёмника (TSOP / VS1838)
const uint8_t PIN_TX = 3;                  // ИК-светодиод через транзистор
const uint16_t MAX_PULSES = 250;           // на AVR с 2 КБ ОЗУ — не больше ~200
const uint16_t LINE_MAX = 1400;

static char line[LINE_MAX];
static uint16_t len = 0;
static uint16_t pulses[MAX_PULSES];

void sendLine() {
  line[len] = 0;
  if (strncmp(line, "TX ", 3) != 0) return;
  char *p = line + 3;
  uint32_t hz = strtoul(p, &p, 10);
  uint16_t n = 0;
  while (*p && n < MAX_PULSES) {
    uint32_t v = strtoul(p, &p, 10);
    if (v == 0) break;
    pulses[n++] = v > 65535 ? 65535 : v;
  }
  if (n < 2) return;
  IrSender.sendRaw(pulses, n, (hz + 500) / 1000);
}

void setup() {
  Serial.begin(115200);
  IrReceiver.begin(PIN_RX, DISABLE_LED_FEEDBACK);
  IrSender.begin(PIN_TX);
}

void loop() {
  if (IrReceiver.decode()) {
    auto *r = IrReceiver.decodedIRData.rawDataPtr;
    if (r->rawlen > 3) {
      Serial.print(F("RX"));
      for (uint16_t i = 1; i < r->rawlen; i++) {
        Serial.print(' ');
        Serial.print((uint32_t)r->rawbuf[i] * MICROS_PER_TICK);
      }
      Serial.println();
    }
    IrReceiver.resume();
  }
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { sendLine(); len = 0; }
    else if (c != '\r' && len < LINE_MAX - 1) line[len++] = c;
  }
}
