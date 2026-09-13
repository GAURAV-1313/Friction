// Anchor popup (ES module). Requires config.js and anchor-setup.js (classic
// scripts) to have run first. Every piece of text is set through textContent.
import * as api from './api.js';

function fatal(message) {
  document.body.textContent = '';
  const p = document.createElement('p');
  p.className = 'error';
  p.textContent = message;
  document.body.appendChild(p);
  throw new Error(message);
}

if (!globalThis.AnchorExt) fatal('Extension failed to load. Reload it from chrome://extensions.');
if (!globalThis.ANCHOR_CONFIG?.API_BASE) fatal('Config not available.');

const Ext = globalThis.AnchorExt;
const CFG = globalThis.ANCHOR_CONFIG;
const LC_ORIGIN = 'https://leetcode.com/';
const STATUS_MS = 2000;
const CONN_POLL_MS = 30000;
const DELETE_ARM_MS = 6000;
const LOCAL_KEYS_CLEARED_ON_DELETE = ['profileSummary', 'syncState', 'problemsSent', 'postQueue', 'captureStats'];

const $ = (id) => document.getElementById(id);
const els = {
  subtitle: $('subtitle'),
  connDot: $('connDot'),
  themeToggle: $('themeToggle'),
  tokenSection: $('tokenSection'),
  token: $('token'),
  saveToken: $('saveToken'),
  getToken: $('getToken'),
  openPanel: $('openPanel'),
  panelHint: $('panelHint'),
  consentToggle: $('consentToggle'),
  langEnglish: $('langEnglish'),
  langHinglish: $('langHinglish'),
  rowVersion: $('rowVersion'),
  rowSync: $('rowSync'),
  rowCapture: $('rowCapture'),
  rowHints: $('rowHints'),
  issueText: $('issueText'),
  sendIssue: $('sendIssue'),
  forgetToken: $('forgetToken'),
  deleteData: $('deleteData'),
  status: $('status')
};

let statusTimer = null;
let connTimer = null;
let deleteArmedAt = 0;
let deleteTimer = null;
let activeTab = null;

// ---------------------------------------------------------------------------
// status + theme
// ---------------------------------------------------------------------------
function setStatus(message, tone = 'info') {
  els.status.textContent = message || '';
  els.status.dataset.tone = tone;
  clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => {
      els.status.textContent = '';
      els.status.dataset.tone = '';
    }, STATUS_MS);
  }
}

function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark');
  if (theme === 'light') document.body.classList.add('theme-light');
  if (theme === 'dark') document.body.classList.add('theme-dark');
  els.themeToggle.title = theme === 'system' ? 'Theme: System' : `Theme: ${theme}`;
}

async function toggleTheme() {
  const current = await Ext.getTheme();
  const next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
  await Ext.saveTheme(next);
  applyTheme(next);
  setStatus(`Theme: ${next}`, 'success');
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
  } catch (_) {
    activeTab = null;
  }
  return activeTab;
}

function isLeetCodeTab(tab) {
  return Boolean(tab && typeof tab.url === 'string' && tab.url.startsWith(LC_ORIGIN));
}

function isProblemTab(tab) {
  return isLeetCodeTab(tab) && tab.url.startsWith(`${LC_ORIGIN}problems/`);
}

async function refreshPanelButton() {
  const tab = activeTab || (await getActiveTab());
  const ok = isLeetCodeTab(tab);
  els.openPanel.disabled = !ok;
  els.panelHint.classList.toggle('hidden', ok);
}

async function openPanel() {
  const tab = await getActiveTab();
  if (!isLeetCodeTab(tab) || !tab.id) {
    await refreshPanelButton();
    setStatus('Open a leetcode.com problem first.', 'error');
    return;
  }
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } catch (err) {
    setStatus('Could not open the panel.', 'error');
  }
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
function updateAuthUI(isAuthed) {
  document.body.classList.toggle('authed', isAuthed);
  els.tokenSection.classList.toggle('hidden', isAuthed);
}

function setDot(state, title) {
  els.connDot.className = state ? `conn-dot ${state}` : 'conn-dot';
  els.connDot.title = title || '';
}

function looksLikeJwt(token) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

