if (!globalThis.FrictionExt) {
  document.body.innerHTML = '<p class="error">Extension failed to load. Reload.</p>';
  throw new Error('FrictionExt not available');
}
if (!globalThis.FRICTION_CONFIG?.API_BASE) {
  document.body.innerHTML = '<p class="error">Config not available.</p>';
  throw new Error('FRICTION_CONFIG not available');
}

const { getAuthToken, saveAuthToken, clearAuthToken, getTheme, saveTheme, fetchWithAuth } = globalThis.FrictionExt;
const API_BASE = globalThis.FRICTION_CONFIG?.API_BASE;
const WEB_APP_URL = globalThis.FRICTION_CONFIG?.WEB_APP_URL;

import { saveMoment, generateReport, loadFindings, updateFinding as apiUpdateFinding, checkConnection } from './api.js';

const momentInput = document.getElementById('moment');
const tokenInput = document.getElementById('token');
const saveTokenButton = document.getElementById('saveToken');
const saveButton = document.getElementById('save');
const generateButton = document.getElementById('generate');
const viewButton = document.getElementById('view');
const statusEl = document.getElementById('status');
const connEl = document.getElementById('conn');
const tokenSection = document.getElementById('tokenSection');
const logoutButton = document.getElementById('logout');
const themeToggle = document.getElementById('themeToggle');
const findingsList = document.getElementById('findingsList');
const statusChips = Array.from(document.querySelectorAll('.chip[data-status]'));
const searchInput = document.getElementById('search');
const refreshButton = document.getElementById('refreshFindings');
let statusTimer;
let currentStatus = 'unreviewed';
let allFindings = [];

function setStatus(message, tone = 'info') {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
  clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.dataset.tone = '';
    }, 2000);
  }
}

async function loadToken() {
  const token = await getAuthToken();
  if (token && tokenInput) {
    tokenInput.value = token;
  }
  updateAuthUI(Boolean(token));
}

async function loadTheme() {
  const theme = await getTheme();
  applyTheme(theme);
}

async function saveTokenHandler() {
  if (!tokenInput) return;
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus('Token required.', 'error');
    return;
  }
  await saveAuthToken(token);
  setStatus('Token saved.', 'success');
  updateAuthUI(true);
  await loadFindingsUI();
  await handleConnectionCheck();
}

async function saveMomentHandler() {
  if (!momentInput) return;
  const rawText = momentInput.value.trim();
  if (!rawText) {
    setStatus('Paste something first.', 'error');
    return;
  }

  setStatus('Saving...');

  const result = await saveMoment(rawText, 'bulk_paste');
  if (result.error === 'auth_expired') {
    if (tokenInput) tokenInput.value = '';
    updateAuthUI(false);
    setStatus('Token invalid. Login again.', 'error');
    await handleConnectionCheck();
    return;
  }
  if (result.error) {
    setStatus('Save failed.', 'error');
    await handleConnectionCheck();
    return;
  }

  momentInput.value = '';
  setStatus('Moment saved.', 'success');
  await loadFindingsUI();
  await handleConnectionCheck();
}

async function generateReportHandler() {
  const result = await generateReport();
  if (result.error === 'auth_expired') {
    if (tokenInput) tokenInput.value = '';
    updateAuthUI(false);
    setStatus('Token invalid. Login again.', 'error');
    await handleConnectionCheck();
    return;
  }
  if (!result.ok) {
    setStatus('Generation failed.', 'error');
    return;
  }

  chrome.tabs.create({ url: WEB_APP_URL });
  setStatus('Opened report.', 'success');
  await loadFindingsUI();
  await handleConnectionCheck();
}

function openReports() {
  chrome.tabs.create({ url: WEB_APP_URL });
}

async function logout() {
  await clearAuthToken();
  if (tokenInput) tokenInput.value = '';
  setStatus('Logged out.', 'success');
  updateAuthUI(false);
  renderFindings([]);
  await handleConnectionCheck();
}

function updateAuthUI(isAuthed) {
  document.body.classList.toggle('authed', isAuthed);
  if (logoutButton) {
    logoutButton.classList.toggle('hidden', !isAuthed);
  }
}

async function loadFindingsUI() {
  const result = await loadFindings(currentStatus);
  if (result.error === 'auth_expired') {
    if (tokenInput) tokenInput.value = '';
    updateAuthUI(false);
    renderFindings([]);
    return;
  }
  if (result.error) {
    allFindings = [];
    renderFindings([]);
    return;
  }
  allFindings = result.findings || [];
  renderFindings(allFindings);
}

function formatTimestamp(value) {
  if (!value) return '';
  return new Date(value);
}

function isToday(date) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return date >= startToday;
}

function isYesterday(date) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startYesterday.getDate() - 1);
  return date >= startYesterday && date < startToday;
}

