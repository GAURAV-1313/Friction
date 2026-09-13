// Anchor API client (ES module; imported by popup.js and sidepanel.js).
//
// Every function resolves to { ok, status, data, error } and never throws:
//   ok      response.ok
//   status  HTTP status, or 0 when no response arrived
//   data    parsed JSON body (null when empty / not JSON)
//   error   null on success; the server's {error} string, 'http_<status>',
//           'network' (fetch failed), 'timeout' (our timeout fired),
//           'aborted' (caller's signal), 'missing_token' (no token stored),
//           or 'ext_unavailable' (anchor-setup.js not loaded)
// Requires config.js and anchor-setup.js to have run first (classic scripts).

function config() {
  return globalThis.ANCHOR_CONFIG || {};
}

function encode(part) {
  return encodeURIComponent(String(part));
}

async function readBody(response) {
  let text = '';
  try {
    text = await response.text();
  } catch (_) {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function classifyError(err, signal) {
  if (signal && signal.aborted) return 'aborted';
  const name = err && err.name;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  return 'network';
}

/**
 * Low-level request. Exported so other extension pages can call endpoints
 * that have no dedicated wrapper yet.
 * @param {string} method
 * @param {string} path      e.g. '/api/lc/me'
 * @param {object} [options] { body, timeoutMs, signal, auth }
 */
export async function apiRequest(method, path, options = {}) {
  const ext = globalThis.AnchorExt;
  if (!ext || typeof ext.fetchWithAuth !== 'function') {
    return { ok: false, status: 0, data: null, error: 'ext_unavailable' };
  }
  const { body, timeoutMs, signal, auth = true } = options;

  if (auth) {
    const token = await ext.getAuthToken();
    if (!token) return { ok: false, status: 0, data: null, error: 'missing_token' };
  }

  const init = { method, headers: {} };
  if (signal) init.signal = signal;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await ext.fetchWithAuth(path, init, { timeoutMs });
  } catch (err) {
    return { ok: false, status: 0, data: null, error: classifyError(err, signal) };
  }

  const data = await readBody(response);
  let error = null;
  if (!response.ok) {
    error = data && typeof data.error === 'string' ? data.error : `http_${response.status}`;
  }
  return { ok: response.ok, status: response.status, data, error };
}

// ---- health ----
export function health() {
  return apiRequest('GET', '/health', { auth: false, timeoutMs: config().HEALTH_TIMEOUT_MS || 8000 });
}

// ---- account ----
export function me() {
  return apiRequest('GET', '/api/lc/me');
}

export function getProfile() {
  return apiRequest('GET', '/api/lc/profile');
}

/** @param {{language?: string, consent_code?: boolean, leetcode_username?: string}} fields */
export function putProfile(fields) {
  return apiRequest('PUT', '/api/lc/profile', { body: fields || {} });
}

export function postConsent(version) {
  return apiRequest('POST', '/api/lc/consent', { body: { version: String(version || '1') } });
}

export function deleteMe() {
  return apiRequest('DELETE', '/api/lc/me', { timeoutMs: 30000 });
}

// ---- sync ----
/** body: { phase: 'solved'|'submissions'|'finalize', sync_id, ... } (see backend README) */
export function syncChunk(body) {
  return apiRequest('POST', '/api/lc/sync', { body, timeoutMs: 45000 });
}

// ---- problems / anchors ----
export function putProblem(slug, meta) {
  return apiRequest('PUT', `/api/lc/problems/${encode(slug)}`, { body: meta || {} });
}

export function anchors(slug) {
  return apiRequest('GET', `/api/lc/anchors/${encode(slug)}`);
}

// ---- attempts ----
export function postAttempt(body) {
  return apiRequest('POST', '/api/lc/attempts', { body });
}

// ---- chat ----
/**
 * @param {object} body { title_slug, message, requested_rung?, plan?, code?, lang?, is_contest? }
 * @param {{signal?: AbortSignal}} [options]
 */
export function chat(body, options = {}) {
  return apiRequest('POST', '/api/lc/chat', {
    body,
    signal: options.signal,
    timeoutMs: config().CHAT_TIMEOUT_MS || 60000
  });
}

export function history(slug) {
  return apiRequest('GET', `/api/lc/chat/${encode(slug)}/history`);
}

/** body: { thumb: 'up'|'down', reason?: 'helped'|'too_much'|'too_little'|'wrong', note?: string } */
export function messageFeedback(id, body) {
  return apiRequest('POST', `/api/lc/chat/messages/${encode(id)}/feedback`, { body: body || {} });
}

/** body: { reaction: 'confirmed'|'dismissed' } */
export function habitFeedback(id, body) {
  return apiRequest('POST', `/api/lc/habits/${encode(id)}/feedback`, { body: body || {} });
}

// ---- telemetry ----
export function clientEvent(type, payload) {
  return apiRequest('POST', '/api/lc/client-events', {
    body: {
      type: String(type || 'unknown').slice(0, 48),
      ext_version: config().EXT_VERSION || '1.0.0',
      payload: payload === undefined ? null : payload
    }
  });
}
