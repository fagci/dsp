package app.dsp.phone

/**
 * Дополнительные окна приложения: каждое — свой процесс со своим WebView и хранилищем (патчи, настройки), поэтому в них можно
 * держать запущенными разные патчи одновременно. Датчики и радио остаются в одном сервисе моста, окна подключаются к нему по ws.
 * Живые обои и PiP работают только из основного окна.
 */
class Slot1Activity : MainActivity() { override val slot = "s1" }
class Slot2Activity : MainActivity() { override val slot = "s2" }
class Slot3Activity : MainActivity() { override val slot = "s3" }