async function saveToken() {
  const token = els.token.value.trim();
  if (!token) {
    setStatus('Token required.', 'error');
    return;
  }
  if (!looksLikeJwt(token)) {
    setStatus('That does not look like a token.', 'error');
    return;
  }
  await Ext.saveAuthToken(token);
  els.token.value = '';
  updateAuthUI(true);
  setStatus('Token saved.', 'success');
  await handleConnectionCheck();
}

async function forgetToken() {
  await Ext.clearAuthToken();
  updateAuthUI(false);
  setDot('', 'No token');
  els.subtitle.textContent = 'for LeetCode';
  setStatus('Token removed.', 'success');
}

function openWebApp() {
  chrome.tabs.create({ url: CFG.WEB_APP_URL, active: true });
}

// ---------------------------------------------------------------------------
// /api/lc/me -> header, rows, local mirrors
// ---------------------------------------------------------------------------
function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

async function applyMe(data) {
  const profile = (data && data.profile) || {};
  const user = (data && data.user) || {};
  const counts = (data && data.counts) || {};
  const username = profile.leetcode_username || user.username || user.name || user.email || '';
  const solved = firstNumber(counts.solved, data && data.skill_summary && data.skill_summary.solved, profile.solved);
  const syncedAt = profile.last_synced_at || profile.synced_at || null;
  const hints = (data && data.hints) || {};
  const hintsToday = firstNumber(hints.today, data && data.hints_today, profile.hints_today);
  const hintsCap = firstNumber(hints.cap, data && data.hints_cap, data && data.daily_cap);

  if (username && solved !== null) {
    els.subtitle.textContent = `${username} · ${solved} solved`;
  } else if (username) {
    els.subtitle.textContent = `${username} · not synced yet`;
  } else if (solved !== null) {
    els.subtitle.textContent = `${solved} solved`;
  } else {
    els.subtitle.textContent = 'Connected · not synced yet';
  }

  els.rowHints.textContent = hintsToday === null ? '—' : hintsCap === null ? String(hintsToday) : `${hintsToday} / ${hintsCap}`;

  const stored = await chrome.storage.local.get(['profileSummary', 'consentCode', 'language']);
  const summary = stored.profileSummary && typeof stored.profileSummary === 'object' ? stored.profileSummary : {};
  const patch = {
    profileSummary: {
      ...summary,
      username: username || summary.username || null,
      solved: solved !== null ? solved : summary.solved === undefined ? null : summary.solved,
      synced_at: syncedAt || summary.synced_at || null,
      sync_status: profile.sync_status || summary.sync_status || null,
      checkedAt: Date.now()
    }
  };
  // The server is the source of truth for consent and language.
  if (typeof profile.consent_code !== 'undefined' && profile.consent_code !== null) {
    const consent = profile.consent_code === true || profile.consent_code === 1;
    if (stored.consentCode !== consent) patch.consentCode = consent;
  }
  if (profile.language === 'english' || profile.language === 'hinglish') {
    if (stored.language !== profile.language) patch.language = profile.language;
  }
  await chrome.storage.local.set(patch);
}

async function handleConnectionCheck() {
  const token = await Ext.getAuthToken();
  if (!token) {
    updateAuthUI(false);
    setDot('', 'No token');
    els.subtitle.textContent = 'for LeetCode';
    return;
  }
  updateAuthUI(true);
  const result = await api.me();
  if (result.ok) {
    setDot('connected', 'Connected');
    await applyMe(result.data);
    return;
  }
  if (result.status === 401) {
    setDot('invalid', 'Token expired');
    updateAuthUI(false);
    setStatus('Token expired, paste a new one.', 'error');
    return;
  }
  if (result.status === 403) {
    setDot('invalid', 'Access denied');
    setStatus(result.error === 'pilot_closed' ? 'This account is not in the pilot.' : 'Access denied.', 'error');
    return;
  }
  if (result.status === 426) {
    setDot('invalid', 'Update required');
    setStatus('Update the extension to keep using Anchor.', 'error');
    return;
  }
  if (result.status === 0) {
    setDot('waking', result.error === 'timeout' ? 'Server waking up' : 'Server unreachable');
    return;
  }
  setDot('', `Server error ${result.status}`);
}

function startConnectionPolling() {
  handleConnectionCheck();
  connTimer = setInterval(handleConnectionCheck, CONN_POLL_MS);
}

