/* Dosi — promemoria farmaci locale, senza server e senza account. */

const STORAGE_KEY = 'dosi.meds.v1';
const HISTORY_KEY = 'dosi.history.v1';
const NOTIFIED_KEY = 'dosi.notified.v1'; // evita di notificare due volte la stessa dose
const GRACE_MINUTES = 30; // dopo quanto una dose non presa diventa "saltata"

const COLORS = ['#C1554B', '#C98A3D', '#6E8F72', '#3D7EA6', '#8464A8', '#5B6B70'];
const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

let meds = loadJSON(STORAGE_KEY, []);
let history = loadJSON(HISTORY_KEY, {}); // { 'YYYY-MM-DD': [ {medId, time, status, ts} ] }
let notified = loadJSON(NOTIFIED_KEY, {}); // { 'YYYY-MM-DD|medId|HH:MM': true }

let editingColor = COLORS[0];
let editingDays = new Set([0,1,2,3,4,5,6]);

// ---------- utils ----------
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveMeds() { localStorage.setItem(STORAGE_KEY, JSON.stringify(meds)); }
function saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
function saveNotified() { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified)); }

function uid() { return Math.random().toString(36).slice(2, 10); }
function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function timeStr(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function minutesOfDay(d) { return d.getHours()*60 + d.getMinutes(); }
function parseTimeToMinutes(t) { const [h,m] = t.split(':').map(Number); return h*60+m; }

function cleanupOld() {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffKey = dateKey(cutoff);
  for (const k of Object.keys(history)) if (k < cutoffKey) delete history[k];
  for (const k of Object.keys(notified)) {
    const day = k.split('|')[0];
    if (day < cutoffKey) delete notified[k];
  }
  saveHistory(); saveNotified();
}

// ---------- notifications & sound ----------
function updateNotifStatusChip() {
  const chip = document.getElementById('notif-status');
  if (!('Notification' in window)) {
    chip.textContent = 'Notifiche non supportate';
    chip.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    chip.textContent = '🔔 Notifiche attive';
    chip.disabled = true;
  } else if (Notification.permission === 'denied') {
    chip.textContent = '🔕 Notifiche bloccate';
    chip.disabled = true;
  } else {
    chip.textContent = 'Attiva notifiche';
    chip.disabled = false;
  }
}

function requestNotifPermission() {
  if (!('Notification' in window)) return;
  Notification.requestPermission().then(updateNotifStatusChip);
}

function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [880, 1174.7].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i*0.22);
      gain.gain.exponentialRampToValueAtTime(0.9, now + i*0.22 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i*0.22 + 0.7);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i*0.22);
      osc.stop(now + i*0.22 + 0.75);
    });
  } catch (e) { /* audio non disponibile, si ignora silenziosamente */ }
}

function fireReminder(med, time) {
  playChime();
  showToast(med, time);
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`È ora di ${med.name}`, {
      body: med.dose ? `${med.dose} · ore ${time}` : `Ore ${time}`,
      tag: `${med.id}-${time}`,
      requireInteraction: true
    });
    n.onclick = () => { window.focus(); n.close(); };
  }
}

