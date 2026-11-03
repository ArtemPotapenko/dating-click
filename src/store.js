import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.resolve(process.env.DATING_CLICK_DATA || path.join(ROOT, '.data'));
export const PROVIDERS = {
  vk: { name: 'VK Знакомства', url: 'https://vk.ru/dating', color: '#0077ff' },
  mamba: { name: 'Mamba', url: 'https://www.mamba.ru/', color: '#ff7849' },
  twinby: { name: 'Twinby', url: '', color: '#8464e8' },
};
export function directory(id) {
  if (!Object.hasOwn(PROVIDERS, id)) throw new Error('Неизвестная платформа');
  const dir = path.join(DATA, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function read(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function write(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function config(id) {
  return { url: PROVIDERS[id].url, interval: 15, dailyLimit: 100, selector: '', cardSelector: '', ...read(path.join(directory(id), 'config.json')) };
}
export function validateConfig(input, previous) {
  const result = { ...previous };
  if (typeof input.url !== 'string') throw new Error('Укажите адрес сайта');
  let url;
  try { url = new URL(input.url); } catch { throw new Error('Укажите полный HTTPS-адрес браузерного входа'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Разрешён только HTTPS без пароля в адресе');
  result.url = url.href;
  for (const [key, min, max] of [['interval', 5, 3600], ['dailyLimit', 1, 10000]]) {
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new Error(`${key}: допустимо целое число от ${min} до ${max}`);
    result[key] = input[key];
  }
  for (const key of ['selector', 'cardSelector']) {
    if (typeof input[key] !== 'string' || input[key].length > 2000) throw new Error('Некорректный CSS-селектор');
    result[key] = input[key].trim();
  }
  // A URL or target change invalidates the captured frame and landing page.
  if (result.url !== previous.url || result.selector !== previous.selector) {
    delete result.landingUrl;
    delete result.frameUrl;
  }
  return result;
}
export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function rollover(state, now = new Date()) {
  const day = localDay(now);
  if (state.day !== day) { state.day = day; state.attempts = 0; state.likes = 0; }
  return state;
}
export function lockIsAlive(lock) {
  if (!lock?.pid || !lock?.token) return false;
  try {
    // Verify identity before treating a recycled PID as one of our workers.
    const args = fs.readFileSync(`/proc/${lock.pid}/cmdline`, 'utf8').split('\0');
    return args.includes(lock.token) && args.some(arg => arg.endsWith('/worker.js'));
  } catch { return false; }
}
export function snapshot(id) {
  const dir = directory(id);
  const state = rollover(read(path.join(dir, 'state.json'), { status: 'idle', message: 'Подключите аккаунт', events: [] }));
  const lock = read(path.join(dir, 'lock.json'), null);
  const alive = lockIsAlive(lock);
  const reserved = lock && !lock.pid && Date.now() - lock.created < 10000;
  if (!alive && !reserved && ['starting', 'login', 'running', 'waiting', 'stopping'].includes(state.status)) {
    state.status = 'stopped'; state.message = 'Фоновый процесс завершён. Нажмите «Продолжить».';
  }
  if ((alive || reserved) && fs.existsSync(path.join(dir, 'stop'))) {
    state.status = 'stopping'; state.message = 'Останавливаем процесс и сохраняем сессию…';
  }
  return { id, ...PROVIDERS[id], config: config(id), ...state, active: !!(alive || reserved) };
}