function stopConnectionPolling() {
  clearInterval(connTimer);
}

// ---------------------------------------------------------------------------
// consent + language
// ---------------------------------------------------------------------------
async function onConsentChange() {
  const wanted = els.consentToggle.checked;
  const previous = await Ext.getConsent();
  els.consentToggle.disabled = true;
  const result = await api.putProfile({ consent_code: wanted });
  els.consentToggle.disabled = false;
  if (!result.ok) {
    els.consentToggle.checked = previous;
    setStatus(result.error === 'missing_token' || result.status === 401 ? 'Paste a token first.' : 'Could not save.', 'error');
    return;
  }
  await Ext.setConsent(wanted);
  setStatus(wanted ? 'Code sharing on.' : 'Code sharing off. Stored code deleted.', 'success');
}

function renderLanguage(language) {
  const current = language === 'hinglish' ? 'hinglish' : 'english';
  for (const button of [els.langEnglish, els.langHinglish]) {
    const active = button.dataset.lang === current;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  }
}

async function onLanguageClick(event) {
  const language = event.currentTarget.dataset.lang;
  const previous = await Ext.getLanguage();
  if (language === previous) return;
  renderLanguage(language);
  const result = await api.putProfile({ language });
  if (!result.ok) {
    renderLanguage(previous);
    setStatus(result.error === 'missing_token' || result.status === 401 ? 'Paste a token first.' : 'Could not save.', 'error');
    return;
  }
  await Ext.setLanguage(language);
  setStatus(language === 'hinglish' ? 'Hints in Hinglish.' : 'Hints in English.', 'success');
}

async function loadControls() {
  els.consentToggle.checked = await Ext.getConsent();
  renderLanguage(await Ext.getLanguage());
}

