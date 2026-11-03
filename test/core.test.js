import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dating-core-'));
process.env.DATING_CLICK_DATA = temp;
const { validateConfig, rollover, lockIsAlive, directory, write, snapshot } = await import('../src/store.js');
const { createApp } = await import('../src/server.js');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('settings reject unsafe URLs and enforce numeric limits', () => {
  const input = { url: 'https://example.com/', interval: 5, dailyLimit: 10, selector: '', cardSelector: '' };
  assert.equal(validateConfig(input, {}).interval, 5);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com', 'https://a:b@example.com']) {
    assert.throws(() => validateConfig({ ...input, url }, {}));
  }
  for (const dailyLimit of [0, -1, NaN, Infinity, 1.5, 10001]) assert.throws(() => validateConfig({ ...input, dailyLimit }, {}));
  const prior = { ...input, landingUrl: 'https://example.com/feed', frameUrl: 'https://example.com/frame' };
  assert.equal(validateConfig(input, prior).landingUrl, prior.landingUrl);
  assert.equal(validateConfig({ ...input, selector: '#new' }, prior).landingUrl, undefined);
});

test('daily budget resets only when the local calendar day changes', () => {
  const now = new Date(2026, 10, 2, 15);
  const state = rollover({ day: '2026-11-02', attempts: 10, likes: 9, seen: ['abc'] }, now);
  assert.equal(state.attempts, 10);
  rollover(state, new Date(2026, 10, 3, 0));
  assert.equal(state.attempts, 0);
  assert.equal(state.likes, 0);
  assert.deepEqual(state.seen, ['abc']);
});

test('a stale PID is not mistaken for a live worker', () => {
  assert.equal(lockIsAlive({ pid: process.pid, token: 'unrelated-token' }), false);
  const dir = directory('vk');
  write(path.join(dir, 'state.json'), { status: 'running', message: 'running' });
  write(path.join(dir, 'lock.json'), { pid: 99999999, token: 'stale' });
  assert.equal(snapshot('vk').active, false);
  assert.equal(snapshot('vk').status, 'stopped');
});

test('local HTTP API rejects cross-origin changes and DNS rebinding', async () => {
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(base)).text();
    const token = /name="app-token" content="([a-f0-9]+)"/.exec(html)[1];
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    assert.equal((await fetch(`${base}/api/vk/stop`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/api/vk/stop`, { method: 'POST', headers: { 'X-App-Token': token, Origin: 'https://evil.example' } })).status, 403);
    const reboundStatus = await new Promise((resolve, reject) => {
      const req = http.get(base, { headers: { Host: `evil.example:${server.address().port}` } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await fetch(`${base}/api/vk/stop`, { method: 'POST', headers: { 'X-App-Token': token } })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
