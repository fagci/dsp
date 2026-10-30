// Загрузка ядра мессенджеров (modules/msgr-*.js — обычные скрипты страницы) в Node через vm: один код для страницы и моста.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = ['mgHex', 'mgUnhex', 'mgUtf8', 'mgB64', 'mgSchnorrPub', 'mgSchnorrSign', 'mgSchnorrVerify', 'mgBechEnc', 'mgBechDec',
  'mgNostrKey', 'mgNostrGenKey', 'mgNpub', 'mgNostrId', 'mgNostrSign', 'mgNostrVerify', 'mgNostrReq', 'mgNostrFrame', 'mgNostrText',
  'mgLines', 'mgNtfyLine', 'mgMatrixSync', 'mgTgUpdates', 'mgIrcParse', 'mgIrcFmt', 'mgSplit', 'mgIrcClient',
  'mgAprsPass', 'mgAprsParse', 'mgAprsMsg', 'mgAprsAck', 'mgAprsClient', 'mgXmlParser', 'mgXmlEsc', 'mgXmppClient', 'mgConnect'];

// extra — глобалы, которых нет у vm-контекста по умолчанию (fetch, WebSocket, …); по умолчанию берутся из Node
export function loadMsgr(extra = {}) {
  const g = {Uint8Array, Uint32Array, TextEncoder, TextDecoder, DataView, BigInt, Math, JSON, Date, Promise, Error, Array, Object, String, Number, Set, Map,
    URL, URLSearchParams, AbortController, btoa, atob, console, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, encodeURIComponent, ...extra};
  const ctx = vm.createContext(g);
  for (const f of ['modules/meshcore-kernels.js', 'modules/msgr-kernels.js', 'modules/msgr-session.js']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, {filename: f});
  }
  const have = API.filter(n => vm.runInContext('typeof ' + n, ctx) !== 'undefined');
  return vm.runInContext('({' + have.join(',') + '})', ctx);
}
