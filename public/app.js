const token = document.querySelector('meta[name="app-token"]').content;
const labels = { idle: 'Не подключён', starting: 'Запускается', login: 'Ожидает входа', running: 'Работает в фоне', waiting: 'Дневной лимит', stopped: 'Остановлен', stopping: 'Останавливается', error: 'Нужно внимание' };
const cards = new Map();
const errorBox = document.querySelector('#error');
function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
async function action(id, name, body = {}) {
  errorBox.hidden = true;
  const response = await fetch(`/api/${id}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': token }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
function createCard(platform) {
  const card = document.querySelector('#card-template').content.firstElementChild.cloneNode(true);
  card.dataset.id = platform.id;
  card.querySelector('h3').textContent = platform.name;
  card.querySelector('.platform-icon').textContent = { vk: 'VK', mamba: 'm', twinby: 'tw' }[platform.id];
  for (const input of card.querySelectorAll('input')) input.value = platform.config[input.name];
  card.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    button.disabled = true;
    try { await action(platform.id, button.dataset.action); await refresh(); }
    catch (error) { showError(error.message); }
    finally { button.disabled = false; }
  });
  card.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    data.interval = Number(data.interval); data.dailyLimit = Number(data.dailyLimit);
    try {
      await action(platform.id, 'settings', data);
      card.querySelector('.saved').textContent = 'Сохранено';
      await refresh();
    } catch (error) { showError(error.message); }
  });
  document.querySelector('#platforms').appendChild(card); cards.set(platform.id, card);
  return card;
}
async function refresh() {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error('Не удалось получить статус');
  const platforms = await response.json();
  let active = 0;
  for (const platform of platforms) {
    const card = cards.get(platform.id) || createCard(platform);
    card.querySelector('.status').textContent = labels[platform.status] || 'Не подключён';
    card.querySelector('.status').dataset.status = platform.status;
    card.querySelector('.message').textContent = platform.id === 'twinby' && !platform.config.url
      ? 'Нужен адрес веб-версии: на twinby.ru не подтверждён вход в ленту анкет. Укажи ссылку в настройках.' : platform.message;
    card.querySelector('.likes').textContent = platform.likes || 0;
    card.querySelector('.limit').textContent = platform.config.dailyLimit;
    for (const button of card.querySelectorAll('[data-action]')) {
      button.hidden = button.dataset.action === 'stop' ? !platform.active : platform.active;
      button.disabled = button.dataset.action !== 'stop' && !platform.config.url;
    }
    // Do not overwrite settings while the user is editing an open form.
    if (!card.querySelector('details').open) for (const input of card.querySelectorAll('input')) input.value = platform.config[input.name];
    for (const element of card.querySelectorAll('form input,form button')) element.disabled = platform.active;
    if (platform.active) active++;
  }
  document.querySelector('#summary').textContent = active ? `Активных процессов: ${active} из 3` : 'Выбери платформу для начала';
  const events = platforms.flatMap(p => (p.events || []).map(e => ({ ...e, name: p.name }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
  const container = document.querySelector('#events');
  container.replaceChildren();
  if (!events.length) { const p = document.createElement('p'); p.textContent = 'Здесь появятся события после подключения аккаунта.'; container.appendChild(p); }
  for (const event of events) {
    const row = document.createElement('div'); row.className = 'event';
    const time = document.createElement('time'); time.textContent = new Date(event.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const name = document.createElement('strong'); name.textContent = event.name;
    const message = document.createElement('span'); message.textContent = event.message;
    row.append(time, name, message); container.appendChild(row);
  }
}
async function poll() {
  try { await refresh(); }
  catch (error) { showError(`${error.message}. Проверь, запущен ли npm start. Фоновые процессы продолжают работать независимо от панели.`); }
  setTimeout(poll, 2000);
}
poll();
