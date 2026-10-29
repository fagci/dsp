# Wires and port types

A wire connects an **output** pin (right side of a module) to an **input** pin (left side). Drag from one to the other; on a touch screen tap the first pin and then the second. Hover a pin: the tooltip shows its name, type and a short description.

## Which pins connect
- The same **type** — always.
- **val** is a universal type — it connects to anything.
- **iq ↔ sig** connect through an automatic adapter (a small dot module is added).
- Anything else is refused.

The pin colour tells the type. The main ones:

| Type | What it carries |
|---|---|
| `sig` | a stream of samples, usually audio or a demodulated signal |
| `iq` | complex I/Q samples (from SDRs, for demodulators) |
| `num` | a number — a control value, a level, a frequency |
| `spec` | a spectrum (the result of an FFT) |
| `txt` | text |
| `rec` | records — objects such as `{src, rssi, lat, lon}` from decoders and sensors |
| `bands` | a set of table rows (Table `rows`, scan results) |
| `img`, `vid` | a picture, a video frame |
| `blk` | a block of samples |
| `bin` | bytes |
| `val` | anything |

Other types (`rtc`, `trk`, `song`) belong to specific module families (real-time connections, tracker and studio music).

## Several wires into one pin
Inputs of type `rec` and `bands` accept **many wires**: the values arrive as one list in the order of the wires.

## Wire bundles
Wires leaving or entering one module are tied into a harness; the **bundle** button in the toolbar switches this off.

## Picking a pin target
Double-click a pin to open a picker of modules that can be attached to this pin.
