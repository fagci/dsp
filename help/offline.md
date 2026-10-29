# Offline and the phone app

## Works without a network
The workbench is a PWA: after the first load the app and all its modules work offline. Install it from the browser menu if you want a window of its own.

Things that need a network by their nature (remote receivers, online catalogues, maps tiles) say so in the module status; catalogues show the last good answer marked as outdated.

## Offline data
Big files some modules need (the object-detection model, dictionaries, the base map, reference lists like MAC vendors) are downloaded once and kept in **Files → Offline data**. Press **⇩ offline** there to fetch them in advance; small ones download themselves a few seconds after the start when a network is present.

## Android app
The Android app (`tools/android` in the repository) wraps the workbench and adds a **bridge**: phone sensors, GPS, camera, Wi-Fi and Bluetooth scans, USB devices (OTG), notifications and more, available to your patches. A browser on another device can use the bridge too: in the app settings allow other devices, set a token, and connect to `ws://PHONE_IP:8765/?token=…` from the *Phone sensors* module.

- A page opened over **https** cannot connect to `ws://` on another host (mixed content). Use `adb forward tcp:8765 tcp:8765` and `ws://127.0.0.1:8765`, or open the workbench over http, or allow insecure content for the site in the browser.
- Details: `tools/android/README.md` in the repository.