function showToast(med, time) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>💊 <strong>${escapeHtml(med.name)}</strong> — ore ${time}${med.dose ? ' · ' + escapeHtml(med.dose) : ''}</span>`;
  const btn = document.createElement('button');
  btn.textContent = 'Segna presa';
  btn.onclick = () => { markTaken(med.id, time); el.remove(); };
  el.appendChild(btn);
  root.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 45000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- schedule logic ----------
function isScheduledToday(med, date) {
  const dow = date.getDay();
  return med.days.includes(dow);
}

function todaysDoses(date = new Date()) {
  // ritorna array {med, time, minutes, status}
  const key = dateKey(date);
  const dayHistory = history[key] || [];
  const nowMin = minutesOfDay(date);
  const out = [];
  for (const med of meds) {
    if (!isScheduledToday(med, date)) continue;
    for (const time of med.times) {
      const minutes = parseTimeToMinutes(time);
      const entry = dayHistory.find(h => h.medId === med.id && h.time === time);
      let status;
      if (entry) status = entry.status;
      else if (nowMin < minutes - med.lead) status = 'upcoming';
      else if (nowMin < minutes + GRACE_MINUTES) status = 'due';
      else status = 'missed';
      out.push({ med, time, minutes, status });
    }
  }
  out.sort((a,b) => a.minutes - b.minutes);
  return out;
}

function checkReminders() {
  const now = new Date();
  const key = dateKey(now);
  const nowMin = minutesOfDay(now);
  for (const med of meds) {
    if (!isScheduledToday(med, now)) continue;
    for (const time of med.times) {
      const minutes = parseTimeToMinutes(time);
      const target = minutes - (med.lead || 0);
      const notifiedKey = `${key}|${med.id}|${time}`;
      if (nowMin >= target && nowMin < target + 1 && !notified[notifiedKey]) {
        notified[notifiedKey] = true;
        saveNotified();
        fireReminder(med, time);
      }
    }
  }
}

function markTaken(medId, time) {
  const key = dateKey(new Date());
  if (!history[key]) history[key] = [];
  const existing = history[key].find(h => h.medId === medId && h.time === time);
  if (existing) { existing.status = 'taken'; existing.ts = new Date().toISOString(); }
  else history[key].push({ medId, time, status: 'taken', ts: new Date().toISOString() });
  saveHistory();
  renderAll();
}

function markMissed(medId, time) {
  const key = dateKey(new Date());
  if (!history[key]) history[key] = [];
  const existing = history[key].find(h => h.medId === medId && h.time === time);
  if (existing) { existing.status = 'missed'; }
  else history[key].push({ medId, time, status: 'missed', ts: new Date().toISOString() });
  saveHistory();
  renderAll();
}

function snoozeDose(medId, time) {
  // ri-notifica tra 10 minuti azzerando il flag "notified" a un orario fittizio +10
  const now = new Date();
  const target = new Date(now.getTime() + 10*60000);
  const fakeKey = `${dateKey(now)}|${medId}|${time}`;
  // rimuove il flag cosi al prossimo giro utile potremo ri-triggerare manualmente
  setTimeout(() => {
    const med = meds.find(m => m.id === medId);
    if (med) fireReminder(med, time);
  }, 10*60000);
  showToast({ name: 'Promemoria rimandato', dose: '' }, timeStr(target));
}

// ---------- rendering ----------
function renderClock() {
  document.getElementById('now-clock').textContent = timeStr(new Date());
  document.getElementById('today-label').textContent = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}

function renderTimeline() {
  const el = document.getElementById('timeline');
  el.innerHTML = '';
  const now = new Date();
  const nowMin = minutesOfDay(now);
  const nowLine = document.createElement('div');
  nowLine.className = 'tl-now';
  nowLine.style.left = `${(nowMin/1440)*100}%`;
  el.appendChild(nowLine);

  for (const dose of todaysDoses(now)) {
    const dot = document.createElement('div');
    dot.className = `tl-dose status-${dose.status}`;
    dot.style.left = `${(dose.minutes/1440)*100}%`;
    dot.style.background = dose.med.color;
    if (dose.status !== 'taken') dot.style.background = dose.med.color;
    dot.title = `${dose.med.name} · ${dose.time}`;
    el.appendChild(dot);
  }
}

function renderNextDose() {
  const el = document.getElementById('next-dose-card');
  const doses = todaysDoses().filter(d => d.status === 'upcoming' || d.status === 'due');
  if (doses.length === 0) {
    el.className = 'card next-dose-card empty';
    el.innerHTML = meds.length ? 'Nessun\'altra dose prevista per oggi. 🎉' : 'Aggiungi un farmaco per iniziare.';
    return;
  }
  const next = doses[0];
  const now = new Date();
  const diff = next.minutes - minutesOfDay(now);
  const diffLabel = next.status === 'due'
    ? 'Da prendere ora'
    : (diff >= 60 ? `tra ${Math.floor(diff/60)}h ${diff%60}m` : `tra ${diff} min`);

  el.className = 'card next-dose-card';
  el.innerHTML = `
    <div class="nd-left">
      <div class="nd-swatch" style="background:${next.med.color}"></div>
      <div>
        <p class="nd-name">${escapeHtml(next.med.name)}</p>
        <p class="nd-meta">${escapeHtml(next.med.dose || '')} ${next.med.dose ? '·' : ''} ore ${next.time}</p>
      </div>
    </div>
    <div class="nd-right" style="display:flex; align-items:center; gap:14px;">
      <span class="nd-countdown">${diffLabel}</span>
      <div class="nd-actions">
        <button class="btn btn-ghost btn-small" data-action="snooze">Rimanda 10'</button>
        <button class="btn btn-primary btn-small" data-action="taken">Segna presa</button>
      </div>
    </div>
  `;
  el.querySelector('[data-action="taken"]').onclick = () => markTaken(next.med.id, next.time);
  el.querySelector('[data-action="snooze"]').onclick = () => snoozeDose(next.med.id, next.time);
}

function renderMedsList() {
  const list = document.getElementById('meds-list');
  const empty = document.getElementById('empty-state');
  list.innerHTML = '';
  if (meds.length === 0) { empty.hidden = false; return; }
  empty.hidden = true;
  for (const med of meds) {
    const card = document.createElement('div');
    card.className = 'med-card';
    const daysLabel = med.days.length === 7 ? 'Tutti i giorni' : med.days.map(d => DAY_LABELS[d]).join(', ');
    card.innerHTML = `
      <div class="med-swatch" style="background:${med.color}"></div>
      <div class="med-info">
        <p class="med-name">${escapeHtml(med.name)}</p>
        <p class="med-dose">${escapeHtml(med.dose || '')} ${med.dose ? '· ' : ''}${daysLabel}</p>
        <div class="med-times">${med.times.map(t => `<span class="time-tag">${t}</span>`).join('')}</div>
      </div>
    `;
    card.onclick = () => openPanel(med);
    list.appendChild(card);
  }
}

function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  const key = dateKey(new Date());
  const entries = (history[key] || []).slice().sort((a,b) => a.time.localeCompare(b.time));
  if (entries.length === 0) {
    list.innerHTML = '<li class="history-empty">Ancora nessuna dose registrata oggi.</li>';
    return;
  }
  for (const e of entries) {
    const med = meds.find(m => m.id === e.medId);
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <span class="h-time">${e.time}</span>
      <span>${escapeHtml(med ? med.name : 'Farmaco rimosso')}</span>
      <span class="h-status ${e.status}">${e.status === 'taken' ? 'Presa' : 'Saltata'}</span>
    `;
    list.appendChild(li);
  }
}

