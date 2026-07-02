if (!globalThis.FrictionExt) {
  document.body.innerHTML = '<p class="error">Extension failed to load. Reload.</p>';
  throw new Error('FrictionExt not available');
}
if (!globalThis.FRICTION_CONFIG?.API_BASE) {
  document.body.innerHTML = '<p class="error">Config not available.</p>';
  throw new Error('FRICTION_CONFIG not available');
}

const { getAuthToken, saveAuthToken, clearAuthToken, getTheme, saveTheme } = globalThis.FrictionExt;
const API_BASE = globalThis.FRICTION_CONFIG?.API_BASE;
const WEB_APP_URL = globalThis.FRICTION_CONFIG?.WEB_APP_URL;

import { saveMoment, generateReport, checkConnection, loadMomentCount } from './api.js';

const momentInput = document.getElementById('moment');
const tokenInput = document.getElementById('token');
const saveTokenButton = document.getElementById('saveToken');
const saveButton = document.getElementById('save');
const generateButton = document.getElementById('generate');
const viewButton = document.getElementById('view');
const statusEl = document.getElementById('status');
const connDot = document.getElementById('connDot');
const tokenSection = document.getElementById('tokenSection');
const settingsButton = document.getElementById('settings');
const menuButton = document.getElementById('menu');
const menuDropdown = document.getElementById('menuDropdown');
const openWebButton = document.getElementById('openWeb');
const menuLogoutButton = document.getElementById('menuLogout');
const subtitleEl = document.querySelector('.subtitle');
const autoCaptureToggle = document.getElementById('autoCaptureToggle');
const autoCaptureSettings = document.getElementById('autoCaptureSettings');
const siteChatgpt = document.getElementById('siteChatgpt');
const siteGemini = document.getElementById('siteGemini');
let statusTimer;
let connInterval;
let menuOpen = false;

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
  if (token) {
    tokenInput.value = token;
  }
  updateAuthUI(Boolean(token));
}

async function loadTheme() {
  const theme = await getTheme();
  applyTheme(theme);
}

async function saveToken() {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus('Token required.', 'error');
    return;
  }
  await saveAuthToken(token);
  setStatus('Token saved.', 'success');
  updateAuthUI(true);
  await checkConnection();
  await loadMomentCountUI();
}

async function saveMomentHandler() {
  const rawText = momentInput.value.trim();
  if (!rawText) {
    setStatus('Paste something first.', 'error');
    return;
  }

  setStatus('Saving...');

  const result = await saveMoment(rawText);
  if (result.error === 'auth_expired') {
    tokenInput.value = '';
    updateAuthUI(false);
    setStatus('Token invalid. Login again.', 'error');
    await checkConnection();
    return;
  }
  if (result.error) {
    setStatus('Save failed.', 'error');
    await checkConnection();
    return;
  }

  momentInput.value = '';
  setStatus('Moment saved.', 'success');
  await checkConnection();
  await loadMomentCountUI();
}

async function generateReportHandler() {
  const result = await generateReport();
  if (result.error === 'auth_expired') {
    tokenInput.value = '';
    updateAuthUI(false);
    setStatus('Token invalid. Login again.', 'error');
    await checkConnection();
    return;
  }
  if (!result.ok) {
    setStatus('Generation failed.', 'error');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
  setStatus('Opened report.', 'success');
  await checkConnection();
}

function openReports() {
  chrome.tabs.create({ url: WEB_APP_URL, active: true });
}

async function logout() {
  await clearAuthToken();
  tokenInput.value = '';
  setStatus('Logged out.', 'success');
  updateAuthUI(false);
  await checkConnection();
}

function updateAuthUI(isAuthed) {
  document.body.classList.toggle('authed', isAuthed);
  if (tokenSection) {
    tokenSection.classList.toggle('hidden', isAuthed);
  }
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
  if (settingsButton) settingsButton.title = theme === 'system' ? 'Theme: System' : `Theme: ${theme}`;
}

async function loadMomentCountUI() {
  const result = await loadMomentCount();
  if (result.count > 0) {
    subtitleEl.textContent = `${result.count} moment${result.count !== 1 ? 's' : ''} saved today`;
  } else {
    subtitleEl.textContent = '';
  }
}

async function loadAutoCaptureSettings() {
  const settings = await chrome.storage.local.get([
    'autoCapture',
    'captureMode',
    'autoCaptureSites'
  ]);

  if (autoCaptureToggle) {
    autoCaptureToggle.checked = settings.autoCapture || false;
  }
  if (settings.captureMode) {
    const modeRadio = document.querySelector(`input[name="captureMode"][value="${settings.captureMode}"]`);
    if (modeRadio) modeRadio.checked = true;
  }
  if (settings.autoCaptureSites) {
    if (siteChatgpt) siteChatgpt.checked = settings.autoCaptureSites.chatgpt !== false;
    if (siteGemini) siteGemini.checked = settings.autoCaptureSites.gemini !== false;
  }

  updateAutoCaptureVisibility();
}

function updateAutoCaptureVisibility() {
  if (autoCaptureSettings) {
    autoCaptureSettings.classList.toggle('hidden', !autoCaptureToggle?.checked);
  }
}

async function saveAutoCaptureSettings() {
  const settings = {
    autoCapture: autoCaptureToggle?.checked || false,
    captureMode: document.querySelector('input[name="captureMode"]:checked')?.value || 'whole_convo',
    autoCaptureSites: {
      chatgpt: siteChatgpt?.checked !== false,
      gemini: siteGemini?.checked !== false
    }
  };

  await chrome.storage.local.set(settings);
  updateAutoCaptureVisibility();
}

async function handleConnectionCheck() {
  const result = await checkConnection();
  if (result.status === 'invalid_token') {
    connDot.className = 'conn-dot invalid';
  } else if (result.status === 'connected') {
    connDot.className = 'conn-dot connected';
  } else {
    connDot.className = 'conn-dot';
  }
}

function startConnectionPolling() {
  handleConnectionCheck();
  connInterval = setInterval(handleConnectionCheck, 30000);
}

function stopConnectionPolling() {
  clearInterval(connInterval);
}

saveTokenButton.addEventListener('click', saveToken);
saveButton.addEventListener('click', saveMomentHandler);
generateButton.addEventListener('click', generateReportHandler);
viewButton.addEventListener('click', openReports);
settingsButton.addEventListener('click', toggleTheme);
menuButton.addEventListener('click', (e) => {
  e.stopPropagation();
  menuOpen = !menuOpen;
  menuDropdown.classList.toggle('hidden', !menuOpen);
});
openWebButton.addEventListener('click', () => {
  openReports();
  menuOpen = false;
  menuDropdown.classList.add('hidden');
});
menuLogoutButton.addEventListener('click', async () => {
  await logout();
  menuOpen = false;
  menuDropdown.classList.add('hidden');
});

if (autoCaptureToggle) {
  autoCaptureToggle.addEventListener('change', saveAutoCaptureSettings);
}
if (autoCaptureSettings) {
  autoCaptureSettings.addEventListener('change', saveAutoCaptureSettings);
}

document.addEventListener('click', (e) => {
  if (menuOpen && !menuDropdown.contains(e.target) && !menuButton.contains(e.target)) {
    menuOpen = false;
    menuDropdown.classList.add('hidden');
  }
});

async function init() {
  await loadToken();
  await loadTheme();
  await loadMomentCountUI();
  await loadAutoCaptureSettings();
  startConnectionPolling();
}

init();
window.addEventListener('unload', stopConnectionPolling);
