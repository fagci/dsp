# PR changes

See local files at artifacts/dsp/modules/

## Constellation
- Added `iq` input pin (type iq)
- Falls back to I/Q sig pins

## iqSplit
- New node IQ → I/Q
- Same resampler as IQ → Audio
- Params: lat, gain, swap
