// Recall: MAIN-world interceptor + editor reader for leetcode.com (document_start; NO chrome.* APIs here).
// Sends to ISOLATED (window.postMessage): ready{capture,version}, code{code,lang,source|reason} (reqId), submit_started,
//   submission{eventId,submission_id,slug,question_id,lang,typed_code?,submitted_at,judged_at,verdict}, submit_timeout, capture_disabled.
// Receives from ISOLATED: hello{consent_code,version}, config{consent_code}, get_code (reqId), ack{eventId}.
// Envelope {__recall:true, from:'main'|'iso', nonce, type, reqId?, payload}; nonce read lazily from <html data-recall-nonce>.

(function () {
  'use strict';

  if (window.__recallMain) return;
  window.__recallMain = true;

  const MAIN_VERSION = '1.0.0'; // keep in step with manifest.json "version"
  const PENDING_KEY = 'recall_pending_events';
  const ERRORS_KEY = 'recall_capture_errors';
  const PENDING_CAP = 20;
  const SUBMIT_TIMEOUT_MS = 90000;
  const MAX_WRAPPER_ERRORS = 5;

  const RE_SUBMIT = /^\/problems\/([^/]+)\/submit\/?$/;
  const RE_CHECK_V2 = /^\/submissions\/detail\/(\d+)\/v2\/check\/?$/;
  const RE_CHECK_V1 = /^\/submissions\/detail\/(\d+)\/check\/?$/;
  const RE_CONTEST_API = /^\/contest\/api\//;
  const RE_PROBLEM_PATH = /^\/problems\/([^/]+)/;

  const VERDICT_FIELDS = [
    'status_code', 'status_msg', 'total_correct', 'total_testcases', 'last_testcase', 'expected_output', 'code_output',
    'runtime_error', 'full_runtime_error', 'compile_error', 'full_compile_error', 'status_runtime', 'runtime_percentile', 'lang', 'state',
    'task_finish_time'
  ];
  const LANG_BY_LABEL = {
    'C++': 'cpp', 'Python3': 'python3', 'Java': 'java', 'JavaScript': 'javascript', 'Python': 'python',
    'Go': 'golang', 'C#': 'csharp', 'TypeScript': 'typescript', 'Rust': 'rust', 'Kotlin': 'kotlin'
  };

  // ---------- state ----------
  let consent = false;
  let capture = 'on';
  let wrapperErrors = 0;
  let lastSubmitLang = null;
  const pending = new Map();   // submission_id -> {slug, question_id, lang, typed_code, t0, timer}
  const emitted = new Set();   // submission ids already reported
  const xhrMeta = new WeakMap();
  let memBuffer = [];          // fallback when localStorage is unavailable

  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  // ---------- pure helpers ----------
  function pick(obj, keys) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
  }
  function uuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) { /* fall through */ }
    return 'ev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function readNonce() {
    try {
      const el = document.documentElement;
      return (el && el.dataset && el.dataset.recallNonce) || '';
    } catch (_) { return ''; }
  }
  function isContestPage() {
    try {
      return /^\/contest\//.test(location.pathname) || new URLSearchParams(location.search).get('envType') === 'contest';
    } catch (_) { return false; }
  }
  function slugFromUrl() {
    const m = RE_PROBLEM_PATH.exec(location.pathname);
    return m ? m[1] : null;
  }
  function checkIdOf(path) {
    const m = RE_CHECK_V2.exec(path) || RE_CHECK_V1.exec(path);
    return m ? m[1] : null;
  }
  function parseJson(text) {
    if (typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }
  function stripQuotes(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    const parsed = parseJson(s);
    if (typeof parsed === 'string') return parsed.trim() || null;
    return s.replace(/^['"]+|['"]+$/g, '').trim() || null;
  }

  // ---------- bridge ----------
  function send(type, payload, reqId) {
    try {
      window.postMessage({ __recall: true, from: 'main', nonce: readNonce(), type, reqId: reqId || null, payload: payload || {} }, location.origin);
    } catch (_) { /* never throw into the page */ }
  }

  // ---------- buffer (unacked events) ----------
  function loadBuffer() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return memBuffer.slice(); }
  }
  function saveBuffer(list) {
    const trimmed = list.slice(-PENDING_CAP);
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(trimmed)); memBuffer = []; }
    catch (_) { memBuffer = trimmed; }
  }
  function bufferPush(ev) {
    const list = loadBuffer().filter((e) => e && e.eventId !== ev.eventId);
    list.push(ev);
    saveBuffer(list);
  }
  function bufferRemove(eventId) {
    if (!eventId) return;
    const list = loadBuffer();
    const next = list.filter((e) => e && e.eventId !== eventId);
    if (next.length !== list.length) saveBuffer(next);
  }
  function flushBuffer() {
    for (const ev of loadBuffer()) {
      if (!ev || !ev.eventId) continue;
      const out = Object.assign({}, ev);
      if (!consent) delete out.typed_code;
      send('submission', out);
    }
  }

  // ---------- errors / self-disable ----------
  function recordError(err) {
    try {
      const raw = localStorage.getItem(ERRORS_KEY);
      const cur = (raw && JSON.parse(raw)) || { count: 0, last: [] };
      cur.count = (cur.count || 0) + 1;
      cur.last = (cur.last || []).concat([String(err && err.message || err).slice(0, 200)]).slice(-5);
      cur.at = Date.now();
      localStorage.setItem(ERRORS_KEY, JSON.stringify(cur));
    } catch (_) { /* ignore */ }
  }
  function wrapperError(err) {
    wrapperErrors++;
    recordError(err);
    if (wrapperErrors >= MAX_WRAPPER_ERRORS && capture === 'on') disable('wrapper_errors'); // after the 5th error
  }
  function disable(reason) {
    capture = 'off';
    try { window.fetch = origFetch; } catch (_) { /* ignore */ }
    try { XMLHttpRequest.prototype.open = origOpen; } catch (_) { /* ignore */ }
    try { XMLHttpRequest.prototype.send = origSend; } catch (_) { /* ignore */ }
    for (const rec of pending.values()) clearTimeout(rec.timer);
    pending.clear();
    send('capture_disabled', { reason, errors: wrapperErrors, version: MAIN_VERSION });
  }

  // ---------- submit / verdict ----------
  function registerSubmit(slug, body, json) {
    const id = json && json.submission_id;
    if (id === undefined || id === null) return;
    const sid = String(id);
    if (pending.has(sid) || emitted.has(sid)) return;
    const b = (body && typeof body === 'object') ? body : {};
    const rec = {
      slug: slug || slugFromUrl(),
      question_id: b.question_id === undefined ? null : b.question_id,
      lang: typeof b.lang === 'string' ? b.lang : null,
      typed_code: typeof b.typed_code === 'string' ? b.typed_code : null,
      t0: Date.now(),
      timer: null
    };
    if (rec.lang) lastSubmitLang = rec.lang;
    rec.timer = setTimeout(() => onTimeout(sid), SUBMIT_TIMEOUT_MS);
    pending.set(sid, rec);
    send('submit_started', { submission_id: sid, slug: rec.slug, question_id: rec.question_id, lang: rec.lang, submitted_at: rec.t0 });
  }

  function onTimeout(sid) {
    const rec = pending.get(sid);
    if (!rec) return;
    pending.delete(sid);
    send('submit_timeout', { submission_id: sid, slug: rec.slug, question_id: rec.question_id, lang: rec.lang, submitted_at: rec.t0, waited_ms: SUBMIT_TIMEOUT_MS });
  }

  function onCheckResponse(sid, json) {
    if (!json || typeof json !== 'object') return;
    const state = json.state;
    if (state !== 'SUCCESS' && state !== 'FAILURE') return;
    if (emitted.has(sid)) return;
    emitted.add(sid);
    const rec = pending.get(sid) || null;
    if (rec) { clearTimeout(rec.timer); pending.delete(sid); }
    const ev = {
      eventId: uuid(),
      submission_id: sid,
      slug: (rec && rec.slug) || slugFromUrl(),
      question_id: rec ? rec.question_id : (json.question_id === undefined ? null : json.question_id),
      lang: (rec && rec.lang) || (typeof json.lang === 'string' ? json.lang : null),
      submitted_at: rec ? rec.t0 : null,
      judged_at: Date.now(),
      orphan: !rec,
      verdict: pick(json, VERDICT_FIELDS),
      version: MAIN_VERSION
    };
    if (consent && rec && rec.typed_code != null) ev.typed_code = rec.typed_code;
    bufferPush(ev);
    send('submission', ev);
  }

  // ---------- fetch wrapper ----------
  function classify(method, urlStr) {
    let u;
    try { u = new URL(urlStr, location.href); } catch (_) { return null; }
    if (u.origin !== location.origin) return null;
    const path = u.pathname;
    if (RE_CONTEST_API.test(path) || isContestPage()) return null;
    if (method === 'POST') {
      const m = RE_SUBMIT.exec(path);
      return m ? { kind: 'submit', slug: m[1] } : null;
    }
    if (method === 'GET') {
      const id = checkIdOf(path);
      return id ? { kind: 'check', id } : null;
    }
    return null;
  }

  function preObserveFetch(input, init) {
    if (capture !== 'on') return null;
    let method = 'GET';
    let urlStr = '';
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    if (isReq) { method = input.method || 'GET'; urlStr = input.url; }
    else urlStr = String(input instanceof URL ? input.href : input);
    if (init && init.method) method = String(init.method);
    method = method.toUpperCase();
    const c = classify(method, urlStr);
    if (!c) return null;
    if (c.kind === 'submit') {
      if (init && init.body != null) c.body = Promise.resolve(typeof init.body === 'string' ? parseJson(init.body) : null);
      else if (isReq) { try { c.body = input.clone().text().then(parseJson).catch(() => null); } catch (_) { c.body = Promise.resolve(null); } }
      else c.body = Promise.resolve(null);
    }
    return c;
  }

  function postObserveFetch(c, p) {
    if (!p || typeof p.then !== 'function') return;
    const jsonOf = (res) => { try { return res.clone().json(); } catch (_) { return Promise.resolve(null); } };
    if (c.kind === 'submit') {
      Promise.all([c.body, p.then(jsonOf)])
        .then(([body, json]) => { try { registerSubmit(c.slug, body, json); } catch (e) { wrapperError(e); } })
        .catch(() => {});
    } else if (c.kind === 'check') {
      p.then(jsonOf)
        .then((json) => { try { onCheckResponse(c.id, json); } catch (e) { wrapperError(e); } })
        .catch(() => {});
    }
  }

  function anchorFetch(input, init) {
    let c = null;
    try { c = preObserveFetch(input, init); } catch (e) { wrapperError(e); }
    const p = origFetch.apply(window, arguments);
    if (c) { try { postObserveFetch(c, p); } catch (e) { wrapperError(e); } }
    return p;
  }

  // ---------- XHR wrapper ----------
  function xhrResponseJson(xhr) {
    try {
      const rt = xhr.responseType;
      if (rt === 'json') return xhr.response && typeof xhr.response === 'object' ? xhr.response : null;
      if (rt === '' || rt === 'text') return parseJson(xhr.responseText);
    } catch (_) { /* ignore */ }
    return null;
  }

  function observeXhr(xhr, body) {
    if (capture !== 'on') return;
    const meta = xhrMeta.get(xhr);
    if (!meta) return;
    const c = classify(meta.method, meta.url);
    if (!c) return;
    if (c.kind === 'submit') {
      const parsed = typeof body === 'string' ? parseJson(body) : null;
      xhr.addEventListener('load', function () {
        try { registerSubmit(c.slug, parsed, xhrResponseJson(xhr)); } catch (e) { wrapperError(e); }
      });
    } else if (c.kind === 'check') {
      xhr.addEventListener('load', function () {
        try { onCheckResponse(c.id, xhrResponseJson(xhr)); } catch (e) { wrapperError(e); }
      });
    }
  }

  function anchorOpen(method, url) {
    try { xhrMeta.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url) }); } catch (e) { wrapperError(e); }
    return origOpen.apply(this, arguments);
  }
  function anchorSend(body) {
    try { observeXhr(this, body); } catch (e) { wrapperError(e); }
    return origSend.apply(this, arguments);
  }

  // ---------- editor read ----------
  function readEditor() {
    try {
      const editors = window.monaco && window.monaco.editor && typeof window.monaco.editor.getEditors === 'function'
        ? window.monaco.editor.getEditors() : null;
      if (editors && editors.length) {
        const host = document.querySelector('#editor');
        let ed = null;
        if (host) ed = editors.find((e) => { try { return host.contains(e.getDomNode()); } catch (_) { return false; } }) || null;
        if (!ed && editors.length === 1) ed = editors[0];
        if (ed) {
          const model = typeof ed.getModel === 'function' ? ed.getModel() : null;
          const value = model && typeof model.getValue === 'function' ? model.getValue() : null;
          if (typeof value === 'string') {
            let modelLang = null;
            try { modelLang = typeof model.getLanguageId === 'function' ? model.getLanguageId() : null; } catch (_) { /* ignore */ }
            return { code: value, source: 'monaco', modelLang };
          }
        }
        if (!host) return { code: null, reason: 'no_editor_in_dom' };
      }
    } catch (_) { /* fall through to CM6 */ }
    try {
      const cm = document.querySelector('.cm-content');
      const doc = cm && cm.cmView && cm.cmView.view && cm.cmView.view.state && cm.cmView.view.state.doc;
      if (doc && typeof doc.toString === 'function') return { code: doc.toString(), source: 'cm6', modelLang: null };
    } catch (_) { /* ignore */ }
    return { code: null, reason: window.monaco ? 'no_editor_in_dom' : 'no_editor_api' };
  }

  function languageFromButton() {
    try {
      const scopes = [document.querySelector('#editor'), document];
      for (const scope of scopes) {
        if (!scope) continue;
        const buttons = scope.querySelectorAll('button');
        for (const b of buttons) {
          const label = (b.textContent || '').trim();
          if (label && Object.prototype.hasOwnProperty.call(LANG_BY_LABEL, label)) return LANG_BY_LABEL[label];
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function readLanguage(modelLang) {
    let v = null;
    try { v = stripQuotes(localStorage.getItem('global_lang')); } catch (_) { v = null; }
    if (v) return v;
    v = languageFromButton();
    if (v) return v;
    if (lastSubmitLang) return lastSubmitLang;
    if (modelLang) return modelLang;
    return null;
  }

  function handleGetCode(reqId) {
    if (!consent) { send('code', { code: null, reason: 'no_consent' }, reqId); return; }
    const r = readEditor();
    if (r.code == null) { send('code', { code: null, reason: r.reason || 'no_editor', lang: readLanguage(null) }, reqId); return; }
    send('code', { code: r.code, lang: readLanguage(r.modelLang), source: r.source }, reqId);
  }

  // ---------- ISOLATED -> MAIN ----------
  function onMessage(ev) {
    try {
      if (ev.source !== window || ev.origin !== location.origin) return;
      const d = ev.data;
      if (!d || d.__recall !== true || d.from !== 'iso') return;
      const nonce = readNonce();
      if (!nonce || d.nonce !== nonce) return;
      const payload = d.payload || {};
      switch (d.type) {
        case 'hello':
          consent = !!payload.consent_code;
          send('ready', { capture, version: MAIN_VERSION, errors: wrapperErrors });
          flushBuffer();
          break;
        case 'config':
          consent = !!payload.consent_code;
          break;
        case 'get_code':
          handleGetCode(d.reqId);
          break;
        case 'ack':
          bufferRemove(payload.eventId);
          break;
        default:
          break;
      }
    } catch (_) { /* never throw into the page */ }
  }

  // ---------- install ----------
  try {
    window.addEventListener('message', onMessage);
    window.fetch = anchorFetch;
    XMLHttpRequest.prototype.open = anchorOpen;
    XMLHttpRequest.prototype.send = anchorSend;
    capture = 'on';
  } catch (e) {
    capture = 'off';
    recordError(e);
  }
  send('ready', { capture, version: MAIN_VERSION, errors: wrapperErrors });
})();
