// Статический сервер корня репозитория для тестов
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';

const TYPES = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png'};

export function serve(root){
  const srv = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
    if(!file.startsWith(root)){ res.writeHead(403).end(); return; }
    try{
      const body = await readFile(file);
      res.writeHead(200, {'content-type': TYPES[extname(file)] || 'application/octet-stream'}).end(body);
    }catch(e){ res.writeHead(404).end(); }
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, url:`http://127.0.0.1:${srv.address().port}/`})));
}
