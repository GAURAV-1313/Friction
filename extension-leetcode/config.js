// Recall extension configuration (classic script).
// Loaded by: popup.html, sidepanel.html (script tag), background.js (importScripts),
// and the ISOLATED-world content scripts (first entry in the manifest list).
//
// Set ENV to 'local' for the mock backend on localhost:4100, 'production' for the
// Railway deploy. The packaging step flips this to 'production' before zipping.
const ENV = 'production';

const CONFIG_BY_ENV = {
  local: {
    API_BASE: 'http://localhost:4100',
    WEB_APP_URL: 'http://localhost:3000'
  },
  production: {
    API_BASE: 'https://anchor-production-1dea.up.railway.app',
    WEB_APP_URL: 'https://nofriction.netlify.app'
  }
};

globalThis.RECALL_CONFIG = {
  ...(CONFIG_BY_ENV[ENV] || CONFIG_BY_ENV.production),
  ENV,
  // LeetCode request pacing (lc-client.js): one request per second.
  LC_RATE_MS: 1000,
  // Judge details fetched for failed submissions during the first sync (resumable).
  DETAILS_CAP_DEFAULT: 300,
  // Rows per POST /api/lc/sync chunk.
  CHUNK_SUBS: 200,
  CHUNK_DETAILS: 50,
  // Timeouts for the long calls owned by the side panel / popup.
  CHAT_TIMEOUT_MS: 60000,
  HEALTH_TIMEOUT_MS: 8000,
  // How many submission pages the sweep may fetch ahead of the last acked chunk.
  SYNC_LOOKAHEAD_PAGES: 20,
  EXT_VERSION:
    (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.().version) || '1.0.0'
};