function renderAll() {
  renderClock();
  renderTimeline();
  renderNextDose();
  renderMedsList();
  renderHistory();
}

// ---------- panel (add/edit) ----------
function buildColorPicker() {
  const wrap = document.getElementById('color-picker');
  wrap.innerHTML = '';
  for (const c of COLORS) {
    const sw = document.createElement('div');
    sw.className = 'color-swatch' + (c === editingColor ? ' selected' : '');
    sw.style.background = c;
    sw.onclick = () => { editingColor = c; buildColorPicker(); };
    wrap.appendChild(sw);
  }
}

function buildDaysPicker() {
  const wrap = document.getElementById('days-picker');
  wrap.innerHTML = '';
  DAY_LABELS.forEach((label, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-toggle' + (editingDays.has(i) ? ' active' : '');
    btn.textContent = label;
    btn.onclick = () => {
      if (editingDays.has(i)) editingDays.delete(i); else editingDays.add(i);
      buildDaysPicker();
    };
    wrap.appendChild(btn);
  });
}

function addTimeRow(value = '08:00') {
  const wrap = document.getElementById('times-list');
  const row = document.createElement('div');
  row.className = 'time-row';
  row.innerHTML = `<input type="time" value="${value}" required>
    <button type="button" class="remove-time" aria-label="Rimuovi orario">✕</button>`;
  row.querySelector('.remove-time').onclick = () => {
    if (wrap.children.length > 1) row.remove();
  };
  wrap.appendChild(row);
}

