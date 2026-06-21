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