# Партнёр для tools/test-rns.mjs: настоящий Reticulum + LXMF (reference-реализация), команды и события — JSON-строками.
#   python peer.py <каталог конфигурации> <имя>
import sys, os, json, time, threading
import RNS, LXMF

cfgdir, name = sys.argv[1], sys.argv[2]
def out(o): print(json.dumps(o), flush=True)

RNS.Reticulum(cfgdir, loglevel=RNS.LOG_ERROR)
ident = RNS.Identity()
router = LXMF.LXMRouter(storagepath=os.path.join(cfgdir, 'lxmf'), autopeer=False)
me = router.register_delivery_identity(ident, display_name=name)

def on_msg(m):
    out({'ev': 'msg', 'text': m.content_as_string(), 'title': m.title_as_string(), 'from': RNS.hexrep(m.source_hash, delimit=False),
         'verified': bool(m.signature_validated), 'method': m.method})
router.register_delivery_callback(on_msg)

def announce(): router.announce(me.hash)
announce()
out({'ev': 'ready', 'hash': RNS.hexrep(me.hash, delimit=False)})

def send(to_hex, text, method):
    to = bytes.fromhex(to_hex)
    idn = RNS.Identity.recall(to)
    if idn is None:
        RNS.Transport.request_path(to)
        for _ in range(100):
            time.sleep(0.1)
            idn = RNS.Identity.recall(to)
            if idn: break
    if idn is None: out({'ev': 'error', 'msg': 'no identity for ' + to_hex}); return
    dest = RNS.Destination(idn, RNS.Destination.OUT, RNS.Destination.SINGLE, 'lxmf', 'delivery')
    m = LXMF.LXMessage(dest, me, text, desired_method=(LXMF.LXMessage.OPPORTUNISTIC if method == 'opportunistic' else LXMF.LXMessage.DIRECT))
    m.register_delivery_callback(lambda x: out({'ev': 'delivered', 'text': text}))
    m.register_failed_callback(lambda x: out({'ev': 'failed', 'text': text}))
    router.handle_outbound(m)
    out({'ev': 'sent', 'text': text})

for line in sys.stdin:
    try: c = json.loads(line)
    except Exception: continue
    if c.get('cmd') == 'send': threading.Thread(target=send, args=(c['to'], c['text'], c.get('method', 'direct')), daemon=True).start()
    elif c.get('cmd') == 'announce': announce()
    elif c.get('cmd') == 'quit': break
os._exit(0)
