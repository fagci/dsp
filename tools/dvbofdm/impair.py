#!/usr/bin/env python3
"""Channel impairments for receiver tests: impair.py in.cfile out.cfile [snr=dB] [cfo=Hz] [ppm=P] [echo=delay:gain:phaseDeg ...] [fs=Hz] [max=samples]
   echo - a copy of the signal delayed by `delay` samples (negative: an early echo), cfo - carrier offset, ppm - sampling clock
   error of the receiver (windowed sinc resampling), snr - added white noise relative to the mean signal power."""
import sys, numpy as np

src, dst = sys.argv[1:3]
opt = {}
echoes = []
for a in sys.argv[3:]:
    k, v = a.split('=', 1)
    if k == 'echo': echoes.append(tuple(float(t) for t in v.split(':')))
    else: opt[k] = float(v)
fs = opt.get('fs', 64e6 / 7)
x = np.fromfile(src, dtype=np.complex64, count=int(opt['max']) if 'max' in opt else -1).astype(np.complex128)
n = len(x)
if echoes:
    y = x.copy()
    for d, g, ph in echoes:
        d = int(d)
        e = np.zeros_like(x)
        if d >= 0: e[d:] = x[:n - d]
        else: e[:n + d] = x[-d:]
        y += g * np.exp(1j * np.deg2rad(ph)) * e
    x = y
ppm = opt.get('ppm', 0.0)
if ppm:
    # output sample k is the input at time k*(1+ppm*1e-6): 16-tap windowed sinc
    m = int(n / (1 + ppm * 1e-6)) - 16
    t = np.arange(m) * (1 + ppm * 1e-6)
    i0 = np.floor(t).astype(np.int64); fr = t - i0
    out = np.zeros(m, dtype=np.complex128)
    for k in range(-7, 9):
        d = k - fr
        h = np.sinc(d) * (0.5 + 0.5 * np.cos(np.pi * d / 9.0))
        idx = np.clip(i0 + k, 0, n - 1)
        out += h * x[idx]
    x = out; n = m
cfo = opt.get('cfo', 0.0)
if cfo:
    x = x * np.exp(2j * np.pi * cfo / fs * np.arange(n))
if 'snr' in opt:
    p = np.mean(np.abs(x) ** 2)
    sig = np.sqrt(p / 10 ** (opt['snr'] / 10) / 2)
    rng = np.random.default_rng(1)
    x = x + sig * (rng.standard_normal(n) + 1j * rng.standard_normal(n))
x.astype(np.complex64).tofile(dst)
print('wrote', dst, n)
