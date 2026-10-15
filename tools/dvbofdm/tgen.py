#!/usr/bin/env python3
"""Reference DVB-T signal from GNU Radio's transmitter blocks (gr-dtv), for testing the receiver.
   python3.12 tgen.py <gnuradio checkout> <in.ts> <out.cfile> [mode=2k|8k] [gi=1/32|1/16|1/8|1/4] [cons=qpsk|16qam|64qam] [rate=1/2|2/3|3/4|5/6|7/8]
   Sample rate of the output is 8 MHz * 8 / 7. Hierarchy off."""
import sys, os, subprocess, tempfile, yaml

gr, ts, out = sys.argv[1:4]
o = dict(a.split('=', 1) for a in sys.argv[4:])
mode = o.get('mode', '8k'); gi = o.get('gi', '1/32'); cons = o.get('cons', '64qam'); rate = o.get('rate', '2/3')
d = yaml.safe_load(open(os.path.join(gr, 'gr-dtv/examples/dvbt_tx_%s.grc' % mode)))
hw = {'soapy_custom_sink_0', 'uhd_usrp_sink_0', 'tx_gain'}
d['blocks'] = [b for b in d['blocks'] if b['name'] not in hw]
d['connections'] = [c for c in d['connections'] if c[0] not in hw and c[2] not in hw]
N = 2048 if mode == '2k' else 8192
cp = int(N * eval(gi.replace('/', '.0/')) ) if False else N * int(gi.split('/')[0]) // int(gi.split('/')[1])
cr = {'1/2': 'C1_2', '2/3': 'C2_3', '3/4': 'C3_4', '5/6': 'C5_6', '7/8': 'C7_8'}[rate]
gik = {'1/32': 'GI_1_32', '1/16': 'GI_1_16', '1/8': 'GI_1_8', '1/4': 'GI_1_4'}[gi]
for b in d['blocks']:
    p = b['parameters']
    if b['name'] == 'blocks_file_source_0': p.update(file=os.path.abspath(ts), repeat='False')
    if b['id'] == 'digital_ofdm_cyclic_prefixer': p['cp_len'] = str(cp)
    if 'constellation' in p: p['constellation'] = cons
    if 'code_rate' in p: p['code_rate'] = cr
    if 'code_rate_hp' in p: p['code_rate_hp'] = cr; p['code_rate_lp'] = cr
    if 'guard_interval' in p: p['guard_interval'] = gik
d['blocks'].append({'name': 'blocks_file_sink_0', 'id': 'blocks_file_sink', 'parameters': {'file': os.path.abspath(out), 'type': 'complex', 'vlen': '1', 'append': 'False', 'unbuffered': 'False'}, 'states': {'state': 'enabled'}})
d['connections'].append(['digital_ofdm_cyclic_prefixer_0', '0', 'blocks_file_sink_0', '0'])
d['options']['parameters']['id'] = 'tgen'
d['options']['parameters']['generate_options'] = 'no_gui'
w = tempfile.mkdtemp()
yaml.safe_dump(d, open(os.path.join(w, 'tgen.grc'), 'w'))
env = dict(os.environ, PYTHONPATH='/usr/lib/python3/dist-packages')
subprocess.check_call([sys.executable, '/usr/bin/grcc', '-o', w, os.path.join(w, 'tgen.grc')], env=env, stdout=subprocess.DEVNULL)
subprocess.check_call([sys.executable, '-c', 'import sys; sys.path.insert(0, %r); import tgen; tgen.tgen().run()' % w], env=env)
print('wrote', out, os.path.getsize(out))