// ---------------------------------------------------------------------------
// settings rows
// ---------------------------------------------------------------------------
function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1e11 ? n : n * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRelative(value, now = Date.now()) {
  const ts = parseTime(value);
  if (ts === null) return 'never';
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

function describeCapture(ctx) {
  if (!ctx) return 'no problem open';
  if (ctx.needsReload) return 'reload the tab';
  if (ctx.isContest) return 'off (contest)';
  const capture = ctx.capture;
  if (!capture) return ctx.slug ? 'waiting' : 'not a problem page';
  const state = typeof capture === 'string' ? capture : capture.state || capture.capture || (capture.active === true ? 'active' : capture.active === false ? 'disabled' : '');
  if (state === 'active' || state === 'ready' || state === 'on') return 'on';
  if (state === 'disabled' || state === 'off' || state === 'error') {
    const reason = typeof capture === 'object' && capture.reason ? String(capture.reason) : '';
    return reason ? `off (${reason})` : 'off';
  }
  return state ? String(state) : 'waiting';
}

async function refreshCaptureRow() {
  const tab = activeTab || (await getActiveTab());
  if (!isLeetCodeTab(tab)) {
    els.rowCapture.textContent = 'not a LeetCode tab';
    return;
  }
  if (!isProblemTab(tab)) {
    els.rowCapture.textContent = 'not a problem page';
    return;
  }
  let ctx = null;
  try {
    const key = `tab:${tab.id}`;
    ctx = (await chrome.storage.session.get([key]))[key] || null;
  } catch (_) {
    ctx = null;
  }
  els.rowCapture.textContent = describeCapture(ctx);
}

async function refreshRows() {
  els.rowVersion.textContent = CFG.ENV === 'production' ? CFG.EXT_VERSION : `${CFG.EXT_VERSION} · ${CFG.ENV}`;
  const stored = await chrome.storage.local.get(['profileSummary']);
  const summary = stored.profileSummary || {};
  els.rowSync.textContent = formatRelative(summary.synced_at);
  await refreshCaptureRow();
}

// ---------------------------------------------------------------------------
// delete my data (two clicks)
// ---------------------------------------------------------------------------
function disarmDelete() {
  deleteArmedAt = 0;
  clearTimeout(deleteTimer);
  els.deleteData.textContent = 'Delete my data';
  els.deleteData.classList.remove('armed');
}

async function onDeleteClick() {
  const now = Date.now();
  if (!deleteArmedAt || now - deleteArmedAt > DELETE_ARM_MS) {
    deleteArmedAt = now;
    els.deleteData.textContent = 'Click again to delete everything';
    els.deleteData.classList.add('armed');
    setStatus('Removes your synced history, habits and chats from Anchor.', 'error');
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(disarmDelete, DELETE_ARM_MS);
    return;
  }
  disarmDelete();
  els.deleteData.disabled = true;
  setStatus('Deleting…');
  const result = await api.deleteMe();
  els.deleteData.disabled = false;
  if (!result.ok) {
    if (result.status === 401 || result.error === 'missing_token') {
      setStatus('Paste a token first.', 'error');
    } else {
      setStatus('Delete failed. Try again.', 'error');
    }
    return;
  }
  await chrome.storage.local.remove(LOCAL_KEYS_CLEARED_ON_DELETE);
  await Ext.setConsent(false); // the server no longer holds a consent row
  els.consentToggle.checked = false;
  els.subtitle.textContent = 'Connected · not synced yet';
  els.rowHints.textContent = '—';
  await refreshRows();
  setStatus('Deleted', 'success');
}

// ---------------------------------------------------------------------------
// report an issue (client event; never includes code)
// ---------------------------------------------------------------------------
async function sendIssue() {
  const text = els.issueText.value.trim();
  if (!text) {
    setStatus('Write something first.', 'error');
    return;
  }
  const tab = await getActiveTab();
  const payload = {
    text: text.slice(0, 1000), // the server caps the whole payload at 4096 UTF-8 bytes
    url: isLeetCodeTab(tab) ? tab.url.slice(0, 500) : null,
    theme: await Ext.getTheme(),
    language: await Ext.getLanguage(),
    consent_code: await Ext.getConsent(),
    ua: navigator.userAgent.slice(0, 200)
  };
  els.sendIssue.disabled = true;
  const result = await api.clientEvent('issue_report', payload);
  els.sendIssue.disabled = false;
  if (result.ok) {
    els.issueText.value = '';
    setStatus('Sent. Thank you.', 'success');
    return;
  }
  if (result.error === 'missing_token' || result.status === 401) {
    setStatus('Paste a token first.', 'error');
    return;
  }
  if (result.error === 'payload_too_large') {
    setStatus('Report too long. Shorten it and send again.', 'error');
    return;
  }
  // Offline or server down: hand it to the background queue.
  try {
    const queued = await chrome.runtime.sendMessage({ type: 'client:event', event: 'issue_report', detail: payload });
    if (queued && queued.ok) {
      els.issueText.value = '';
      setStatus('Queued. It will send when online.', 'success');
      return;
    }
  } catch (_) {
    // fall through
  }
  setStatus('Could not send.', 'error');
}

// ---------------------------------------------------------------------------
// storage reactions
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.authToken) {
      const has = Boolean(changes.authToken.newValue);
      updateAuthUI(has);
      if (has) handleConnectionCheck();
      else setDot('', 'No token');
    }
    if (changes.consentCode) els.consentToggle.checked = changes.consentCode.newValue === true;
    if (changes.language) renderLanguage(changes.language.newValue);
    if (changes.profileSummary) refreshRows();
    if (changes.theme) applyTheme(changes.theme.newValue || 'system');
    return;
  }
  if (area === 'session' && activeTab && changes[`tab:${activeTab.id}`]) {
    refreshCaptureRow();
  }
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
els.saveToken.addEventListener('click', saveToken);
els.token.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') saveToken();
});
els.getToken.addEventListener('click', openWebApp);
els.forgetToken.addEventListener('click', forgetToken);
els.openPanel.addEventListener('click', openPanel);
els.themeToggle.addEventListener('click', toggleTheme);
els.consentToggle.addEventListener('change', onConsentChange);
els.langEnglish.addEventListener('click', onLanguageClick);
els.langHinglish.addEventListener('click', onLanguageClick);
els.deleteData.addEventListener('click', onDeleteClick);
els.sendIssue.addEventListener('click', sendIssue);

async function init() {
  applyTheme(await Ext.getTheme());
  updateAuthUI(Boolean(await Ext.getAuthToken()));
  await getActiveTab();
  await Promise.all([loadControls(), refreshPanelButton(), refreshRows()]);
  startConnectionPolling();
}

init();
window.addEventListener('unload', stopConnectionPolling);
