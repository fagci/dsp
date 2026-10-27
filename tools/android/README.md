# DSP for Android: sensors and camera with the screen locked

A thin Android app around the DSP workbench. A browser tab is frozen as soon as the screen locks (camera, sensors and timers stop),
so the app runs a **foreground service** that owns the hardware and serves it on a local port. The page connects to it and gets
sensors up to 200 Hz, GPS, Wi-Fi scans, battery and camera frames.

- **App** (`MainActivity`): the whole workbench from `assets/www` in a WebView (works offline), asks for Camera / Location, starts the service. Blob downloads go to *Downloads*, file inputs open the system picker.
- **Service** (`BridgeService`): notification with *Settings* / *Stop*, partial wake lock while something is requested. Sources start only when a client subscribes.
- **Server** (`BridgeServer`, one port, default `127.0.0.1:8765`):
  - `ws://host:8765/?token=…` — the protocol of [`tools/termux/bridge.mjs`](../termux/bridge.mjs): send `{"sub":["accel","gyro","gps","wifi","battery",…],"hz":200}`, get JSON records (arrays of them, one batch per ~40 ms). Sensor records are `{src:'sensor', sensor, t, x, y, z}` with `t` in ms (the time of the measurement, not of the delivery). Sensors: `accel gyro mag light pressure proximity gravity linear rotation`.
  - `http://host:8765/camera.mjpg?cam=back|front&w=640&fps=10&q=70&rot=0` — MJPEG (Camera2, YUV → JPEG, turned upright). `/snapshot.jpg` — one frame. `/status` — text.
- **In the workbench:** the *Phone sensors (Termux / DSP app)* node — *sensor rate*, *camera stream*; its `cam` output is the stream address, wire it to *IP Camera* `url`. Preset *Phone App: Camera, Sensors and Wi-Fi in the Background*.

## Security

The camera and the position are behind a local port, so:

- only `127.0.0.1` is open by default; other devices need *Settings → Allow other devices* and the token (`?token=…`);
- browsers are let in by `Origin`: the app itself, `localhost` and `https://fagci.github.io` (more in *Settings*); other sites get 403. Programs without an `Origin` (curl, websocat, other apps on the phone) get through on `127.0.0.1` unless *Require the token on this phone too* is on;
- a public https page talks to the phone's loopback with Private Network Access headers; Chrome may ask for the *local network* permission.

## Build

No Android SDK in the dev container, so the APK is built by GitHub Actions (`.github/workflows/android.yml`, artifact `dsp-android-debug`).
Locally: JDK 17, Android SDK (platform 35), Gradle 8.10+ → `gradle -p tools/android :app:assembleDebug`. The web files are copied from the repository root by the `copyWeb` task, so the app is always the current workbench.

## Checks

`cd tools/android/jvm-test && gradle runTests` — the server (handshake, masking, long frames, batching, `Origin`, preflight with Private Network Access, token) against a real WebSocket / HTTP client, and the frame rotation, on a plain JVM against the Android 14 classes (`org.robolectric:android-all`). The JS side: `node tools/test-termux.mjs`.

**Not checked on a phone:** Camera2, sensors, Wi-Fi scans, the foreground service and the WebView were compiled against the Android 14 API and nothing more. Try the camera with the screen locked on your device before relying on it.

## Limits

- Android WebView has no WebUSB, WebSerial, WebBluetooth, WebHID or File System Access. For an SDR / serial device open the workbench in Chrome and keep the app only as the bridge (`ws://127.0.0.1:8765`).
- The page itself is throttled by Android with the screen off (WebView and Chrome alike). The service keeps capturing and serving; to *process* while the phone is locked, open the workbench on another device (*Allow other devices* → `ws://PHONE_IP:8765/?token=…`).
- The camera needs the permission granted and the service started while the app is on screen (Android rule for foreground services of the camera type). Open the app once after boot, then lock the screen.
- Wi-Fi scans are rate-limited by Android (a few per two minutes; *Developer options → Wi-Fi scan throttling* lifts it) and need Location on.
- Another app (the system camera) can take the camera away; the stream then ends and the node reconnects.
