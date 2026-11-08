#!/usr/bin/env node
/* Локальный сервер тренажёра — ноль зависимостей.
 *
 * Зачем: Web MIDI (и установка PWA) требуют защищённый контекст.
 * http://localhost — защищённый, поэтому телефон подключают к компьютеру
 * USB-кабелем и пробрасывают порт:
 *
 *   node serve.mjs                        # на компьютере
 *   adb reverse tcp:8737 tcp:8737         # проброс порта на телефон
 *   # на телефоне: http://localhost:8737
 *
 * Слушаем только 127.0.0.1: раздача по Wi-Fi (http://<ip-локальной-сети>)
 * всё равно не даёт защищённого контекста, а наружу светиться незачем.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 8737);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      // no-store: свежие файлы на каждой загрузке — офлайн-кэшированием занимается sw.js
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Тренажёр чтения нот:  http://localhost:${PORT}`);
  console.log(`Телефон (USB):        adb reverse tcp:${PORT} tcp:${PORT}  →  http://localhost:${PORT}`);
});
