// Боковая панель: по кнопке «Обновить» делает запрос allAlerts от имени вкладки KATA
'use strict';

const API_PATH = '/apt/api/pcn/allAlerts';
const STATE = ['new', 'rescan'];
const LIMIT = 500;
const MAX_PAGES = 20;   // не больше 10 000 алертов за одно обновление

const $ = id => document.getElementById(id);
let settings = { origin: '', companyId: '' };
const openKeys = new Set();
let lastAlerts = null;

//настройки
function normalizeOrigin(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s);
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch (e) { return ''; }
}

function matchPattern(origin) {
  const u = new URL(origin);
  return u.protocol + '//' + u.hostname + '/*';
}

function cleanCompanyId(s) {
  return String(s || '').trim().replace(/^\[\s*/, '').replace(/\s*\]$/, '').replace(/^"|"$/g, '');
}

async function loadSettings() {
  const s = await chrome.storage.local.get({ origin: '', companyId: '' });
  settings = s;
  $('origin').value = s.origin;
  $('company').value = s.companyId;
  if (!s.origin) {
    $('settings').hidden = false;
    showMessage('note', 'Укажите адрес KATA и нажмите «Сохранить». company_id можно добавить позже, если KATA ответит «No permissions to company or node».');
  }
}

$('toggleSettings').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });

$('save').addEventListener('click', async () => {
  const origin = normalizeOrigin($('origin').value);
  if (!origin) { $('saveMsg').textContent = 'Не похоже на адрес'; return; }
  // доступ запрашивается только к этому адресу
  const granted = await chrome.permissions.request({ origins: [matchPattern(origin)] });
  if (!granted) { $('saveMsg').textContent = 'Доступ к сайту не разрешён'; return; }
  settings = { origin, companyId: cleanCompanyId($('company').value) };
  await chrome.storage.local.set(settings);
  $('origin').value = settings.origin;
  $('company').value = settings.companyId;
  $('saveMsg').textContent = 'Сохранено';
  setTimeout(() => { $('saveMsg').textContent = ''; }, 2000);
  $('settings').hidden = true;
  $('out').replaceChildren();
});

//поиск вкладки KATA
async function findKataTab() {
  const tabs = await chrome.tabs.query({});
  const kata = tabs.filter(t => {
    try { return t.url && new URL(t.url).origin === settings.origin; } catch (e) { return false; }
  });
  if (!kata.length) return null;
  const win = await chrome.windows.getLastFocused().catch(() => null);
  return kata.find(t => t.active && win && t.windowId === win.id)
    || kata.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

//выполняется на вкладке KATA (изолированное окружение)
async function fetchAlertsInPage(cfg) {
  const out = [];
  try {
    for (let page = 0; page < cfg.maxPages; page++) {
      const res = await fetch(cfg.path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-slide-user-session': 'true' },
        body: JSON.stringify({
          limit: cfg.limit, offset: page * cfg.limit, state: cfg.state, hideClosed: false,
          order_by: 'created', order_type: 'desc', company_id: [cfg.companyId]
        })
      });
      const text = await res.text();
      if (res.status !== 200) return { ok: false, status: res.status, error: text.slice(0, 300) };
      let json;
      try { json = JSON.parse(text); } catch (e) { return { ok: false, error: 'Ответ не JSON — возможно, истекла сессия. Обновите страницу KATA и войдите.' }; }
      const list = Array.isArray(json) ? json : (json.data || []);
      // в панель передаём только нужные поля
      list.forEach(a => out.push({
        type: a.type, technologies: a.technologies,
        object: a.details ? a.details.object : null,
        source: a.source, destination: a.destination
      }));
      if (list.length < cfg.limit) break;
    }
    return { ok: true, alerts: out };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

//обновление
async function refresh() {
  if (!settings.origin) { $('settings').hidden = false; return; }
  const btn = $('refresh');
  btn.disabled = true;
  $('title').textContent = 'Загрузка…';
  try {
    const tab = await findKataTab();
    if (!tab) {
      showError('Не найдена открытая вкладка ' + settings.origin + '. Откройте KATA и войдите.');
      return;
    }
    let result;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fetchAlertsInPage,
        args: [{ path: API_PATH, state: STATE, limit: LIMIT, maxPages: MAX_PAGES, companyId: settings.companyId }]
      });
      result = r && r.result;
    } catch (e) {
      showError('Нет доступа к вкладке KATA: ' + e.message + '. Откройте ⚙ и нажмите «Сохранить», чтобы выдать доступ.');
      return;
    }
    if (!result) { showError('Вкладка KATA не ответила. Обновите её и попробуйте снова.'); return; }
    if (!result.ok) {
      const text = (result.status ? 'KATA ответила ' + result.status + ': ' : '') + result.error;
      showError(text, /company|node|permission/i.test(result.error || ''));
      return;
    }
    lastAlerts = result.alerts;
    render(result.alerts);
  } finally {
    btn.disabled = false;
  }
}

