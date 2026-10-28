// Справочник UUID Bluetooth для списка Table «Reference/Bluetooth UUIDs»: node tools/bt-uuids.mjs → data/bluetooth-uuids.json
// Колонки: uuid (16 бит строчными или полный 128-битный), kind, name, fmt (как декодировать значение), scale, unit, note.
// fmt — из BLE_FORMATS (modules/ble-kernels.js) или «text» (UTF-8). Названия и номера — Bluetooth SIG Assigned Numbers.
import fs from 'node:fs';
const S=(u,n)=>[u,'service',n], C=(u,n,fmt='hex only',scale='',unit='',note='')=>[u,'characteristic',n,fmt,scale,unit,note], D=(u,n)=>[u,'descriptor',n], V=(u,k,n,fmt,scale,unit,note)=>[u,k,n,fmt||'',scale||'',unit||'',note||''];
const rows=[
S('1800','Generic Access'),S('1801','Generic Attribute'),S('1802','Immediate Alert'),S('1803','Link Loss'),S('1804','Tx Power'),S('1805','Current Time'),S('1806','Reference Time Update'),
S('1807','Next DST Change'),S('1808','Glucose'),S('1809','Health Thermometer'),S('180a','Device Information'),S('180d','Heart Rate'),S('180e','Phone Alert Status'),S('180f','Battery'),
S('1810','Blood Pressure'),S('1811','Alert Notification'),S('1812','Human Interface Device'),S('1813','Scan Parameters'),S('1814','Running Speed and Cadence'),S('1815','Automation IO'),
S('1816','Cycling Speed and Cadence'),S('1818','Cycling Power'),S('1819','Location and Navigation'),S('181a','Environmental Sensing'),S('181b','Body Composition'),S('181c','User Data'),
S('181d','Weight Scale'),S('181e','Bond Management'),S('181f','Continuous Glucose Monitoring'),S('1820','Internet Protocol Support'),S('1821','Indoor Positioning'),S('1822','Pulse Oximeter'),
S('1823','HTTP Proxy'),S('1824','Transport Discovery'),S('1825','Object Transfer'),S('1826','Fitness Machine'),S('1827','Mesh Provisioning'),S('1828','Mesh Proxy'),S('1829','Reconnection Configuration'),
S('183a','Insulin Delivery'),S('183b','Binary Sensor'),S('183c','Emergency Configuration'),S('183e','Physical Activity Monitor'),S('1843','Audio Input Control'),S('1844','Volume Control'),
S('1845','Volume Offset Control'),S('1846','Coordinated Set Identification'),S('1847','Device Time'),S('1848','Media Control'),S('1849','Generic Media Control'),S('184a','Constant Tone Extension'),
S('184b','Telephone Bearer'),S('184c','Generic Telephone Bearer'),S('184d','Microphone Control'),S('184e','Audio Stream Control'),S('184f','Broadcast Audio Scan'),S('1850','Published Audio Capabilities'),
S('1851','Basic Audio Announcement'),S('1852','Broadcast Audio Announcement'),S('1853','Common Audio'),S('1854','Hearing Access'),S('1855','Telephony and Media Audio'),S('1856','Public Broadcast Announcement'),
C('2a00','Device Name','text'),C('2a01','Appearance','uint16 LE'),C('2a02','Peripheral Privacy Flag','uint8'),C('2a03','Reconnection Address'),C('2a04','Peripheral Preferred Connection Parameters'),
C('2a05','Service Changed'),C('2a06','Alert Level','uint8','','','0 none, 1 mild, 2 high'),C('2a07','Tx Power Level','int8','','dBm'),C('2a08','Date Time'),C('2a09','Day of Week'),C('2a0a','Day Date Time'),
C('2a0c','Exact Time 256'),C('2a0d','DST Offset'),C('2a0e','Time Zone'),C('2a0f','Local Time Information'),C('2a11','Time with DST'),C('2a12','Time Accuracy'),C('2a13','Time Source'),
C('2a14','Reference Time Information'),C('2a16','Time Update Control Point'),C('2a17','Time Update State'),C('2a18','Glucose Measurement'),C('2a19','Battery Level','battery %','','%'),
C('2a1c','Temperature Measurement','temperature (°C)','','°C'),C('2a1d','Temperature Type','uint8'),C('2a1e','Intermediate Temperature','temperature (°C)','','°C'),C('2a21','Measurement Interval','uint16 LE','','s'),
C('2a22','Boot Keyboard Input Report'),C('2a23','System ID'),C('2a24','Model Number String','text'),C('2a25','Serial Number String','text'),C('2a26','Firmware Revision String','text'),
C('2a27','Hardware Revision String','text'),C('2a28','Software Revision String','text'),C('2a29','Manufacturer Name String','text'),C('2a2a','IEEE 11073-20601 Regulatory Certification Data List'),
C('2a2b','Current Time'),C('2a31','Scan Refresh'),C('2a32','Boot Keyboard Output Report'),C('2a33','Boot Mouse Input Report'),C('2a34','Glucose Measurement Context'),C('2a35','Blood Pressure Measurement'),
C('2a36','Intermediate Cuff Pressure'),C('2a37','Heart Rate Measurement','heart rate (bpm)','','bpm'),C('2a38','Body Sensor Location','uint8','','','0 other, 1 chest, 2 wrist, 3 finger, 4 hand, 5 ear lobe, 6 foot'),
C('2a39','Heart Rate Control Point','uint8','','','write 1 to reset energy expended'),C('2a3f','Alert Status'),C('2a40','Ringer Control Point'),C('2a41','Ringer Setting'),C('2a42','Alert Category ID Bit Mask'),
C('2a43','Alert Category ID'),C('2a44','Alert Notification Control Point'),C('2a45','Unread Alert Status'),C('2a46','New Alert'),C('2a47','Supported New Alert Category'),C('2a48','Supported Unread Alert Category'),
C('2a49','Blood Pressure Feature'),C('2a4a','HID Information'),C('2a4b','Report Map'),C('2a4c','HID Control Point'),C('2a4d','Report'),C('2a4e','Protocol Mode'),C('2a4f','Scan Interval Window'),
C('2a50','PnP ID'),C('2a51','Glucose Feature'),C('2a52','Record Access Control Point'),C('2a53','RSC Measurement'),C('2a54','RSC Feature'),C('2a55','SC Control Point'),C('2a56','Digital'),C('2a58','Analog'),
C('2a5a','Aggregate'),C('2a5b','CSC Measurement'),C('2a5c','CSC Feature'),C('2a5d','Sensor Location','uint8'),C('2a5e','PLX Spot-Check Measurement'),C('2a5f','PLX Continuous Measurement'),C('2a60','PLX Features'),
C('2a63','Cycling Power Measurement'),C('2a64','Cycling Power Vector'),C('2a65','Cycling Power Feature'),C('2a66','Cycling Power Control Point'),C('2a67','Location and Speed'),C('2a68','Navigation'),
C('2a69','Position Quality'),C('2a6a','LN Feature'),C('2a6b','LN Control Point'),C('2a6c','Elevation'),C('2a6d','Pressure','uint32 LE','0.001','hPa','0.1 Pa units'),
C('2a6e','Temperature','int16 LE','0.01','°C'),C('2a6f','Humidity','uint16 LE','0.01','%'),C('2a76','UV Index','uint8'),C('2a77','Irradiance','uint16 LE','0.1','W/m²'),
C('2add','Mesh Proxy Data In'),C('2ade','Mesh Proxy Data Out'),C('2adb','Mesh Provisioning Data In'),C('2adc','Mesh Provisioning Data Out'),
D('2900','Characteristic Extended Properties'),D('2901','Characteristic User Description'),D('2902','Client Characteristic Configuration'),D('2903','Server Characteristic Configuration'),
D('2904','Characteristic Presentation Format'),D('2905','Characteristic Aggregate Format'),D('2906','Valid Range'),D('2907','External Report Reference'),D('2908','Report Reference'),
D('2909','Number of Digitals'),D('290a','Value Trigger Setting'),D('290b','Environmental Sensing Configuration'),D('290c','Environmental Sensing Measurement'),D('290d','Environmental Sensing Trigger Setting'),D('290e','Time Trigger Setting'),
// 16-битные UUID производителей (Member Service UUIDs)
V('fe95','vendor','Xiaomi Inc. (Mi Home / sensors)'),V('feaa','vendor','Google Eddystone beacon'),V('fd6f','vendor','Exposure Notification (Apple / Google)'),V('fd84','vendor','Tile'),V('fe2c','vendor','Google Fast Pair'),
V('fe59','vendor','Nordic Semiconductor (Secure DFU)'),V('fee0','vendor','Anhui Huami (Mi Band, Amazfit)'),V('febe','vendor','Bose'),V('fe9f','vendor','Google'),V('fef3','vendor','Google'),
V('fe07','vendor','Sonos'),V('fd5a','vendor','Samsung Electronics (SmartTag)'),V('fee7','vendor','Tencent (WeChat)'),
// 128-битные
V('6e400001-b5a3-f393-e0a9-e50e24dcca9e','service','Nordic UART Service (NUS)'),V('6e400002-b5a3-f393-e0a9-e50e24dcca9e','characteristic','Nordic UART RX (write to the device)','text'),
V('6e400003-b5a3-f393-e0a9-e50e24dcca9e','characteristic','Nordic UART TX (notifications from the device)','text'),
V('ffe0','service','HM-10 / JDY serial module (FFE0)'),V('ffe1','characteristic','HM-10 / JDY serial data (FFE1)','text'),
V('00001530-1212-efde-1523-785feabcd123','service','Nordic Legacy DFU'),V('8ec90001-f315-4f60-9fb8-838830daea50','service','Nordic Secure DFU (buttonless)'),
V('fb005c80-02e7-f387-1cad-8acd2d8df0c8','service','Polar Measurement Data (PMD)'),V('fb005c81-02e7-f387-1cad-8acd2d8df0c8','characteristic','Polar PMD control point'),V('fb005c82-02e7-f387-1cad-8acd2d8df0c8','characteristic','Polar PMD data'),
V('00001623-1212-efde-1623-785feabcd123','service','LEGO Wireless Protocol hub'),V('00001624-1212-efde-1623-785feabcd123','characteristic','LEGO Wireless Protocol data'),
V('f000aa00-0451-4000-b000-000000000000','service','TI SensorTag IR temperature'),V('f000aa20-0451-4000-b000-000000000000','service','TI SensorTag humidity'),
V('f000aa40-0451-4000-b000-000000000000','service','TI SensorTag barometer'),V('f000aa80-0451-4000-b000-000000000000','service','TI SensorTag movement (IMU)'),
V('f47b5e2d-4a9e-4c5a-9b3f-8e1d2c3a4b5c','service','bitchat BLE mesh chat (mainnet)'),V('f47b5e2d-4a9e-4c5a-9b3f-8e1d2c3a4b5a','service','bitchat BLE mesh chat (debug build)'),
V('a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d','characteristic','bitchat BLE mesh chat (read/write/notify)'),
];
const cols=['uuid','kind','name','fmt','scale','unit','note'];
const out=rows.map(r=>Object.fromEntries(cols.map((c,i)=>[c,r[i]??''])));
const seen=new Set(); for(const r of out){ if(seen.has(r.uuid)) throw new Error('duplicate '+r.uuid); seen.add(r.uuid); }
fs.writeFileSync(new URL('../data/bluetooth-uuids.json',import.meta.url),JSON.stringify({source:'Bluetooth SIG Assigned Numbers (selection) + common vendor UUIDs',cols,rows:out}));
console.log(out.length+' UUIDs');
