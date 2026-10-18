#!/data/data/com.termux/files/usr/bin/bash
# Wi-Fi скан + координаты телефона → одна строка JSON на цикл (для узла Text over Network).
#
# Установка (Termux + приложение Termux:API из F-Droid, разрешение на геолокацию):
#   pkg install termux-api jq websocat          (для root-режима ещё: pkg install iw)
# Запуск (браузер на этом же телефоне подключается к ws://127.0.0.1:8765):
#   websocat -t ws-l:127.0.0.1:8765 sh-c:'bash wifi-scan.sh'
# С другого устройства в сети — ws-l:0.0.0.0:8765 и адрес телефона (с https-страницы нужен wss).
#
# Первая запись — «я» (id=me), дальше точки доступа с координатами места замера.
# Два источника сканов (MODE):
#   api  termux-wifi-scaninfo. Android отдаёт кэш: в нём копятся записи старых сканов, а при
#        выключенном экране новый скан может не запускаться вовсе. Берём только записи
#        последнего скана (timestamp рядом с максимальным) и шлём цикл лишь когда скан новый,
#        иначе одни и те же RSSI уйдут с другими координатами. age_s — возраст этого скана, с.
#        Android 9+ ограничивает частоту сканов (~4 за 2 мин); в «Для разработчиков» можно
#        выключить «Ограничение поиска сетей Wi-Fi», экран настроек Wi-Fi тоже учащает сканы.
#   iw   root: `iw dev wlan0 scan` сам запускает свежий скан каждый цикл, age_s — «last seen».
#   auto iw, если есть root (sudo или su) и iw, иначе api.

PERIOD=${PERIOD:-5}        # секунд между циклами
PROVIDER=${PROVIDER:-gps}  # gps | network
MODE=${MODE:-auto}         # auto | api | iw
IFACE=${IFACE:-wlan0}
MAXAGE=${MAXAGE:-15}       # iw: отбрасывать записи старше, с
PREFIX=${PREFIX:-/data/data/com.termux/files/usr}

# su не наследует окружение Termux — задаём библиотеки явно
rootrun() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null; then sudo -n "$@"
  else su -c "LD_LIBRARY_PATH=$PREFIX/lib $*"
  fi
}

iwscan() {
  rootrun "$(command -v iw || echo "$PREFIX/bin/iw")" dev "$IFACE" scan 2>/dev/null | awk '
    function flush() { if (mac != "" && sig != "") printf "%s\t%s\t%s\t%s\t%s\n", mac, freq, sig, seen, ssid }
    /^BSS /       { flush(); mac=$2; sub(/\(.*/, "", mac); freq=""; sig=""; seen=0; ssid=""; next }
    /^\tfreq:/    { freq=int($2); next }
    /^\tsignal:/  { sig=$2; next }
    /^\tlast seen:.* ms ago/ { seen=$3; next }
    /^\tSSID:/    { sub(/^\tSSID: ?/, ""); ssid=$0; next }
    END           { flush() }' |
  jq -Rsc --argjson max "$MAXAGE" '
    [ split("\n")[] | select(length > 0) | split("\t")
      | {bssid:.[0], ssid:.[4], rssi:(.[2]|tonumber|floor), freq:(.[1]|tonumber? // null),
         age_s:((.[3]|tonumber)/1000|floor)}
      | select(.age_s <= $max) ]'
}

if [ "$MODE" = auto ]; then
  if (command -v iw >/dev/null || [ -x "$PREFIX/bin/iw" ]) && rootrun true 2>/dev/null; then MODE=iw; else MODE=api; fi
  echo "wifi-scan: MODE=$MODE" >&2
fi

last=
while :; do
  aps=; mx=
  if [ "$MODE" = iw ]; then
    aps=$(iwscan)
  else
    scan=$(termux-wifi-scaninfo 2>/dev/null)
    mx=$(printf '%s' "$scan" | jq -r '[.[].timestamp // empty] | max // empty' 2>/dev/null)
    if [ -n "$mx" ] && [ "$mx" != "$last" ]; then
      up=$(cut -d' ' -f1 /proc/uptime)
      aps=$(printf '%s' "$scan" | jq -c --argjson up "$up" --argjson mx "$mx" '
        [ .[] | select(.timestamp != null and .timestamp >= $mx - 5000000)
              | {bssid, ssid, rssi, freq:.frequency_mhz, age_s:(($up - $mx/1e6)|floor)} ]')
    fi
  fi
  if [ -n "$aps" ] && [ "$aps" != "[]" ]; then
    loc=$(termux-location -p "$PROVIDER" -r last 2>/dev/null)
    [ -z "$loc" ] && loc='{}'
    jq -nc --argjson loc "$loc" --argjson aps "$aps" '
      if ($loc.latitude == null) then empty else
        [ {id:"me", icon:"me", lat:$loc.latitude, lon:$loc.longitude, acc:$loc.accuracy} ] +
        [ $aps[] | . + {lat:$loc.latitude, lon:$loc.longitude, acc:$loc.accuracy} ]
      end' && [ -n "$mx" ] && last=$mx
  fi
  sleep "$PERIOD"
done
