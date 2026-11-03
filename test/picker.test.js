import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';
import { attachPicker, fingerprint, findButton } from '../src/automation.js';

let browser;
let fixture;
let port;
test.before(async () => {
  const options = { headless: true };
  if (process.env.DATING_CLICK_BROWSER) options.executablePath = process.env.DATING_CLICK_BROWSER;
  else if (fs.existsSync('/usr/bin/google-chrome')) options.channel = 'chrome';
  browser = await chromium.launch(options);
  fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/frame') {
      res.end(`<article data-profile-id="one" style="background-image:url('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');width:300px;height:300px"><p>Анкета</p><div role="button" id="heart" style="cursor:pointer;width:80px;height:60px" onpointerdown="window.sent=true" onclick="window.sent=true"><svg width="50" height="50"><path d="M0 0H50V50H0Z" fill="red"/></svg></div></article>`);
    } else {
      res.end(`<!doctype html><html><head><title>Real navigation</title></head><body><iframe id="dating" src="http://127.0.0.1:${port}/frame" style="margin-top:100px;width:600px;height:450px"></iframe></body></html>`);
    }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  port = fixture.address().port;
});
test.after(async () => {
  await browser?.close();
  if (fixture) await new Promise(resolve => fixture.close(resolve));
});

test('picker installs before DOM and arms a cross-origin iframe from main toolbar', async () => {
  const context = await browser.newContext();
  const errors = [];
  let picked;
  try {
    const picker = await attachPicker(context, (source, value) => { picked = { source, ...value }; });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://localhost:${port}/`);
    const toolbar = page.locator('[data-dating-picker]');
    await toolbar.waitFor();
    assert.equal(await toolbar.count(), 1);
    await toolbar.click();
    const frame = page.frames().find(f => f.url() === `http://127.0.0.1:${port}/frame`);
    await frame.waitForFunction(() => window.__datingPicker?.armed);
    await frame.locator('#heart svg path').click();
    await page.waitForFunction(() => document.querySelector('[data-dating-picker]').textContent.includes('выбрана'));
    assert.ok(picked);
    assert.equal(picked.source.frame, frame);
    assert.equal(await frame.evaluate(() => !!window.sent), false);
    assert.equal(await frame.locator(picked.selector).getAttribute('id'), 'heart');
    assert.equal(picker.armed, false);
    assert.deepEqual(errors, []);
    const target = await findButton(context, { selector: picked.selector, frameUrl: frame.url() });
    assert.ok(await fingerprint(target));
  } finally { await context.close(); }
});

test('toolbar is restored after a SPA replaces the document body', async () => {
  const context = await browser.newContext();
  try {
    await attachPicker(context, () => {});
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/`);
    await page.locator('[data-dating-picker]').waitFor();
    await page.evaluate(() => { document.body.innerHTML = '<p>SPA rerender</p>'; });
    await page.locator('[data-dating-picker]').waitFor();
    assert.equal(await page.locator('[data-dating-picker]').count(), 1);
    await page.locator('[data-dating-picker]').click();
    await page.waitForFunction(() => window.__datingPicker?.armed);
  } finally { await context.close(); }
});
