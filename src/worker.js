import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { directory, read, write, config, rollover } from './store.js';
import { findButton, fingerprint, challenge, attachPicker } from './automation.js';

const [id, mode, token] = process.argv.slice(2);
const dir = directory(id);
const stateFile = path.join(dir, 'state.json');
const lockFile = path.join(dir, 'lock.json');
const stopFile = path.join(dir, 'stop');
const state = rollover(read(stateFile, { events: [], seen: [] }));
let stopping = false;
let context;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
const stopped = () => stopping || fs.existsSync(stopFile);
function update(status, message, log = true) {
  state.status = status; state.message = message; state.updatedAt = new Date().toISOString();
  if (log) state.events = [...(state.events || []), { at: state.updatedAt, message }].slice(-80);
  write(stateFile, state);
}
async function wait(ms) {
  const end = Date.now() + ms;
  while (!stopped() && Date.now() < end) await sleep(Math.min(250, end - Date.now()));
}
async function launch(headless) {
  const options = { headless, locale: 'ru-RU', viewport: { width: 1280, height: 900 }, timeout: 30000 };
  if (process.env.DATING_CLICK_BROWSER) options.executablePath = process.env.DATING_CLICK_BROWSER;
  else if (fs.existsSync('/usr/bin/google-chrome')) options.channel = 'chrome';
  context = await chromium.launchPersistentContext(path.join(dir, 'profile'), options);
  context.setDefaultTimeout(5000);
  return context.pages()[0] || await context.newPage();
}
async function saveSession() {
  const session = [];
  for (const p of context.pages()) for (const f of p.frames()) {
    const item = await f.evaluate(() => ({ origin: location.origin, values: { ...sessionStorage } })).catch(() => null);
    if (item && item.origin !== 'null') session.push(item);
  }
  if (session.length) write(path.join(dir, 'session.json'), session);
  // Chromium can discard session cookies on graceful exit even in a persistent profile.
  write(path.join(dir, 'cookies.json'), await context.cookies());
}
async function login() {
  const page = await launch(false);
  let picked = null;
  const picker = await attachPicker(context, async ({ page: pickedPage, frame }, value) => {
    if (typeof value?.selector !== 'string') return;
    picked = { selector: value.selector, landingUrl: pickedPage.url(), frameUrl: frame.url() };
  });
  await page.goto(config(id).url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  update('login', 'Войдите в аккаунт и откройте ленту анкет. При необходимости выберите кнопку лайка на странице.');
  const deadline = Date.now() + 15 * 60 * 1000;
  while (!stopped() && Date.now() < deadline) {
    if (!context.pages().length) throw new Error('Окно входа закрыто. Нажмите «Войти» ещё раз.');
    // New cross-origin frames and SPA navigation also receive the calibration tool.
    await picker.refresh();
    if (picker.armed || picker.used && !picked) { await wait(250); continue; }
    let target;
    try { target = await findButton(context, picked ? { ...config(id), ...picked } : config(id)); }
    catch (error) { update('login', error.message, false); }
    if (target && !await challenge(context)) {
      try {
        await fingerprint(target, config(id).cardSelector);
        if (picker.armed) continue;
        const settings = { ...config(id), ...(picked || {}), landingUrl: target.page.url(), frameUrl: target.frame.url() };
        write(path.join(dir, 'config.json'), settings);
        await saveSession();
        await context.close(); context = null;
        return;
      } catch (error) {
        update('login', error.message, false);
        if (picked) await picker.error(error.message);
      }
    }
    await wait(1500);
  }
  if (!stopped()) throw new Error('Время входа истекло. Нажмите «Войти» для повторной попытки.');
}
async function run() {
  const page = await launch(true);
  await context.addCookies(read(path.join(dir, 'cookies.json'), []));
  const session = read(path.join(dir, 'session.json'), []);
  await context.addInitScript(items => {
    for (const item of items) if (location.origin === item.origin) {
      for (const [key, value] of Object.entries(item.values)) sessionStorage.setItem(key, value);
    }
  }, session);
  const settings = config(id);
  await page.goto(settings.landingUrl || settings.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  update('running', 'Фоновый браузер запущен. Панель управления можно закрыть.');
  let misses = 0;
  while (!stopped()) {
    rollover(state);
    const settings = config(id);
    if (state.attempts >= settings.dailyLimit) {
      update('waiting', 'Дневной лимит достигнут. Продолжим после полуночи по времени компьютера.', state.status !== 'waiting');
      await wait(30000); continue;
    }
    if (await challenge(context)) throw new Error('Сайт запросил проверку, оплату или сообщил о лимите. Откройте «Войти» и проверьте страницу.');
    const target = await findButton(context, settings);
    if (!target) {
      if (++misses >= 20) throw new Error('Кнопка лайка недоступна: проверьте вход, ленту, лимит или настройку кнопки через «Войти».');
      await wait(1500); continue;
    }
    misses = 0;
    const before = await fingerprint(target, settings.cardSelector);
    await wait(1500);
    if (stopped()) break;
    if (before !== await fingerprint(target, settings.cardSelector)) continue;
    if ((state.seen || []).includes(before)) throw new Error('Эта анкета уже обрабатывалась. Остановлено, чтобы не поставить повторный лайк.');
    // Reserve the attempt BEFORE clicking: crashes/restarts never bypass the daily cap.
    state.attempts++;
    state.seen = [...(state.seen || []), before].slice(-10000);
    update('running', 'Обрабатываем следующую анкету', false);
    await target.button.click({ timeout: 5000 });
    let changed = false;
    for (let i = 0; i < 20 && !stopped(); i++) {
      await wait(500);
      if (await challenge(context)) break;
      const next = await findButton(context, settings);
      if (next && await fingerprint(next, settings.cardSelector) !== before) { changed = true; break; }
    }
    if (stopped()) break;
    if (!changed) throw new Error('После клика анкета не сменилась. Проверьте сайт через «Войти»; повторные клики отключены.');
    state.likes = (state.likes || 0) + 1;
    await saveSession();
    update('running', `Анкета сменилась после лайка. Сегодня: ${state.likes}.`);
    await wait(settings.interval * 1000);
  }
}

try {
  const reservation = read(lockFile, null);
  if (reservation?.token !== token) throw new Error('Резервирование процесса потеряно');
  write(lockFile, { pid: process.pid, token, created: Date.now() });
  update('starting', mode === 'login' ? 'Открываем окно входа…' : 'Запускаем фоновый браузер…');
  if (mode === 'login') await login();
  if (!stopped()) await run();
  update('stopped', 'Автоматизация остановлена');
} catch (error) {
  console.error(error);
  update(stopped() ? 'stopped' : 'error', stopped() ? 'Автоматизация остановлена' : error.message);
} finally {
  if (context) {
    await saveSession().catch(() => {});
    await context.close().catch(() => {});
  }
  if (read(lockFile, null)?.token === token) fs.rmSync(lockFile, { force: true });
}
