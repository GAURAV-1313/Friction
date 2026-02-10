const API_BASE = 'https://friction-production.up.railway.app';
const WEB_APP_URL = 'https://nofriction.netlify.app/reports';

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
  const result = await chrome.storage.local.get(['authToken']);
  if (result.authToken && tokenInput) {
    tokenInput.value = result.authToken;
  }
  updateAuthUI(!!result.authToken);
}

async function loadTheme() {
  const result = await chrome.storage.local.get(['theme']);
  const theme = result.theme || 'system';
  applyTheme(theme);
}

async function saveToken() {
  if (!tokenInput) return;
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus('Token required.', 'error');
    return;
  }
  await chrome.storage.local.set({ authToken: token });
  setStatus('Token saved.', 'success');
  updateAuthUI(true);
  await loadFindings();
  await checkConnection();
}

async function getToken() {
  const result = await chrome.storage.local.get(['authToken']);
  return result.authToken || '';
}

async function saveMoment() {
  if (!momentInput) return;
  const rawText = momentInput.value.trim();
  if (!rawText) {
    setStatus('Paste something first.', 'error');
    return;
  }

  const token = await getToken();
  if (!token) {
    setStatus('Missing token. Paste it once below.', 'error');
    return;
  }

  setStatus('Saving...');

  const response = await fetch(`${API_BASE}/api/moments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      raw_text: rawText,
      source_type: 'bulk_paste',
      source_url: null,
      created_at: new Date().toISOString()
    })
  });

  if (response.status === 401) {
    await chrome.storage.local.remove(['authToken']);
    if (tokenInput) tokenInput.value = '';
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
  await loadFindings();
  await checkConnection();
}

async function generateReport() {
  const token = await getToken();
  if (!token) {
    setStatus('Missing token. Paste it once below.', 'error');
    return;
  }

  setStatus('Generating...');

  const response = await fetch(`${API_BASE}/api/snapshots/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ trigger_type: 'manual' })
  });

  if (response.status === 401) {
    await chrome.storage.local.remove(['authToken']);
    tokenInput.value = '';
    updateAuthUI(false);
    setStatus('Token invalid. Login again.', 'error');
    await checkConnection();
    return;
  }

  chrome.tabs.create({ url: WEB_APP_URL });
  setStatus('Opened report.', 'success');
  await loadFindings();
  await checkConnection();
}

function openReports() {
  chrome.tabs.create({ url: WEB_APP_URL });
}

async function logout() {
  await chrome.storage.local.remove(['authToken']);
  if (tokenInput) tokenInput.value = '';
  setStatus('Logged out.', 'success');
  updateAuthUI(false);
  renderFindings([]);
  await checkConnection();
}

function updateAuthUI(isAuthed) {
  document.body.classList.toggle('authed', isAuthed);
  if (logoutButton) {
    logoutButton.classList.toggle('hidden', !isAuthed);
  }
}

async function loadFindings() {
  const token = await getToken();
  if (!token) {
    allFindings = [];
    renderFindings([]);
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/findings?state=${currentStatus}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.status === 401) {
      await chrome.storage.local.remove(['authToken']);
      if (tokenInput) tokenInput.value = '';
      updateAuthUI(false);
      renderFindings([]);
      return;
    }
    const data = await response.json();
    allFindings = data.findings || [];
    renderFindings(allFindings);
  } catch (err) {
    allFindings = [];
    renderFindings([]);
  }
}

function renderFindings(items) {
  if (!findingsList) return;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startYesterday.getDate() - 1);
  const timeFiltered = items.filter((item) => {
    const ts = item.created_at || item.snapshot_created_at;
    if (!ts) return true;
    const time = new Date(ts).getTime();
    return time >= startYesterday.getTime();
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
    return new Date(ts).getTime() >= startToday.getTime();
  });

  const yesterdayItems = filtered.filter((item) => {
    const ts = item.created_at || item.snapshot_created_at;
    if (!ts) return false;
    const time = new Date(ts).getTime();
    return time >= startYesterday.getTime() && time < startToday.getTime();
  });

  const renderFinding = (item) => `
      <div class="finding">
        <div class="finding-head">
          <span class="badge ${item.type}">${item.type}</span>
          <span class="badge">${item.confidence_ai || item.confidence}</span>
        </div>
        <div class="finding-title">${item.topic || 'Untitled'}</div>
        <div class="finding-summary">${item.summary || ''}</div>
        ${item.recall_anchor ? `<div class="finding-anchor">Recall: ${item.recall_anchor}</div>` : ''}
        <div class="finding-actions">
          ${
            currentStatus !== 'confirmed'
              ? `<button class="btn ghost tiny icon" data-action="confirm" data-id="${item.finding_id}" aria-label="Accept">
                   <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                     <path d="M20 6L9 17l-5-5" />
                   </svg>
                 </button>`
              : ''
          }
          ${
            currentStatus !== 'deferred'
              ? `<button class="btn ghost tiny icon" data-action="defer" data-id="${item.finding_id}" aria-label="Ignore">
                   <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                     <circle cx="12" cy="12" r="9" />
                     <path d="M5 5l14 14" />
                   </svg>
                 </button>`
              : ''
          }
          ${
            currentStatus === 'confirmed'
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

  const renderGroup = (label, groupItems) => {
    if (!groupItems.length) return '';
    return `
      <div class="finding-group">
        <div class="finding-group-title">${label} · ${groupItems.length}</div>
        ${groupItems.map((item) => renderFinding(item)).join('')}
      </div>
    `;
  };

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
      await updateFinding(id, action);
    });
  });
}

async function updateFinding(id, action) {
  const token = await getToken();
  if (!token) return;

  const map = {
    confirm: { method: 'POST', path: `/api/findings/${id}/confirm` },
    defer: { method: 'POST', path: `/api/findings/${id}/defer` },
    resolve: { method: 'POST', path: `/api/findings/${id}/resolve` }
  };

  const payload = map[action];
  if (!payload) return;

  await fetch(`${API_BASE}${payload.path}`, {
    method: payload.method,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  await loadFindings();
}

async function toggleTheme() {
  const result = await chrome.storage.local.get(['theme']);
  const current = result.theme || 'system';
  const next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
  await chrome.storage.local.set({ theme: next });
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
      await chrome.storage.local.remove(['authToken']);
      if (tokenInput) tokenInput.value = '';
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

if (saveTokenButton) {
  saveTokenButton.addEventListener('click', saveToken);
}
if (saveButton) {
  saveButton.addEventListener('click', saveMoment);
}
generateButton.addEventListener('click', generateReport);
viewButton.addEventListener('click', openReports);
logoutButton.addEventListener('click', logout);
themeToggle.addEventListener('click', toggleTheme);

loadToken();
loadTheme();
loadFindings();
checkConnection();

statusChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    statusChips.forEach((item) => item.classList.remove('active'));
    chip.classList.add('active');
    currentStatus = chip.dataset.status;
    loadFindings();
  });
});

if (searchInput) {
  searchInput.addEventListener('input', () => renderFindings(allFindings));
}

if (refreshButton) {
  refreshButton.addEventListener('click', () => loadFindings());
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.authToken) {
    loadToken();
    loadFindings();
    checkConnection();
  }
});