function openPanel(med = null) {
  document.getElementById('overlay').hidden = false;
  document.getElementById('med-panel').hidden = false;
  document.getElementById('panel-title').textContent = med ? 'Modifica farmaco' : 'Nuovo farmaco';
  document.getElementById('med-id').value = med ? med.id : '';
  document.getElementById('med-name').value = med ? med.name : '';
  document.getElementById('med-dose').value = med ? med.dose : '';
  document.getElementById('med-lead').value = med ? String(med.lead) : '0';
  document.getElementById('delete-med-btn').hidden = !med;

  editingColor = med ? med.color : COLORS[meds.length % COLORS.length];
  editingDays = new Set(med ? med.days : [0,1,2,3,4,5,6]);
  buildColorPicker();
  buildDaysPicker();

  document.getElementById('times-list').innerHTML = '';
  (med ? med.times : ['08:00']).forEach(t => addTimeRow(t));

  document.getElementById('med-name').focus();
}

function closePanel() {
  document.getElementById('overlay').hidden = true;
  document.getElementById('med-panel').hidden = true;
}

function handleFormSubmit(ev) {
  ev.preventDefault();
  const id = document.getElementById('med-id').value || uid();
  const name = document.getElementById('med-name').value.trim();
  const dose = document.getElementById('med-dose').value.trim();
  const lead = Number(document.getElementById('med-lead').value);
  const times = Array.from(document.querySelectorAll('#times-list input[type=time]'))
    .map(i => i.value).filter(Boolean).sort();
  const days = Array.from(editingDays).sort();

  if (!name || times.length === 0 || days.length === 0) return;

  const med = { id, name, dose, color: editingColor, times, days, lead };
  const idx = meds.findIndex(m => m.id === id);
  if (idx >= 0) meds[idx] = med; else meds.push(med);
  saveMeds();
  closePanel();
  renderAll();
  scheduleAllNativeNotifications();
}

function handleDelete() {
  const id = document.getElementById('med-id').value;
  if (!id) return;
  if (!confirm('Eliminare questo farmaco? Verrà rimosso anche dalla cronologia futura.')) return;
  meds = meds.filter(m => m.id !== id);
  saveMeds();
  closePanel();
  renderAll();
  scheduleAllNativeNotifications();
}

// ---------- notifiche native (solo dentro l'app Capacitor, ignorato nel browser) ----------
function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

async function scheduleAllNativeNotifications() {
  if (!isNativeApp()) return;
  const { LocalNotifications } = window.Capacitor.Plugins;
  try {
    await LocalNotifications.requestPermissions();
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length) {
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
    const notifications = [];
    let id = 1;
    for (const med of meds) {
      for (const time of med.times) {
        const [h, m] = time.split(':').map(Number);
        notifications.push({
          id: id++,
          title: `È ora di ${med.name}`,
          body: med.dose ? `${med.dose} · ore ${time}` : `Ore ${time}`,
          schedule: { on: { hour: h, minute: m }, repeats: true }
        });
      }
    }
    if (notifications.length) await LocalNotifications.schedule({ notifications });
  } catch (e) { /* plugin non disponibile: si ignora, resta il fallback browser */ }
}
// NOTA: questa pianificazione ripete ogni giorno alla stessa ora e non filtra
// ancora per i giorni della settimana scelti nel farmaco: è un punto di
// partenza da raffinare se servono giorni specifici.

// ---------- init ----------
function init() {
  cleanupOld();
  updateNotifStatusChip();

  document.getElementById('notif-status').onclick = requestNotifPermission;
  document.getElementById('add-med-btn').onclick = () => openPanel();
  document.getElementById('empty-add-btn').onclick = () => openPanel();
  document.getElementById('panel-close').onclick = closePanel;
  document.getElementById('overlay').onclick = closePanel;
  document.getElementById('add-time-btn').onclick = () => addTimeRow();
  document.getElementById('med-form').onsubmit = handleFormSubmit;
  document.getElementById('delete-med-btn').onclick = handleDelete;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  renderAll();
  checkReminders();
  scheduleAllNativeNotifications();
  setInterval(() => { renderAll(); checkReminders(); }, 20000);
  setInterval(renderClock, 1000);

  if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
