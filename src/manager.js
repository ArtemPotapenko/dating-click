import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, directory, read, write, config, snapshot, lockIsAlive } from './store.js';

export function start(id, mode) {
  const dir = directory(id);
  if (!['login', 'resume'].includes(mode)) throw new Error('Неизвестный режим запуска');
  if (!config(id).url) throw new Error('Для Twinby сначала нужен подтверждённый адрес браузерного входа. Обычный twinby.ru — страница приложения.');
  const lockFile = path.join(dir, 'lock.json');
  const previous = read(lockFile, null);
  if (lockIsAlive(previous) || previous && !previous.pid && Date.now() - previous.created < 10000) throw new Error('Процесс уже работает. Сначала остановите его.');
  if (previous) fs.rmSync(lockFile, { force: true });
  const token = crypto.randomUUID();
  // Exclusive creation prevents two HTTP requests from launching the same profile.
  const fd = fs.openSync(lockFile, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ token, created: Date.now() })); fs.closeSync(fd);
  fs.rmSync(path.join(dir, 'stop'), { force: true });
  const state = read(path.join(dir, 'state.json'), { events: [] });
  write(path.join(dir, 'state.json'), { ...state, status: 'starting', message: 'Запуск процесса…' });
  let log;
  try {
    log = fs.openSync(path.join(dir, 'worker.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.join(ROOT, 'src/worker.js'), id, mode, token], {
      cwd: ROOT, detached: true, stdio: ['ignore', log, log], env: process.env,
    });
    child.once('error', error => {
      write(path.join(dir, 'state.json'), { ...state, status: 'error', message: error.message });
      if (read(lockFile, null)?.token === token) fs.rmSync(lockFile, { force: true });
    });
    child.unref();
  } catch (error) {
    fs.rmSync(lockFile, { force: true }); throw error;
  } finally { if (log !== undefined) fs.closeSync(log); }
  return snapshot(id);
}
export function stop(id) {
  const dir = directory(id);
  fs.writeFileSync(path.join(dir, 'stop'), '', { mode: 0o600 });
  return snapshot(id);
}
