// AnchorExt: shared storage + authenticated fetch helpers (classic script).
// Loaded after config.js by popup.html / sidepanel.html (script tag) and by
// background.js (importScripts). Never loaded into leetcode.com pages: the
// content scripts must not talk to the backend.
//
// chrome.storage.local keys owned here: authToken, theme, consentCode, language.
if (!globalThis.ANCHOR_CONFIG) {
  throw new Error('ANCHOR_CONFIG not available');
}

(function installAnchorExt() {
  const DEFAULT_TIMEOUT_MS = 20000;
  const AnchorExt = globalThis.AnchorExt || {};

  const store = {
    async get(key) {
      const result = await chrome.storage.local.get([key]);
      return result[key];
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove([key]);
    }
  };

  // ---- token ----
  AnchorExt.getAuthToken = async function getAuthToken() {
    const token = await store.get('authToken');
    return typeof token === 'string' ? token : '';
  };

  AnchorExt.saveAuthToken = async function saveAuthToken(token) {
    const clean = String(token || '').trim();
    if (!clean) {
      await store.remove('authToken');
      return;
    }
    await store.set('authToken', clean);
  };

  AnchorExt.clearAuthToken = async function clearAuthToken() {
    await store.remove('authToken');
  };

  // ---- theme ----
  AnchorExt.getTheme = async function getTheme() {
    const theme = await store.get('theme');
    return theme === 'light' || theme === 'dark' ? theme : 'system';
  };

  AnchorExt.saveTheme = async function saveTheme(theme) {
    const clean = theme === 'light' || theme === 'dark' ? theme : 'system';
    await store.set('theme', clean);
  };

  // ---- consent (code sharing; default off) ----
  AnchorExt.getConsent = async function getConsent() {
    return (await store.get('consentCode')) === true;
  };

  AnchorExt.setConsent = async function setConsent(value) {
    await store.set('consentCode', value === true);
  };

  // ---- hint language ----
  AnchorExt.getLanguage = async function getLanguage() {
    const language = await store.get('language');
    return language === 'hinglish' ? 'hinglish' : 'english';
  };

  AnchorExt.setLanguage = async function setLanguage(language) {
    await store.set('language', language === 'hinglish' ? 'hinglish' : 'english');
  };

  // ---- authenticated fetch ----
  // fetchWithAuth(path, init, { timeoutMs })
  //   path      '/api/lc/me' (prefixed with ANCHOR_CONFIG.API_BASE) or an absolute URL
  //   init      standard fetch init; init.signal is honoured alongside the timeout
  //   returns   the Response (callers read the body); rejects on network error or abort
  //   401       clears the stored token before returning the Response
  AnchorExt.fetchWithAuth = async function fetchWithAuth(path, init = {}, options = {}) {
    const base = globalThis.ANCHOR_CONFIG.API_BASE;
    const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

    const token = await AnchorExt.getAuthToken();
    const headers = { ...(init.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    // Lets the server answer 426 update_required when this build is below LC_MIN_EXTENSION_VERSION.
    const extVersion = globalThis.ANCHOR_CONFIG.EXT_VERSION;
    if (typeof extVersion === 'string' && extVersion) headers['X-Anchor-Version'] = extVersion;

    const controller = new AbortController();
    const outer = init.signal;
    if (outer) {
      if (outer.aborted) {
        controller.abort(outer.reason);
      } else {
        outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
      }
    }
    const timer = setTimeout(() => {
      controller.abort(new DOMException('Request timed out', 'TimeoutError'));
    }, timeoutMs);

    try {
      const response = await fetch(url, { ...init, headers, signal: controller.signal });
      if (response.status === 401 && token) {
        await AnchorExt.clearAuthToken();
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  };

  globalThis.AnchorExt = AnchorExt;
})();
