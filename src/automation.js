import crypto from 'node:crypto';

const LIKE = /^(нравится|мне нравится|лайк|like|симпатия|поставить лайк|поставить симпатию)$/i;

export async function findButton(context, settings) {
  const candidates = [];
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      if (settings.frameUrl) {
        const expected = new URL(settings.frameUrl);
        let actual;
        try { actual = new URL(frame.url()); } catch { continue; }
        if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) continue;
      }
      const locator = settings.selector ? frame.locator(settings.selector) : frame.getByRole('button', { name: LIKE });
      for (const button of await locator.all()) {
        if (await button.isVisible() && await button.isEnabled() && await button.getAttribute('aria-pressed') !== 'true') candidates.push({ page, frame, button });
      }
    }
  }
  if (candidates.length > 1) throw new Error('Найдено несколько кнопок лайка. Уточните CSS-селектор или выберите кнопку при входе.');
  return candidates[0] || null;
}

export async function fingerprint(target, cardSelector = '') {
  const data = await target.button.evaluate((button, selector) => {
    const photos = root => [root, ...root.querySelectorAll('*')].flatMap(element => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 120 || rect.height <= 120) return [];
      if (element.localName === 'img') return [element.currentSrc || element.src];
      const background = getComputedStyle(element).backgroundImage;
      return background.includes('url(') ? [background] : [];
    });
    let card = selector ? document.querySelector(selector) : null;
    if (selector && !card) throw new Error('Контейнер анкеты не найден');
    if (!card) {
      let current = button.parentElement;
      while (current && current !== document.body) {
        if (photos(current).length || current.hasAttribute('data-profile-id') || current.hasAttribute('data-user-id')) { card = current; break; }
        current = current.parentElement;
      }
    }
    if (!card) throw new Error('Не найден контейнер анкеты с фотографией. Задайте CSS-селектор анкеты в настройках.');
    const clone = card.cloneNode(true);
    clone.querySelectorAll('button,[role="button"],input,script,style,[data-dating-picker]').forEach(el => el.remove());
    const images = photos(card).sort();
    const identity = card.getAttribute('data-profile-id') || card.getAttribute('data-user-id') || '';
    return { identity, text: clone.textContent.replace(/\s+/g, ' ').trim(), images };
  }, cardSelector);
  if (!data.identity && !data.text && !data.images.length) throw new Error('Не удалось определить анкету');
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export async function challenge(context) {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      if (await frame.locator('iframe[src*="captcha"],iframe[src*="challenge"]').filter({ visible: true }).count()) return true;
      const dialogs = frame.getByRole('dialog').filter({ hasText: /капч|подтвердите, что вы|проверка безопасности|лимит лайков|лайки закончились|купить|оплатить|captcha|out of likes/i });
      for (const dialog of await dialogs.all()) if (await dialog.isVisible()) return true;
    }
  }
  return false;
}

// Runs in each page/frame. The next selected click is captured, never sent to the site.
export function installPicker() {
  if (window.__datingPicker) return;
  let armed = false;
  let selecting = false;
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.dataset.datingPicker = 'true';
  badge.textContent = 'Выбрать кнопку лайка';
  badge.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;background:#17211e;color:white;padding:14px;border:2px solid #7ef0bb;border-radius:12px;font:14px sans-serif;cursor:pointer';
  function setArmed(value) {
    armed = value;
    badge.style.pointerEvents = armed ? 'none' : 'auto';
    badge.textContent = armed ? 'Нажмите на кнопку лайка (клик будет перехвачен)' : 'Выбрать кнопку лайка';
  }
  function message(text) { badge.textContent = text; badge.style.pointerEvents = 'auto'; }
  window.__datingPicker = { setArmed, message, get armed() { return armed; } };
  badge.onclick = async event => {
    event.preventDefault(); event.stopPropagation();
    setArmed(true);
    try { await window.datingArm?.(); }
    catch { setArmed(false); message('Не удалось включить выбор. Нажмите ещё раз.'); }
  };
  function mount() {
    // Init scripts run before documentElement exists; keep installation retryable.
    const root = document.body || document.documentElement;
    if (root && window === window.top && !badge.isConnected) root.appendChild(badge);
  }
  mount();
  document.addEventListener('DOMContentLoaded', mount, { once: true });
  new MutationObserver(mount).observe(document, { childList: true, subtree: true });
  const intercept = event => {
    if ((!armed && !selecting) || event.composedPath().includes(badge)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type !== 'click' || selecting) return;
    const element = event.composedPath().find(node => node instanceof Element);
    if (!element) return;
    const node = element.closest('button,[role="button"],a,[onclick],[tabindex]')
      || event.composedPath().find(node => node instanceof HTMLElement && getComputedStyle(node).cursor === 'pointer') || element;
    const escape = CSS.escape;
    let selector;
    for (const attr of ['data-testid', 'data-test', 'aria-label', 'id']) {
      const value = node.getAttribute(attr);
      if (value) {
        const candidate = `[${attr}="${escape(value)}"]`;
        if (node.getRootNode().querySelectorAll(candidate).length === 1) { selector = candidate; break; }
      }
    }
    if (!selector) {
      const parts = [];
      let element = node;
      while (element && element !== document.documentElement) {
        const tag = element.localName;
        const parent = element.parentElement || element.getRootNode().host;
        if (!parent) break;
        const siblings = [...(element.parentElement || element.getRootNode()).children].filter(el => el.localName === tag);
        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(element) + 1})`);
        element = parent;
      }
      selector = `html > ${parts.join(' > ')}`;
    }
    selecting = true;
    message('Кнопка выбрана. Проверяем…');
    Promise.resolve().then(() => window.datingPick({ selector })).then(() => {
      selecting = false; setArmed(false); message('Кнопка выбрана. Подключаем фон…');
    }).catch(() => { selecting = false; setArmed(false); message('Не удалось выбрать кнопку. Нажмите ещё раз.'); });
  };
  // React and other apps can react on pointerdown rather than click.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click']) {
    window.addEventListener(type, intercept, { capture: true, passive: false });
  }
}

export async function attachPicker(context, onPick) {
  let armed = false;
  let used = false;
  const broadcast = async (value, text) => {
    const frames = context.pages().flatMap(page => page.frames());
    await Promise.all(frames.map(frame => frame.evaluate(({ value, text }) => {
      window.__datingPicker?.setArmed(value);
      if (text) window.__datingPicker?.message(text);
    }, { value, text }).catch(() => {})));
  };
  await context.exposeBinding('datingArm', async () => {
    armed = true; used = true;
    await broadcast(true);
  });
  await context.exposeBinding('datingPick', async (source, value) => {
    if (typeof value?.selector !== 'string' || !value.selector) throw new Error('Кнопка не выбрана');
    await onPick(source, value);
    armed = false;
    await broadcast(false, 'Кнопка выбрана. Проверяем…');
  });
  await context.addInitScript(`(${installPicker.toString()})();`);
  return {
    get armed() { return armed; },
    get used() { return used; },
    async refresh() {
      await Promise.all(context.pages().flatMap(page => page.frames()).map(async frame => {
        await frame.evaluate(installPicker).catch(() => {});
        await frame.evaluate(value => window.__datingPicker?.setArmed(value), armed).catch(() => {});
      }));
    },
    async error(text) { await broadcast(false, `Не удалось подключить: ${text}`); },
  };
}
