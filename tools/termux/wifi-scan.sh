#!/data/data/com.termux/files/usr/bin/bash
# Wi-Fi скан + координаты телефона → одна строка JSON на цикл (для узла Text over Network).
#
# Установка (Termux + приложение Termux:API из F-Droid, разрешение на геолокацию):
#   pkg install termux-api jq websocat
# Запуск (браузер на этом же телефоне подключается к ws://127.0.0.1:8765):
#   websocat -t ws-l:127.0.0.1:8765 sh-c:'bash wifi-scan.sh'
# С другого устройства в сети — ws-l:0.0.0.0:8765 и адрес телефона (с https-страницы нужен wss).
#
# Первая запись — «я» (id=me), дальше точки доступа с координатами места замера.
# Android отдаёт кэш: в нём накапливаются записи прошлых сканов (часы назад), а при
# выключенном экране новый скан может не запускаться вовсе. Поэтому берём только записи
# последнего скана (timestamp рядом с максимальным) и шлём цикл лишь когда скан новый,
# иначе одни и те же RSSI уйдут с другими координатами. age_s — возраст этого скана, с.
# Android 9+ ограничивает частоту сканов (~4 за 2 мин); в «Для разработчиков» можно выключить
# «Ограничение поиска сетей Wi-Fi», экран настроек Wi-Fi тоже заставляет сканировать чаще.

PERIOD=${PERIOD:-5}        # секунд между циклами
PROVIDER=${PROVIDER:-gps}  # gps | network

last=
while :; do
  scan=$(termux-wifi-scaninfo 2>/dev/null)
  mx=$(printf '%s' "$scan" | jq -r '[.[].timestamp // empty] | max // empty' 2>/dev/null)
  if [ -n "$mx" ] && [ "$mx" != "$last" ]; then
    loc=$(termux-location -p "$PROVIDER" -r last 2>/dev/null)
    [ -z "$loc" ] && loc='{}'
    up=$(cut -d' ' -f1 /proc/uptime)
    printf '%s' "$scan" | jq -c --argjson loc "$loc" --argjson up "$up" --argjson mx "$mx" '
      if ($loc.latitude == null) then empty else
        [ {id:"me", icon:"me", lat:$loc.latitude, lon:$loc.longitude, acc:$loc.accuracy} ] +
        [ .[] | select(.timestamp != null and .timestamp >= $mx - 5000000)
              | {bssid, ssid, rssi, freq:.frequency_mhz,
                 age_s:(($up - $mx/1e6)|floor),
                 lat:$loc.latitude, lon:$loc.longitude, acc:$loc.accuracy} ]
      end' && last=$mx
  fi
  sleep "$PERIOD"
done
