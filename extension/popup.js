const { getAuthToken, saveAuthToken, clearAuthToken, getTheme, saveTheme, fetchWithAuth } = globalThis.FrictionExt;
const API_BASE = globalThis.FRICTION_CONFIG?.API_BASE;
const WEB_APP_URL = globalThis.FRICTION_CONFIG?.WEB_APP_URL;

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
let statusTimer;

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
}

async function saveMoment() {
  const rawText = momentInput.value.trim();
  if (!rawText) {
    setStatus('Paste something first.', 'error');
    return;
  }

  const token = await getAuthToken();
  if (!token) {
    setStatus('Missing token. Paste it once below.', 'error');
    return;
  }

  setStatus('Saving...');

  const response = await fetchWithAuth(`${API_BASE}/api/moments`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw_text: rawText,
      source_type: 'bulk_paste',
      source_url: null,
      created_at: new Date().toISOString()
    })
  });

  if (response.status === 401) {
    await clearAuthToken();
    tokenInput.value = '';
    updateAuthUI(false);
    setStatus('Token invalid. Login again.', 'error');
    await checkConnection();
    return;
  }

  if (!response.ok) {
    setStatus('Save failed.', 'error');
    await checkConnection();
    return;
  }

  momentInput.value = '';
  setStatus('Moment saved.', 'success');
  await checkConnection();
}

async function generateReport() {
  const token = await getAuthToken();
  if (!token) {
    setStatus('Missing token. Paste it once below.', 'error');
    return;
  }

  setStatus('Generating...');

  const response = await fetchWithAuth(`${API_BASE}/api/snapshots/run`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trigger_type: 'manual' })
  });

  if (response.status === 401) {
    await clearAuthToken();
    tokenInput.value = '';
    updateAuthUI(false);
    setStatus('Token invalid. Login again.', 'error');
    await checkConnection();
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
  if (logoutButton) {
    logoutButton.classList.toggle('hidden', !isAuthed);
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
  if (themeToggle) themeToggle.textContent = theme === 'system' ? 'Theme' : theme;
}

async function checkConnection() {
  const token = await getToken();
  if (!token) {
    connEl.textContent = 'Disconnected';
    connEl.classList.remove('connected');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.status === 401) {
      connEl.textContent = 'Token invalid';
      connEl.classList.remove('connected');
      await clearAuthToken();
      tokenInput.value = '';
      updateAuthUI(false);
      return;
    }
    connEl.textContent = 'Connected';
    connEl.classList.add('connected');
  } catch (err) {
    connEl.textContent = 'Disconnected';
    connEl.classList.remove('connected');
  }
}

saveTokenButton.addEventListener('click', saveToken);
saveButton.addEventListener('click', saveMoment);
generateButton.addEventListener('click', generateReport);
viewButton.addEventListener('click', openReports);
logoutButton.addEventListener('click', logout);
themeToggle.addEventListener('click', toggleTheme);

loadToken();
loadTheme();
checkConnection();
