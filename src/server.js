import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, PROVIDERS, directory, config, snapshot, validateConfig, write } from './store.js';
import { start, stop } from './manager.js';

export function createApp() {
  const token = crypto.randomBytes(32).toString('hex');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const reply = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
      if (!hosts.includes(req.headers.host)) return reply(403, { error: 'Недопустимый Host' });
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin) return reply(403, { error: 'Недопустимый Origin' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/status') return reply(200, Object.keys(PROVIDERS).map(snapshot));
      if (req.method === 'POST') {
        if (req.headers['x-app-token'] !== token) return reply(403, { error: 'Обновите страницу панели управления' });
        const match = /^\/api\/(vk|mamba|twinby)\/(login|resume|stop|settings)$/.exec(url.pathname);
        if (!match) return reply(404, { error: 'Маршрут не найден' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16384) return reply(413, { error: 'Слишком большой запрос' });
        }
        const input = body ? JSON.parse(body) : {};
        const [, id, action] = match;
        if (action === 'stop') return reply(200, stop(id));
        if (action === 'settings') {
          if (snapshot(id).active) throw new Error('Остановите процесс перед изменением настроек');
          write(path.join(directory(id), 'config.json'), validateConfig(input, config(id)));
          return reply(200, snapshot(id));
        }
        return reply(200, start(id, action));
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const asset = files[url.pathname];
      if (req.method !== 'GET' || !asset) return reply(404, { error: 'Не найдено' });
      let content = fs.readFileSync(path.join(ROOT, 'public', asset[0]), 'utf8');
      if (asset[0] === 'index.html') content = content.replace('{{TOKEN}}', token);
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(content);
    } catch (error) { reply(400, { error: error.message }); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3210);
  const server = createApp();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Dating Click: http://127.0.0.1:${port}\nЗакрытие панели или сервера не останавливает фоновые процессы. Для остановки используйте кнопку в панели.`));
}
