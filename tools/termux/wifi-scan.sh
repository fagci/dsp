#!/data/data/com.termux/files/usr/bin/bash
# Wi-Fi скан + координаты телефона → одна строка JSON на цикл (для узла Text over Network).
#
# Установка (Termux + приложение Termux:API из F-Droid, разрешение на геолокацию):
#   pkg install termux-api jq websocat
# Запуск (браузер на этом же телефоне подключается к ws://127.0.0.1:8765):
#   websocat -t ws-l:127.0.0.1:8765 sh-c:'bash wifi-scan.sh'
# С другого устройства в сети — ws-l:0.0.0.0:8765 и адрес телефона (с https-страницы нужен wss).
#
# Первая запись — «я» (id=me), дальше точки доступа с координатами места замера и возрастом
# результата age_s: Android отдаёт кэш последнего скана, старые результаты отбрасывайте.
# Android 9+ ограничивает частоту сканов (~4 за 2 мин); в «Для разработчиков» можно выключить
# «Ограничение поиска сетей Wi-Fi», экран настроек Wi-Fi тоже заставляет сканировать чаще.

PERIOD=${PERIOD:-5}        # секунд между циклами
PROVIDER=${PROVIDER:-gps}  # gps | network

while :; do
  loc=$(termux-location -p "$PROVIDER" -r last 2>/dev/null)
  [ -z "$loc" ] && loc='{}'
  up=$(cut -d' ' -f1 /proc/uptime)
  termux-wifi-scaninfo 2>/dev/null | jq -c --argjson loc "$loc" --argjson up "$up" '
    if ($loc.latitude == null) then empty else
      [ {id:"me", icon:"me", lat:$loc.latitude, lon:$loc.longitude, acc:$loc.accuracy} ] +
      [ .[] | {bssid, ssid, rssi, freq:.frequency_mhz,
               age_s:(if .timestamp then (($up - .timestamp/1e6)|floor) else null end),
               lat:$loc.latitude, lon:$loc.longitude, acc:$loc.accuracy} ]
    end'
  sleep "$PERIOD"
done
