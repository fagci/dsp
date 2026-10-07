// Мост nRF24L01+ ↔ USB-UART для модуля nRF24 рабочего стенда DSP.
// Не проверено на железе: собрано по документации библиотеки RF24 (TMRh20), сверьте пины со своей платой.
//
// Плата: Arduino Nano / Uno (ATmega328P) — nRF24L01+: CE → D9, CSN → D10, SCK → D13, MOSI → D11, MISO → D12, VCC → 3.3 В
// (модулю нужен конденсатор 10 мкФ у питания; PA+LNA-модули — отдельное питание). Библиотека: RF24 (менеджер библиотек Arduino IDE).
//
// Протокол, 115200 бод, строки с '\n':
//   PING                    → PONG nrf24-bridge 1 chip=<0|1>
//   CFG ch= rate= addr= pay= pwr= crc= ack= retry=   → OK   (ch 0…125, rate 250K|1M|2M, addr 3…5 байт hex, pay 0 — динамический)
//   TX <hex>                → TXOK | TXFAIL            (в режиме передачи)
//   RXON / RXOFF            → OK                       (приём: RX <ch> <hex> на каждый пакет)
//   SCAN <проходов>         → SCAN c0,c1,…,c125        (сколько раз на канале обнаружена несущая)
#include <SPI.h>
#include <RF24.h>

RF24 radio(9, 10);
uint8_t addr[5] = {0xE7, 0xE7, 0xE7, 0xE7, 0xE7};
uint8_t addrLen = 5, channel = 76, payload = 8;
bool receiving = false;
char line[96];
uint8_t used = 0;

static uint8_t hexNib(char c) { return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10; }

void applyCfg() {
  radio.stopListening();
  radio.setChannel(channel);
  radio.setAddressWidth(addrLen);
  radio.openWritingPipe(addr);
  radio.openReadingPipe(1, addr);
  if (payload) { radio.disableDynamicPayloads(); radio.setPayloadSize(payload); } else radio.enableDynamicPayloads();
  if (receiving) radio.startListening();
}

// значение параметра key= из строки cfg
const char* param(const char* s, const char* key) {
  const char* p = strstr(s, key);
  return p ? p + strlen(key) : nullptr;
}

void doCfg(const char* s) {
  const char* v;
  if ((v = param(s, "ch="))) channel = constrain(atoi(v), 0, 125);
  if ((v = param(s, "rate="))) radio.setDataRate(v[0] == '2' && v[1] == '5' ? RF24_250KBPS : v[0] == '2' ? RF24_2MBPS : RF24_1MBPS);
  if ((v = param(s, "addr="))) {
    uint8_t n = 0;
    while (n < 5 && isxdigit(v[2 * n]) && isxdigit(v[2 * n + 1])) { addr[n] = (hexNib(v[2 * n]) << 4) | hexNib(v[2 * n + 1]); n++; }
    if (n >= 3) addrLen = n;
  }
  if ((v = param(s, "pay="))) payload = constrain(atoi(v), 0, 32);
  if ((v = param(s, "pwr="))) radio.setPALevel(constrain(atoi(v), 0, 3));
  if ((v = param(s, "crc="))) { int c = atoi(v); if (c == 0) radio.disableCRC(); else radio.setCRCLength(c == 1 ? RF24_CRC_8 : RF24_CRC_16); }
  if ((v = param(s, "ack="))) radio.setAutoAck(atoi(v) != 0);
  if ((v = param(s, "retry="))) radio.setRetries(5, constrain(atoi(v), 0, 15));
  applyCfg();
  Serial.println(F("OK"));
}

void doTx(const char* hex) {
  uint8_t buf[32], n = 0;
  while (n < 32 && isxdigit(hex[2 * n]) && isxdigit(hex[2 * n + 1])) { buf[n] = (hexNib(hex[2 * n]) << 4) | hexNib(hex[2 * n + 1]); n++; }
  if (!n) { Serial.println(F("ERR bad hex")); return; }
  bool was = receiving;
  radio.stopListening();
  bool ok = radio.write(buf, n);
  if (was) radio.startListening();
  Serial.println(ok ? F("TXOK") : F("TXFAIL"));
}

void doScan(int passes) {
  uint8_t cnt[126] = {0};
  radio.stopListening();
  for (int p = 0; p < passes; p++)
    for (uint8_t c = 0; c < 126; c++) {
      radio.setChannel(c); radio.startListening(); delayMicroseconds(170); radio.stopListening();
      if (radio.testCarrier()) cnt[c]++;
    }
  radio.setChannel(channel);
  if (receiving) radio.startListening();
  Serial.print(F("SCAN "));
  for (uint8_t c = 0; c < 126; c++) { Serial.print(cnt[c]); if (c < 125) Serial.print(','); }
  Serial.println();
}

void handle(char* s) {
  if (!strncmp(s, "PING", 4)) { Serial.print(F("PONG nrf24-bridge 1 chip=")); Serial.println(radio.isChipConnected() ? 1 : 0); }
  else if (!strncmp(s, "CFG", 3)) doCfg(s + 3);
  else if (!strncmp(s, "TX ", 3)) doTx(s + 3);
  else if (!strncmp(s, "RXON", 4)) { receiving = true; radio.startListening(); Serial.println(F("OK")); }
  else if (!strncmp(s, "RXOFF", 5)) { receiving = false; radio.stopListening(); Serial.println(F("OK")); }
  else if (!strncmp(s, "SCAN", 4)) doScan(constrain(atoi(s + 4), 1, 100));
  else Serial.println(F("ERR unknown command"));
}

void setup() {
  Serial.begin(115200);
  radio.begin();
  radio.setDataRate(RF24_1MBPS);
  radio.setCRCLength(RF24_CRC_16);
  applyCfg();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') { if (used) { line[used] = 0; handle(line); used = 0; } }
    else if (used < sizeof(line) - 1) line[used++] = c;
  }
  if (receiving && radio.available()) {
    uint8_t buf[32], n = payload ? payload : radio.getDynamicPayloadSize();
    if (n < 1 || n > 32) { radio.flush_rx(); return; }
    radio.read(buf, n);
    Serial.print(F("RX ")); Serial.print(channel); Serial.print(' ');
    for (uint8_t i = 0; i < n; i++) { if (buf[i] < 16) Serial.print('0'); Serial.print(buf[i], HEX); }
    Serial.println();
  }
}
