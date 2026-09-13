// Anchor: ISOLATED-world entry for leetcode.com (document_start). Bridges MAIN <-> background/panel.
// Sends to MAIN (postMessage): hello{consent_code,version}, config{consent_code}, get_code (reqId), ack{eventId}.
// Receives from MAIN: ready, code, submit_started, submission, submit_timeout, capture_disabled.
// Sends to background: route:changed, capture:state, attempt:judging, attempt:captured, client:event.
// Answers panel messages: lc:ping, editor:get_code, lc:whoami, lc:fetch_problem, lc:manual_capture; Port 'anchor-sync' -> AnchorSync.

(function () {
  'use strict';

  if (window.__anchorLoaded) return;
  window.__anchorLoaded = true;

  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return '0.0.0'; } })();
  const PENDING_KEY = 'anchor_pending_events';
  const HELLO_INTERVAL_MS = 500;
  const HELLO_MAX_TRIES = 20;         // 10 s
  const CODE_TIMEOUT_MS = 1500;
  const ROUTE_POLL_MS = 2000;
  const DRAIN_DELAY_MS = 3000;
  const BANNER_ID = 'anchor-reload-banner';

  // ---------- nonce ----------
  const nonce = crypto.randomUUID();
  (function setNonce() {
    const el = document.documentElement;
    if (el) { el.dataset.anchorNonce = nonce; return; }
    setTimeout(setNonce, 10);
  })();

  // ---------- state ----------
  let consent = false;
  let capture = 'unknown';             // 'unknown' | 'on' | 'off'
  let captureReason = null;
  let mainVersion = null;
  let readyGot = false;
  let helloTries = 0;
  let lastCaptureKey = null;
  let lastRouteKey = null;
  let bannerShown = false;
  const seenEvents = new Set();
  const codeWaiters = new Map();       // reqId -> {resolve, timer}

  function coerceConsent(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }

  // ---------- pure helpers ----------
  function computeRoute(pathname, search) {
    const m = /^\/problems\/([^/]+)/.exec(pathname || '');
    let isContest = /^\/contest\//.test(pathname || '');
    try { if (!isContest) isContest = new URLSearchParams(search || '').get('envType') === 'contest'; } catch (_) { /* ignore */ }
    return { slug: m ? m[1] : null, page: m ? 'problem' : 'other', isContest };
  }
  function stripCode(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const o = Object.assign({}, obj);
    delete o.code;
    delete o.typed_code;
    return o;
  }
  function isInvalidated(err) {
    try { if (!chrome.runtime || !chrome.runtime.id) return true; } catch (_) { return true; }
    return /extension context invalidated/i.test(String(err && err.message || err));
  }

  // ---------- background messaging ----------
  function sendBg(msg) {
    return new Promise((resolve, reject) => {
      let p;
      try { p = chrome.runtime.sendMessage(msg); } catch (err) { reject(err); return; }
      if (p && typeof p.then === 'function') p.then(resolve, reject); else resolve(undefined);
    });
  }
  function clientEvent(name, payload) {
    sendBg({ type: 'client:event', name, payload: payload || {}, version: VERSION, url: location.href, at: Date.now() }).catch(() => {});
  }

  // ---------- MAIN bridge ----------
  function postToMain(type, payload, reqId) {
    try {
      window.postMessage({ __anchor: true, from: 'iso', nonce, type, reqId: reqId || null, payload: payload || {} }, location.origin);
    } catch (_) { /* ignore */ }
  }

  function sendCaptureState(extra) {
    const state = Object.assign({ capture, reason: captureReason, version: VERSION, mainVersion, stale: !!(mainVersion && mainVersion !== VERSION), url: location.href }, extra || {});
    const key = JSON.stringify([state.capture, state.reason, state.mainVersion]);
    if (key === lastCaptureKey) return;
    lastCaptureKey = key;
    sendBg({ type: 'capture:state', state }).catch(() => {});
  }

  function helloTick() {
    if (readyGot) return;
    if (helloTries >= HELLO_MAX_TRIES) {
      capture = 'off'; captureReason = 'no_main';
      sendCaptureState();
      clientEvent('main_not_ready', { tries: helloTries });
      return;
    }
    helloTries++;
    postToMain('hello', { consent_code: consent, version: VERSION });
    setTimeout(helloTick, HELLO_INTERVAL_MS);
  }

  // The worker resolves with { ok:false, error } when a handler throws. Only a permanent validation error
  // (invalid_*) counts as delivered; anything else leaves the event buffered in MAIN for the next hello / reload.
  function delivered(res) {
    if (!res || res.ok !== false) return true;
    return /^invalid_/.test(String(res.error || ''));
  }
  function verdictSeen(ev, buffered) {
    clientEvent('verdict_seen', { submission_id: ev.submission_id, slug: ev.slug, status_code: ev.verdict && ev.verdict.status_code, orphan: !!ev.orphan, buffered: !!buffered });
  }

  function onSubmission(ev) {
    if (!ev || !ev.eventId) return;
    if (seenEvents.has(ev.eventId)) { postToMain('ack', { eventId: ev.eventId }); return; }
    const body = consent ? Object.assign({}, ev) : stripCode(ev);
    const msg = Object.assign({ type: 'attempt:captured', captured_via: 'interceptor', version: VERSION, url: location.href }, body);
    sendBg(msg).then((res) => {
      if (!delivered(res)) return; // queue never received it: keep it buffered, no ack
      seenEvents.add(ev.eventId);
      postToMain('ack', { eventId: ev.eventId });
      verdictSeen(ev, false);
    }).catch((err) => {
      if (isInvalidated(err)) showReloadBanner();
      // any other failure: leave the event buffered in MAIN; it is re-sent on the next hello / drained on reload
    });
  }

  function onMainMessage(event) {
    try {
      if (event.source !== window || event.origin !== location.origin) return;
      const d = event.data;
      if (!d || d.__anchor !== true || d.from !== 'main' || d.nonce !== nonce) return;
      const payload = d.payload || {};
      switch (d.type) {
        case 'ready':
          readyGot = true;
          capture = payload.capture === 'on' ? 'on' : 'off';
          captureReason = capture === 'on' ? null : 'main_disabled';
          mainVersion = payload.version || null;
          sendCaptureState();
          break;
        case 'code': {
          const w = codeWaiters.get(d.reqId);
          if (w) { clearTimeout(w.timer); codeWaiters.delete(d.reqId); w.resolve(payload); }
          break;
        }
        case 'submit_started':
          sendBg(Object.assign({ type: 'attempt:judging', title_slug: payload.slug || null, version: VERSION, url: location.href }, payload)).catch(() => {});
          clientEvent('submit_seen', { submission_id: payload.submission_id, slug: payload.slug });
          break;
        case 'submission':
          onSubmission(payload);
          break;
        case 'submit_timeout':
          clientEvent('submit_timeout', payload);
          break;
        case 'capture_disabled':
          capture = 'off'; captureReason = payload.reason || 'disabled';
          sendCaptureState({ errors: payload.errors });
          clientEvent('capture_disabled', payload);
          break;
        default:
          break;
      }
    } catch (err) {
      if (isInvalidated(err)) showReloadBanner();
    }
  }

  function requestCode() {
    return new Promise((resolve) => {
      const reqId = crypto.randomUUID();
      const timer = setTimeout(() => { codeWaiters.delete(reqId); resolve({ code: null, reason: readyGot ? 'timeout' : 'main_not_ready' }); }, CODE_TIMEOUT_MS);
      codeWaiters.set(reqId, { resolve, timer });
      postToMain('get_code', {}, reqId);
    });
  }

  // ---------- reload banner ----------
  function showReloadBanner() {
    if (bannerShown) return;
    bannerShown = true;
    try {
      const host = document.body || document.documentElement;
      if (!host) { bannerShown = false; setTimeout(showReloadBanner, 500); return; }
      const box = document.createElement('div');
      box.id = BANNER_ID;
      const s = box.style;
      s.position = 'fixed'; s.right = '16px'; s.bottom = '16px'; s.zIndex = '2147483647';
      s.maxWidth = '320px'; s.padding = '12px 14px'; s.borderRadius = '10px';
      s.background = '#1f2937'; s.color = '#f9fafb'; s.font = '13px/1.4 system-ui, sans-serif';
      s.boxShadow = '0 6px 24px rgba(0,0,0,0.35)';
      const text = document.createElement('div');
      text.textContent = 'Anchor was updated. Reload this tab to keep capturing your submissions.';
      const row = document.createElement('div');
      row.style.marginTop = '10px'; row.style.display = 'flex'; row.style.gap = '8px';
      const reload = document.createElement('button');
      reload.type = 'button'; reload.textContent = 'Reload';
      reload.style.cssText = 'padding:6px 12px;border-radius:6px;border:0;background:#22c55e;color:#052e16;font-weight:600;cursor:pointer';
      reload.addEventListener('click', () => location.reload());
      const dismiss = document.createElement('button');
      dismiss.type = 'button'; dismiss.textContent = 'Later';
      dismiss.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid #6b7280;background:transparent;color:#f9fafb;cursor:pointer';
      dismiss.addEventListener('click', () => { box.remove(); });
      row.appendChild(reload); row.appendChild(dismiss);
      box.appendChild(text); box.appendChild(row);
      host.appendChild(box);
    } catch (_) { /* ignore */ }
  }

  // ---------- route watcher (exactly one) ----------
  function checkRoute(force) {
    const r = computeRoute(location.pathname, location.search);
    const key = [r.slug, r.page, r.isContest].join('|');
    if (!force && key === lastRouteKey) return;
    lastRouteKey = key;
    sendBg({ type: 'route:changed', slug: r.slug, page: r.page, isContest: r.isContest, url: location.href, version: VERSION }).catch((err) => {
      if (isInvalidated(err)) showReloadBanner();
    });
  }
  function installRouteWatcher() {
    try {
      if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('navigate', () => { setTimeout(() => checkRoute(false), 0); setTimeout(() => checkRoute(false), 250); });
      }
    } catch (_) { /* ignore */ }
    window.addEventListener('popstate', () => setTimeout(() => checkRoute(false), 0));
    setInterval(() => checkRoute(false), ROUTE_POLL_MS);
    checkRoute(true);
  }

  // ---------- drain events buffered by MAIN (extension reload, closed tab) ----------
  function readPending() {
    try { const arr = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); return Array.isArray(arr) ? arr : []; }
    catch (_) { return []; }
  }
  function removePending(eventId) {
    try {
      const arr = readPending();
      const next = arr.filter((e) => e && e.eventId !== eventId);
      if (next.length !== arr.length) localStorage.setItem(PENDING_KEY, JSON.stringify(next));
    } catch (_) { /* ignore */ }
  }
  async function drainPending() {
    for (const ev of readPending()) {
      if (!ev || !ev.eventId || seenEvents.has(ev.eventId)) continue;
      const body = consent ? Object.assign({}, ev) : stripCode(ev);
      const msg = Object.assign({ type: 'attempt:captured', captured_via: 'interceptor', buffered: true, version: VERSION, url: location.href }, body);
      try {
        const res = await sendBg(msg);
        if (!delivered(res)) continue; // leave it in localStorage for the next drain
        seenEvents.add(ev.eventId);
        removePending(ev.eventId);
        verdictSeen(ev, true);
      } catch (err) {
        if (isInvalidated(err)) { showReloadBanner(); return; }
      }
    }
  }

  // ---------- panel/background -> content ----------
  async function handleRuntimeMessage(msg) {
    const LC = globalThis.AnchorLC;
    const quick = { waitVisible: false };
    switch (msg && msg.type) {
      case 'lc:ping': {
        const r = computeRoute(location.pathname, location.search);
        return { ok: true, version: VERSION, capture, captureReason, mainVersion, nonceSet: !!(document.documentElement && document.documentElement.dataset.anchorNonce), consent, slug: r.slug, page: r.page, isContest: r.isContest, url: location.href };
      }
      case 'editor:get_code': {
        if (!consent) return { ok: false, code: null, reason: 'no_consent' };
        const r = await requestCode();
        if (r && typeof r.code === 'string') return { ok: true, code: r.code, lang: r.lang || null, source: r.source || null };
        return { ok: false, code: null, reason: (r && r.reason) || 'no_editor', lang: (r && r.lang) || null };
      }
      case 'lc:whoami': {
        if (!LC) return { ok: false, error: { code: 'client_missing' } };
        const me = await LC.whoami(quick);
        return { ok: true, isSignedIn: me.isSignedIn, username: me.username };
      }
      case 'lc:fetch_problem': {
        if (!LC) return { ok: false, error: { code: 'client_missing' } };
        const slug = (msg.slug || computeRoute(location.pathname, location.search).slug || '').trim();
        if (!slug) return { ok: false, error: { code: 'no_slug' } };
        const meta = await LC.problemMeta(slug, quick);
        if (!meta) return { ok: false, error: { code: 'not_found', message: 'question not found' } };
        return { ok: true, meta };
      }
      case 'lc:manual_capture': {
        if (!LC) return { ok: false, error: { code: 'client_missing' } };
        const slug = (msg.slug || computeRoute(location.pathname, location.search).slug || '').trim();
        if (!slug) return { ok: false, error: { code: 'no_slug' } };
        const r = await LC.latestSubmissionForSlug(slug, quick);
        const submission = consent ? r.submission : stripCode(r.submission);
        const details = consent ? r.details : stripCode(r.details);
        return { ok: true, submission, details, captured_via: 'manual' };
      }
      default:
        return { ok: false, error: { code: 'unknown_message', message: String(msg && msg.type) } };
    }
  }

  function installRuntimeListeners() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      handleRuntimeMessage(msg)
        .then((res) => sendResponse(res))
        .catch((err) => {
          const LC = globalThis.AnchorLC;
          sendResponse({ ok: false, error: LC && LC.toPlain ? LC.toPlain(err) : { code: (err && err.code) || 'internal', message: String(err && err.message || err) } });
        });
      return true;
    });
    chrome.runtime.onConnect.addListener((port) => {
      if (port && port.name === 'anchor-sync' && globalThis.AnchorSync) globalThis.AnchorSync.attachPort(port);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes.consentCode) return;
      consent = coerceConsent(changes.consentCode.newValue);
      postToMain('config', { consent_code: consent });
    });
  }

  // ---------- boot ----------
  function boot() {
    window.addEventListener('message', onMainMessage);
    installRuntimeListeners();
    if (globalThis.AnchorLC) globalThis.AnchorLC.hooks.onDrift = (info) => clientEvent('schema_drift', info);
    installRouteWatcher();
    setTimeout(drainPending, DRAIN_DELAY_MS);
  }

  let booted = false;
  function startHello() {
    if (booted) return;
    booted = true;
    boot();
    helloTick();
  }

  function applyConsent(v) {
    const next = coerceConsent(v);
    const changed = next !== consent;
    consent = next;
    if (booted && changed) postToMain('config', { consent_code: consent });
  }

  try {
    chrome.storage.local.get('consentCode').then((got) => {
      applyConsent(got && got.consentCode);
      startHello();
    }).catch(startHello);
  } catch (_) {
    startHello();
  }
  setTimeout(startHello, 300); // never wait on storage for the handshake
})();
