#!/usr/bin/env python3
"""Builds modules/cxd-sequences.js: the I2C sequences of the Sony CXD2837ER driver of the Linux kernel (drivers/media/dvb-frontends/cxd2841er.c,
GPL-2.0-or-later, Copyright 2012 Sony Corporation, 2014 NetUP Inc.), recorded by running the kernel functions themselves.

usage: python3 tools/cxd-gen/gen.py /path/to/cxd2841er.c

The functions are cut out of the kernel file unchanged and compiled with gcc against stubs (shim.h): the register helpers record what they would send
instead of using I2C. The state at the start of each scenario and the configuration are the ones of the Astrometa DVB-T2 stick (rtl28xxu.c: xtal 20.5 MHz,
flags AUTO_IFHZ | NO_AGCNEG | TSBITS | EARLY_TUNE | TS_SERIAL; the R828D tuner gives IF 3.57 MHz at 6 MHz and below, 4.57 MHz at 7 / 8 MHz, 5.07 MHz for DVB-C).
Output ops: ["w", slave, reg, [bytes]] write, ["m", slave, reg, value, mask] read-modify-write, ["s", ms] pause, ["t"] program the tuner."""
import re, subprocess, sys, os, json, tempfile
src = open(sys.argv[1]).read()
here = os.path.dirname(os.path.abspath(__file__))

def func(name):
    m = re.search(r'^(static [^;{]*?\b' + name + r'\s*\([^;{]*\)\s*\{.*?^\})', src, re.S | re.M)
    if not m: raise SystemExit('function not found: ' + name)
    return m.group(1)

names = ['cxd2841er_calc_iffreq_xtal', 'cxd2841er_calc_iffreq', 'cxd2841er_get_if_hz', 'cxd2841er_tuner_set',
         'cxd2841er_dvbt2_set_profile', 'cxd2841er_dvbt2_set_plp_config',
         'cxd2841er_sleep_tc_to_active_t2_band', 'cxd2841er_sleep_tc_to_active_t_band', 'cxd2841er_sleep_tc_to_active_c_band',
         'cxd2841er_sleep_tc_to_active_t', 'cxd2841er_sleep_tc_to_active_t2', 'cxd2841er_sleep_tc_to_active_c',
         'cxd2841er_active_t_to_sleep_tc', 'cxd2841er_active_t2_to_sleep_tc', 'cxd2841er_active_c_to_sleep_tc',
         'cxd2841er_sleep_tc_to_shutdown', 'cxd2841er_shutdown_to_sleep_tc', 'cxd2841er_tune_done', 'cxd2841er_set_ts_clock_mode',
         'cxd2841er_retune_active', 'cxd2841er_sleep_tc', 'cxd2841er_set_frontend_tc', 'cxd2841er_init_tc']
body = '\n\n'.join(func(n) for n in names)
# set_ts_clock_mode has a forward declaration before its body; the extraction takes the body
open(os.path.join(tempfile.gettempdir(), 'cxd_body.c'), 'w').write(body)

harness = open(os.path.join(here, 'harness.c')).read().replace('/*BODY*/', body)
cpath = os.path.join(tempfile.gettempdir(), 'cxd_harness.c')
open(cpath, 'w').write(harness)
exe = os.path.join(tempfile.gettempdir(), 'cxd_harness')
subprocess.check_call(['gcc', '-O1', '-w', '-I' + here, '-o', exe, cpath])
out = subprocess.check_output([exe]).decode()
seqs = {}
cur = None
for line in out.split('\n'):
    if line.startswith('#'):
        cur = line[1:].strip(); seqs[cur] = []
    elif line.strip() and cur is not None:
        seqs[cur].append(json.loads(line))

for k in list(seqs):
    if k.startswith('switch.'):
        _, x, y, bw = k.split('.')
        want = [['t']] + seqs['sleep.' + x] + seqs['act.%s.%s' % (y, bw)][1:]
        if seqs[k] != want: raise SystemExit('switch %s is not sleep + activate (%d vs %d ops)' % (k, len(seqs[k]), len(want)))
        del seqs[k]

def fmt(op):
    if op[0] == 'w': return '["w",%d,0x%02x,[%s]]' % (op[1], op[2], ','.join('0x%02x' % b for b in op[3]))
    if op[0] == 'm': return '["m",%d,0x%02x,0x%02x,0x%02x]' % (op[1], op[2], op[3], op[4])
    if op[0] == 's': return '["s",%d]' % op[1]
    return '["t"]'
js = '''"use strict";
/* Sony CXD2837ER (DVB-T / T2 / C): I2C sequences of the Linux driver, recorded by running its functions (tools/cxd-gen/gen.py). Do not edit.
   Source: drivers/media/dvb-frontends/cxd2841er.c, GPL-2.0-or-later, Copyright 2012 Sony Corporation, Copyright (C) 2014 NetUP Inc.
   Configuration of the Astrometa DVB-T2 stick: 20.5 MHz crystal, serial TS, early tuner programming, tuner IF 3.57 / 4.57 / 5.07 MHz.
   ["w", slave, reg, [bytes]] — write; ["m", slave, reg, value, mask] — read-modify-write; ["s", ms] — pause; ["t"] — program the tuner.
   slave: 0 — SLV-X (0xdc), 1 — SLV-T (0xd8). Keys: "init", "shutdown", "sleep.<system>", "act.<system>.<MHz>", "retune.<system>.<MHz>", "ifhz.<system>.<MHz>". */
const CXD_SEQ={
'''
for k, v in seqs.items():
    if k.startswith('ifhz.'):
        js += '"%s":%s,\n' % (k, v[0][0]); continue
    js += '"%s":[\n' % k + ',\n'.join(fmt(o) for o in v) + '\n],\n'
js += '};\n'
open(os.path.join(here, '..', '..', 'modules', 'cxd-sequences.js'), 'w').write(js)
print('scenarios:', len(seqs), 'ops:', sum(len(v) for k, v in seqs.items() if not k.startswith('ifhz.')))