function renderFinding(item) {
  const confidence = item.confidence_ai || item.confidence || '';
  return `
    <div class="finding">
      <div class="finding-head">
        <span class="badge ${item.type}">${item.type}</span>
        <span class="badge">${confidence}</span>
      </div>
      <div class="finding-title">${item.topic || 'Untitled'}</div>
      <div class="finding-summary">${item.summary || ''}</div>
      ${item.recall_anchor ? `<div class="finding-anchor">Recall: ${item.recall_anchor}</div>` : ''}
      <div class="finding-actions">
        ${currentStatus !== 'confirmed'
          ? `<button class="btn ghost tiny icon" data-action="confirm" data-id="${item.finding_id}" aria-label="Accept">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </button>`
          : ''
        }
        ${currentStatus !== 'deferred'
          ? `<button class="btn ghost tiny icon" data-action="defer" data-id="${item.finding_id}" aria-label="Ignore">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M5 5l14 14" />
              </svg>
            </button>`
          : ''
        }
        ${currentStatus === 'confirmed'
          ? `<button class="btn ghost tiny icon" data-action="resolve" data-id="${item.finding_id}" aria-label="Resolve">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M16 8l-5.5 7L8 12.5" />
              </svg>
            </button>`
          : ''
        }
      </div>
    </div>
  `;
}

function renderGroup(label, groupItems) {
  if (!groupItems.length) return '';
  return `
    <div class="finding-group">
      <div class="finding-group-title">${label} · ${groupItems.length}</div>
      ${groupItems.map(renderFinding).join('')}
    </div>
  `;
}

function renderFindings(items) {
  if (!findingsList) return;
  const now = new Date();
  const timeFiltered = items.filter((item) => {
    const ts = item.created_at || item.snapshot_created_at;
    if (!ts) return true;
    const date = new Date(ts);
    return isYesterday(date) || isToday(date);
  });
  const query = (searchInput && searchInput.value || '').trim().toLowerCase();
  const filtered = query
    ? timeFiltered.filter((item) => {
        const hay = `${item.topic || ''} ${item.summary || ''} ${item.recall_anchor || ''}`.toLowerCase();
        return hay.includes(query);
      })
    : timeFiltered;

  if (!filtered.length) {
    findingsList.innerHTML = '<div class="empty">No findings</div>';
    return;
  }

  const todayItems = filtered.filter((item) => {
    const ts = item.created_at || item.snapshot_created_at;
    if (!ts) return false;
    return isToday(new Date(ts));
  });

  const yesterdayItems = filtered.filter((item) => {
    const ts = item.created_at || item.snapshot_created_at;
    if (!ts) return false;
    return isYesterday(new Date(ts));
  });

  findingsList.innerHTML = `
    ${renderGroup('Today', todayItems)}
    ${renderGroup('Yesterday', yesterdayItems)}
  `;

  findingsList.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.action;
      const id = button.dataset.id;
      await handleUpdateFinding(id, action);
    });
  });
}

async function handleUpdateFinding(id, action) {
  const result = await apiUpdateFinding(id, action);
  if (result.error === 'auth_expired') {
    if (tokenInput) tokenInput.value = '';
    updateAuthUI(false);
    setStatus('Token invalid. Login again.', 'error');
    return;
  }
  if (!result.ok) {
    setStatus('Action failed.', 'error');
    return;
  }
  await loadFindingsUI();
}

async function toggleTheme() {
  const current = await getTheme();
  const next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
  await saveTheme(next);
  applyTheme(next);
  setStatus(`Theme: ${next}`, 'success');
}

function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark');
  if (theme === 'light') document.body.classList.add('theme-light');
  if (theme === 'dark') document.body.classList.add('theme-dark');
  if (themeToggle) themeToggle.textContent = theme === 'system' ? 'Theme' : theme;
}

async function handleConnectionCheck() {
  const result = await checkConnection();
  if (result.status === 'invalid_token') {
    connEl.textContent = 'Token invalid';
    connEl.classList.remove('connected');
    if (tokenInput) tokenInput.value = '';
    updateAuthUI(false);
  } else if (result.status === 'connected') {
    connEl.textContent = 'Connected';
    connEl.classList.add('connected');
  } else {
    connEl.textContent = 'Disconnected';
    connEl.classList.remove('connected');
  }
}

if (saveTokenButton) {
  saveTokenButton.addEventListener('click', saveTokenHandler);
}
if (saveButton) {
  saveButton.addEventListener('click', saveMomentHandler);
}
if (generateButton) {
  generateButton.addEventListener('click', generateReportHandler);
}
if (viewButton) {
  viewButton.addEventListener('click', openReports);
}
if (logoutButton) {
  logoutButton.addEventListener('click', logout);
}
if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
}

loadToken();
loadTheme();
loadFindingsUI();
handleConnectionCheck();

statusChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    statusChips.forEach((item) => item.classList.remove('active'));
    chip.classList.add('active');
    currentStatus = chip.dataset.status;
    loadFindingsUI();
  });
});

if (searchInput) {
  searchInput.addEventListener('input', () => renderFindings(allFindings));
}

if (refreshButton) {
  refreshButton.addEventListener('click', () => loadFindingsUI());
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.authToken) {
    loadToken();
    loadFindingsUI();
    handleConnectionCheck();
  }
});
