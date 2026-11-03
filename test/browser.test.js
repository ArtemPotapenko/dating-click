import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { findButton, fingerprint, challenge, installPicker } from '../src/automation.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dating-browser-'));
process.env.DATING_CLICK_DATA = temp;
const { directory, write, snapshot, config, read } = await import('../src/store.js');
const { start, stop } = await import('../src/manager.js');
const { createApp } = await import('../src/server.js');
const launchOptions = { headless: true };
if (process.env.DATING_CLICK_BROWSER) launchOptions.executablePath = process.env.DATING_CLICK_BROWSER;
else if (fs.existsSync('/usr/bin/google-chrome')) launchOptions.channel = 'chrome';

async function until(predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(200); }
  throw new Error('Timed out waiting for expected state');
}
let browser;
test.before(async () => { browser = await chromium.launch(launchOptions); });
test.after(async () => {
  for (const id of ['mamba', 'vk']) {
    stop(id);
    await until(() => !snapshot(id).active, 10000).catch(() => {});
  }
  await browser?.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('unchanged card stops after one attempt and is never clicked again on resume', { timeout: 45000 }, async () => {
  let clicks = 0;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/like') { clicks++; res.end('ok'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<article id="card" data-profile-id="unchanged"><p>Анкета</p><button id="like" onclick="fetch(\'/like\',{method:\'POST\'})">Нравится</button></article>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const dir = directory('vk');
  write(path.join(dir, 'config.json'), { ...config('vk'), url: `http://127.0.0.1:${fixture.address().port}`, selector: '#like', cardSelector: '#card', dailyLimit: 10, interval: 5 });
  try {
    start('vk', 'resume');
    await until(() => snapshot('vk').status === 'error' && !snapshot('vk').active);
    assert.match(snapshot('vk').message, /анкета не сменилась/);
    assert.equal(clicks, 1);
    start('vk', 'resume');
    await until(() => snapshot('vk').status === 'error' && !snapshot('vk').active);
    assert.match(snapshot('vk').message, /уже обрабатывалась/);
    assert.equal(clicks, 1);
    assert.equal(snapshot('vk').attempts, 1);
  } finally {
    stop('vk');
    await until(() => !snapshot('vk').active).catch(() => {});
    await new Promise(resolve => fixture.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('visible login automatically hands cookies and sessionStorage to the background browser', { timeout: 30000, skip: !process.env.DISPLAY }, async () => {
  let clicks = 0;
  let authorizedFeedLoads = 0;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/like') { clicks++; res.end('ok'); return; }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/login') {
      res.setHeader('Set-Cookie', 'fixture_session=ok; Path=/; HttpOnly');
      res.end('<script>sessionStorage.fixture_auth="ok";location.replace("/feed")</script>');
    } else if (req.headers.cookie?.includes('fixture_session=ok')) {
      authorizedFeedLoads++;
      res.end(`<article id="card" data-profile-id="${clicks}"><p>Анкета</p><button id="like" onclick="fetch('/like',{method:'POST'}).then(()=>document.querySelector('article').dataset.profileId='next')">Нравится</button></article><script>if(sessionStorage.fixture_auth!=='ok')document.querySelector('article').remove()</script>`);
    } else { res.end('<p>Сессия не перенесена</p>'); }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const dir = directory('vk');
  write(path.join(dir, 'config.json'), { ...config('vk'), url: `http://127.0.0.1:${fixture.address().port}/login`, selector: '#like', cardSelector: '#card', dailyLimit: 1, interval: 5 });
  try {
    start('vk', 'login');
    await until(() => {
      const state = snapshot('vk');
      if (state.status === 'error') throw new Error(`${state.message}\n${fs.readFileSync(path.join(dir, 'worker.log'), 'utf8')}`);
      return state.status === 'waiting';
    }, 25000);
    assert.equal(clicks, 1);
    assert.ok(authorizedFeedLoads >= 2, 'both visible and headless browsers loaded an authorized page');
    assert.match(config('vk').landingUrl, /\/feed$/);
  } catch (error) {
    console.error('Login handoff diagnostic:', snapshot('vk'), fs.readFileSync(path.join(dir, 'worker.log'), 'utf8'));
    throw error;
  } finally {
    stop('vk');
    await until(() => !snapshot('vk').active).catch(() => {});
    await new Promise(resolve => fixture.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('button discovery excludes superlikes, hidden and already-liked buttons', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent('<button>Суперлайк</button><button hidden>Лайк</button><button aria-pressed="true">Нравится</button><button id="like">Нравится</button>');
    const target = await findButton(context, {});
    assert.equal(await target.button.getAttribute('id'), 'like');
    await page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Like'; document.body.appendChild(button); });
    await assert.rejects(findButton(context, {}), /несколько кнопок/);
  } finally { await context.close(); }
});

test('fingerprints follow profiles and reject missing card scopes', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent('<article id="card" data-profile-id="1"><p>Анна</p><img width="240" height="240" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><button>Нравится</button></article>');
    const target = await findButton(context, {});
    const first = await fingerprint(target);
    assert.equal(await fingerprint(target), first);
    await page.locator('#card').evaluate(el => el.dataset.profileId = '2');
    assert.notEqual(await fingerprint(target), first);
    await assert.rejects(fingerprint(target, '#missing'), /Контейнер анкеты не найден/);
  } finally { await context.close(); }
});

test('calibration intercepts a real click and returns a usable selector', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    let selection;
    await context.exposeBinding('datingPick', (source, value) => { selection = value; });
    await page.setContent('<button aria-label="Симпатия" onclick="window.sent=true">♥</button>');
    await page.evaluate(installPicker);
    await page.locator('[data-dating-picker]').click();
    await page.getByRole('button', { name: 'Симпатия', exact: true }).click();
    await until(() => selection);
    assert.equal(await page.evaluate(() => !!window.sent), false);
    assert.equal(await page.locator(selection.selector).count(), 1);
    await page.setContent('<div role="dialog">Лайки закончились — купить</div>');
    assert.equal(await challenge(context), true);
  } finally { await context.close(); }
});

test('detached worker survives panel server shutdown and preserves its limit on resume', { timeout: 60000 }, async () => {
  let clicks = 0;
  const fixture = http.createServer((req, res) => {
    if (req.url === '/like') { clicks++; res.writeHead(200); res.end('ok'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><article id="card" data-profile-id="${clicks}"><p>Анкета</p><img width="240" height="240" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><button id="like" onclick="fetch('/like',{method:'POST'}).then(()=>{document.querySelector('article').dataset.profileId=String(Number(document.querySelector('article').dataset.profileId)+1)})">Нравится</button></article>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const dir = directory('mamba');
  write(path.join(dir, 'config.json'), { ...config('mamba'), url: `http://127.0.0.1:${fixture.address().port}`, selector: '#like', cardSelector: '#card', dailyLimit: 2, interval: 5 });
  const panel = createApp();
  await new Promise(resolve => panel.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${panel.address().port}`;
  const html = await (await fetch(base)).text();
  const token = /name="app-token" content="([a-f0-9]+)"/.exec(html)[1];
  try {
    const response = await fetch(`${base}/api/mamba/resume`, { method: 'POST', headers: { 'X-App-Token': token } });
    assert.equal(response.status, 200);
    assert.throws(() => start('mamba', 'resume'), /уже работает/);
    await new Promise(resolve => panel.close(resolve));
    await until(() => snapshot('mamba').status === 'waiting', 30000);
    assert.equal(clicks, 2);
    assert.equal(snapshot('mamba').likes, 2);
    stop('mamba');
    await until(() => !snapshot('mamba').active);
    start('mamba', 'resume');
    await until(() => snapshot('mamba').status === 'waiting');
    await sleep(1000);
    assert.equal(clicks, 2);
    assert.equal(snapshot('mamba').attempts, 2);
  } finally {
    if (panel.listening) await new Promise(resolve => panel.close(resolve));
    stop('mamba');
    await until(() => !snapshot('mamba').active).catch(() => {});
    await new Promise(resolve => fixture.close(resolve));
    const state = read(path.join(dir, 'state.json'));
    if (state.status === 'error') console.error(state.message, fs.readFileSync(path.join(dir, 'worker.log'), 'utf8'));
  }
});
