#!/usr/bin/env python3
"""Reference DVB-T2 signal from GNU Radio's own transmitter blocks (gr-dtv), for testing the receiver.
   python3.12 t2gen.py <gnuradio checkout> <example.grc e.g. germany-g1.grc> <in.ts> <out.cfile> [key=value ...]
   Needs GNU Radio 3.10 with gr-dtv and its python bindings (apt: gnuradio) and runs under the system python3.
   Overrides: rotation=ON|OFF  papr=OFF|ACE|TR|BOTH  fft=1K..32K  gi=1_32.. etc are not remapped: pass the GRC parameter values of
   the framemapper, e.g. rotation=ROTATION_ON cons=MOD_256QAM rate=C2_3 pilotpattern=PILOT_PP4 (keys of dtv_dvbt2_framemapper_cc);
   they are copied to every block that has a parameter of the same name."""
import sys, os, subprocess, tempfile, yaml

gr, grc, ts, out = sys.argv[1:5]
over = dict(a.split('=', 1) for a in sys.argv[5:])
d = yaml.safe_load(open(os.path.join(gr, 'gr-dtv/examples', grc)))
hw = {'soapy_custom_sink_0', 'uhd_usrp_sink_0', 'blocks_multiply_const_xx_0', 'tx_gain'}
d['blocks'] = [b for b in d['blocks'] if b['name'] not in hw]
d['connections'] = [c for c in d['connections'] if c[0] not in hw and c[2] not in hw]
alias = {'rotation': ['rotation'], 'cons': ['constellation'], 'rate': ['rate', 'rate1'], 'pilotpattern': ['pilotpattern'],
         'papr': ['paprmode1', 'paprmode2'], 'fftsize': ['fftsize', 'fftsize1', 'fftsize2'], 'guardinterval': ['guardinterval'],
         'carriermode': ['carriermode'], 'numdatasyms': ['numdatasyms'], 'fecblocks': ['fecblocks'], 'tiblocks': ['tiblocks'],
         'framesize': ['framesize', 'framesize1', 'framesize2'], 'bandwidth': ['bandwidth']}
for b in d['blocks']:
    p = b['parameters']
    if b['name'] == 'blocks_file_source_0': p.update(file=os.path.abspath(ts), repeat='False')
    if b['name'] == 'blocks_file_sink_0': p.update(file=os.path.abspath(out)); b['states']['state'] = 'enabled'
    for k, v in over.items():
        for name in alias.get(k, [k]):
            if name in p: p[name] = v
d['options']['parameters']['id'] = 't2gen'
d['options']['parameters']['generate_options'] = 'no_gui'
w = tempfile.mkdtemp()
yaml.safe_dump(d, open(os.path.join(w, 't2gen.grc'), 'w'))
env = dict(os.environ, PYTHONPATH='/usr/lib/python3/dist-packages')
subprocess.check_call([sys.executable, '/usr/bin/grcc', '-o', w, os.path.join(w, 't2gen.grc')], env=env, stdout=subprocess.DEVNULL)
subprocess.check_call([sys.executable, '-c', 'import sys; sys.path.insert(0, %r); import t2gen; t2gen.t2gen().run()' % w], env=env)
print('wrote', out, os.path.getsize(out))
