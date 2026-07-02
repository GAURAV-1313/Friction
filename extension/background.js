importScripts('./config.js');

globalThis.FrictionExt = globalThis.FrictionExt || {};

const frictionStorage = {
  async get(key) {
    const result = await chrome.storage.local.get([key]);
    return result[key] || '';
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove([key]);
  }
};

globalThis.FrictionExt.getAuthToken = async function getAuthToken() {
  return frictionStorage.get('authToken');
};

globalThis.FrictionExt.saveAuthToken = async function saveAuthToken(token) {
  await frictionStorage.set('authToken', token);
};

globalThis.FrictionExt.clearAuthToken = async function clearAuthToken() {
  await frictionStorage.remove('authToken');
};

globalThis.FrictionExt.getTheme = async function getTheme() {
  const result = await chrome.storage.local.get(['theme']);
  return result.theme || 'system';
};

globalThis.FrictionExt.saveTheme = async function saveTheme(theme) {
  await chrome.storage.local.set({ theme });
};

globalThis.FrictionExt.fetchWithAuth = async function fetchWithAuth(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });
};

const API_BASE = globalThis.FRICTION_CONFIG?.API_BASE;
const COOLDOWN_MS = 3000;
let lastCaptureAt = 0;

// Handle messages from content script (auto capture)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'capture') {
    console.log('[Friction BG] Received capture message:', { site: message.site, mode: message.mode, textLength: message.text?.length, hash: message.hash?.slice(0, 16) + '...' });
    handleAutoCapture(message.text, message.hash, message.url, message.site, message.mode)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-moment') return;

  const now = Date.now();
  if (now - lastCaptureAt < COOLDOWN_MS) {
    await showBadge('Wait');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  const [{ result: selectionText } = { result: '' }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.getSelection().toString()
  });

  const text = (selectionText || '').trim();
  if (!text) {
    await showBadge('No selection');
    return;
  }

  const authToken = await globalThis.FrictionExt.getAuthToken();
  if (!authToken) {
    await showBadge('No token');
    return;
  }

  try {
    const response = await globalThis.FrictionExt.fetchWithAuth(`${API_BASE}/api/moments`, authToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: text,
        source_type: 'highlight',
        source_url: tab.url || null,
        created_at: new Date().toISOString()
      })
    });

    if (response.status === 401) {
      await globalThis.FrictionExt.clearAuthToken();
      await showBadge('Auth');
      return;
    }

    if (!response.ok) {
      await showBadge('Save failed');
      return;
    }

    lastCaptureAt = Date.now();
    await showBadge('Saved');
  } catch (err) {
    await showBadge('Error');
  }
});

async function handleAutoCapture(text, hash, url, site, mode) {
  console.log('[Friction BG] handleAutoCapture called:', { site, mode, url });
  const authToken = await globalThis.FrictionExt.getAuthToken();
  if (!authToken) {
    console.log('[Friction BG] No auth token, skipping');
    return;
  }

  try {
    console.log('[Friction BG] Sending to backend...');
    const response = await globalThis.FrictionExt.fetchWithAuth(`${API_BASE}/api/moments`, authToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: text,
        source_type: 'auto',
        source_url: url,
        capture_hash: hash,
        created_at: new Date().toISOString()
      })
    });

    console.log('[Friction BG] Backend response status:', response.status);
    const data = await response.json();
    console.log('[Friction BG] Backend response:', data);

    if (response.status === 401) {
      console.log('[Friction BG] Auth expired, clearing token');
      await globalThis.FrictionExt.clearAuthToken();
      return;
    }

    if (!data.duplicate) {
      lastCaptureAt = Date.now();
      await showBadge('Auto');
      console.log('[Friction BG] New moment saved');
    } else {
      console.log('[Friction BG] Duplicate moment skipped');
    }
  } catch (err) {
    console.error('[Friction BG] Auto capture failed:', err);
  }
}

async function showBadge(text) {
  await chrome.action.setBadgeText({ text: ' ' });
  await chrome.action.setBadgeBackgroundColor({ color: '#4f8cff' });
  await chrome.action.setBadgeText({ text: text.slice(0, 4) });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1200);
}