$('refresh').addEventListener('click', refresh);

//отрисовка
function el(tag, attrs, kids) {
  const n = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v == null || v === false) return;
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  });
  (kids || []).forEach(c => c != null && n.append(c));
  return n;
}

function showMessage(cls, text) {
  $('out').replaceChildren(el('div', { class: cls, text }));
}

function showError(text, companyHint) {
  $('title').textContent = 'Ошибка';
  $('sub').textContent = new Date().toLocaleTimeString();
  const box = [el('div', { class: 'err', text })];
  if (companyHint) {
    box.push(el('div', { class: 'note', text: 'Похоже, нужен company_id. Скопируйте его из F12 → Network → allAlerts → Payload, вставьте в ⚙ Настройки и сохраните.' }));
    $('settings').hidden = false;
  }
  $('out').replaceChildren(...box);
}

function group(list) {
  const add = (set, v) => [].concat(v == null ? [] : v).forEach(x => { if (x != null && String(x).trim()) set.add(String(x).trim()); });
  const types = new Map();
  list.forEach(a => {
    const type = a.type || (a.technologies || []).join(', ') || '(без типа)';
    const obj = a.object || '(пусто)';
    if (!types.has(type)) types.set(type, new Map());
    const objs = types.get(type);
    if (!objs.has(obj)) objs.set(obj, { obj, n: 0, src: new Set(), dst: new Set() });
    const g = objs.get(obj);
    g.n++; add(g.src, a.source); add(g.dst, a.destination);
  });
  return [...types].map(([type, objs]) => {
    const items = [...objs.values()].sort((a, b) => b.n - a.n);
    return { type, items, total: items.reduce((s, g) => s + g.n, 0) };
  }).sort((a, b) => b.total - a.total);
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = el('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  const t = btn.textContent; btn.textContent = 'Скопировано ✓';
  setTimeout(() => { btn.textContent = t; }, 1200);
}

function ipBlock(title, set) {
  const values = [...set], text = values.join('\n');
  const btn = el('button', { class: 'copy', text: 'Копировать' });
  btn.addEventListener('click', () => copy(text, btn));
  const box = el('textarea', { class: 'ips', readonly: true, rows: String(Math.min(Math.max(values.length, 1), 8)) });
  box.value = text;
  return el('div', { class: 'ipcol' }, [
    el('div', { class: 'iphead' }, [el('span', { text: title + ' (' + values.length + ')' }), values.length ? btn : null]),
    values.length ? box : el('div', { class: 'muted', text: 'нет' })
  ]);
}

function render(alerts) {
  $('title').textContent = 'Алерты: ' + alerts.length;
  $('sub').textContent = 'обновлено ' + new Date().toLocaleTimeString() + ' · статусы: ' + STATE.join(', ');
  const out = [];
  if (!alerts.length) out.push(el('div', { class: 'muted', text: 'Алертов нет.' }));
  group(alerts).forEach(g => {
    const td = el('details', { class: 'typed', open: true }, [
      el('summary', { class: 'tsum' }, [el('span', { class: 'type', text: g.type }), el('span', { class: 'cnt', text: String(g.total) })])
    ]);
    g.items.forEach(o => {
      const key = g.type + '\u0000' + o.obj;
      const d = el('details', { class: 'objd', open: openKeys.has(key) }, [
        el('summary', { class: 'row-obj' }, [el('span', { class: 'obj', text: o.obj }), el('span', { class: 'cnt', text: String(o.n) })]),
        el('div', { class: 'ipgrid' }, [ipBlock('Source', o.src), ipBlock('Destination', o.dst)])
      ]);
      d.addEventListener('toggle', () => { d.open ? openKeys.add(key) : openKeys.delete(key); });
      td.append(d);
    });
    out.push(td);
  });
  $('out').replaceChildren(...out);
}

loadSettings();
