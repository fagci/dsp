"""Справочники smittix/intercept (Apache-2.0) → data/*.json приложения.
Запуск:  python3 -I tools/intercept/build.py <каталог intercept/data> <куда писать (data/)>
signals.json и wefax_stations.json копируются как есть; patterns.py и tscm_frequencies.py разбираются через ast (код не выполняется)
в data/intercept-ids.json: {tscm, ssid, mac, ble} — плоские строки для Table (modules/lookup-kernels.js, luParseIds).
routes/spy_stations.py (список STATIONS: number stations и дипломатические сети, по priyom.org) → data/intercept-spy.json (по строке на частоту)."""
import ast, json, shutil, sys, os

src, dst = sys.argv[1], sys.argv[2]

def consts(path):
    out = {}
    for node in ast.parse(open(path, encoding='utf-8').read()).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try: out[node.targets[0].id] = ast.literal_eval(node.value)
            except Exception: pass
    return out

pat = consts(os.path.join(src, 'patterns.py'))
tscm = consts(os.path.join(src, 'tscm_frequencies.py'))

mhz = lambda v: int(round(float(v) * 1e6))
rows_tscm = [{'group': g, 'name': b['name'], 'lo': mhz(b['start']), 'hi': mhz(b['end']), 'risk': b.get('risk', '')}
             for g, bands in tscm['SURVEILLANCE_FREQUENCIES'].items() for b in bands]

ssid, seen = [], set()
def add_ssid(p, kind, vendor=''):
    if (p.lower(), kind) not in seen:
        seen.add((p.lower(), kind)); ssid.append({'pattern': p, 'kind': kind, 'vendor': vendor})
for p in pat['DRONE_SSID_PATTERNS']: add_ssid(p, 'drone')
for p in tscm['WIFI_CAMERA_PATTERNS']['ssid_patterns']: add_ssid(p, 'camera')

mac, seenm = [], set()
def add_mac(p, vendor, kind):
    if p.upper() not in seenm:                      # дубли (например, A0:14:3D у DJI и Parrot) — первая запись
        seenm.add(p.upper()); mac.append({'prefix': p.upper(), 'vendor': vendor, 'kind': kind})
for p, v in pat['DRONE_OUI_PREFIXES'].items(): add_mac(p, v, 'drone')
for p, v in tscm['WIFI_CAMERA_PATTERNS']['mac_prefixes'].items(): add_mac(p, v, 'camera')
for p in pat['AIRTAG_PREFIXES']: add_mac(p, 'Apple (AirTag / Continuity)', 'tracker')
for p in pat['TILE_PREFIXES']: add_mac(p, 'Tile', 'tracker')
for p in pat['SAMSUNG_TRACKER']: add_mac(p, 'Samsung (SmartTag)', 'tracker')
for k, s in tscm['BLE_TRACKER_SIGNATURES'].items():
    for p in s.get('oui_prefixes', []): add_mac(p, s['name'], 'tracker')

ble = [{'company': s['company_id'] if s.get('company_id') is not None else '', 'name': s['name'], 'risk': s.get('risk', ''),
        'patterns': ', '.join(s.get('patterns', [])), 'description': s.get('description', '')}
       for s in tscm['BLE_TRACKER_SIGNATURES'].values()]

json.dump({'tscm': rows_tscm, 'ssid': ssid, 'mac': mac, 'ble': ble}, open(os.path.join(dst, 'intercept-ids.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, separators=(',', ':'))
shutil.copyfile(os.path.join(src, 'signals.json'), os.path.join(dst, 'intercept-signals.json'))
shutil.copyfile(os.path.join(src, 'wefax_stations.json'), os.path.join(dst, 'intercept-wefax.json'))
print(len(rows_tscm), 'tscm,', len(ssid), 'ssid,', len(mac), 'mac,', len(ble), 'ble')

spy = None
for node in ast.parse(open(os.path.join(src, '..', 'routes', 'spy_stations.py'), encoding='utf-8').read()).body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], 'id', '') == 'STATIONS': spy = ast.literal_eval(node.value)
rows_spy = [{'name': s['name'], 'nickname': s.get('nickname', ''), 'type': s.get('type', ''), 'country': s.get('country', ''),
             'hz': int(round(f['freq_khz'] * 1000)), 'primary': 1 if f.get('primary') else 0, 'mode': s.get('mode', ''),
             'operator': s.get('operator', ''), 'schedule': s.get('schedule', ''), 'description': s.get('description', ''), 'url': s.get('source_url', '')}
            for s in spy for f in s['frequencies']]
json.dump(rows_spy, open(os.path.join(dst, 'intercept-spy.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(rows_spy), 'spy frequencies')
