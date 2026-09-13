// Anchor: same-origin LeetCode HTTP/GraphQL client (ISOLATED world, classic script).
// Sends: HTTP requests to leetcode.com only (POST /graphql/, GET /api/submissions/); no chrome.* messages.
// Receives: nothing; called by lc-sync.js and lc-content.js through globalThis.AnchorLC.
// Hooks: AnchorLC.hooks.onDrift({operationName, fields}) fired when a GraphQL field is pruned;
//        per-call opts {signal, onBackoff({attempt, waitMs, status}), onHidden(), waitVisible}.

(function () {
  'use strict';

  if (globalThis.AnchorLC) return;

  const Q = globalThis.AnchorQueries || {};

  function cfg() { return globalThis.ANCHOR_CONFIG || {}; }
  function rateMs() { const v = Number(cfg().LC_RATE_MS); return v > 0 ? v : 1000; }

  const MAX_ATTEMPTS = 6;          // consecutive retriable failures before giving up
  const MAX_BACKOFF_MS = 60000;
  const MAX_RETRY_AFTER_MS = 120000;
  const MAX_DRIFT_RETRIES = 10;
  const LIST_PAGE = 100;
  const LIST_SKIP_CAP = 20000;
  const REST_PAGE = 20;
  const EXCERPT_MAX = 1500;
  const CONSTRAINTS_MAX = 1000;

  const STATUS_BY_DISPLAY = {
    'Accepted': 10, 'Wrong Answer': 11, 'Memory Limit Exceeded': 12, 'Output Limit Exceeded': 13,
    'Time Limit Exceeded': 14, 'Runtime Error': 15, 'Internal Error': 16, 'Compile Error': 20, 'Unknown Error': 21
  };

  class LcError extends Error {
    constructor(code, message, extra) {
      super(message || code);
      this.name = 'LcError';
      this.code = code;
      if (extra) Object.assign(this, extra);
    }
  }
  function isLcError(e, code) { return !!e && e.name === 'LcError' && (code === undefined || e.code === code); }
  function toPlain(e) {
    if (!e) return { code: 'unknown', message: 'unknown error' };
    return { code: e.code || 'unknown', message: String(e.message || e), status: e.status, retryAfterMs: e.retryAfterMs };
  }

  // ---------- pure helpers ----------
  function isHtml(text) { return /^\s*<(!doctype|html)/i.test(text || ''); }

  // Backoff for the n-th consecutive failure (attempt is 1-based), honouring Retry-After when present.
  function backoffMs(attempt, retryAfterHeader, nowMs) {
    const raw = retryAfterHeader == null ? '' : String(retryAfterHeader).trim();
    if (raw) {
      const secs = Number(raw);
      if (Number.isFinite(secs) && secs > 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(secs * 1000));
      const at = Date.parse(raw);
      if (Number.isFinite(at) && at - nowMs > 0) return Math.min(MAX_RETRY_AFTER_MS, at - nowMs);
    }
    return Math.min(MAX_BACKOFF_MS, 2000 * Math.pow(2, Math.max(0, attempt - 1)));
  }

  function csrfToken(cookieString) {
    const m = String(cookieString || '').match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Remove fields the live schema no longer has (same regex as lc-research/extract.js gql()).
  function pruneField(query, field) {
    return query.replace(new RegExp(`\\b${field}\\b(\\s*\\{[^{}]*(\\{[^{}]*\\}[^{}]*)*\\})?`, 'g'), '');
  }
  function unknownFields(errors) {
    const out = [];
    for (const e of errors || []) {
      const m = String(e && e.message || '').match(/Cannot query field ["'](\w+)["']/);
      if (m) out.push(m[1]);
    }
    return out;
  }

  // HTML -> text without touching the live DOM. <sup> becomes ^ so "10<sup>5</sup>" reads "10^5";
  // block ends become newlines so list items stay separable. DOMParser never loads images or runs scripts;
  // the tag-stripping fallback (no DOMParser) decodes the common entities itself.
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', le: '≤', ge: '≥' };
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k[0] === '#') {
        const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
    });
  }
  function stripTags(h) { return decodeEntities(h.replace(/<\/?[a-zA-Z!][^>]*>/g, '')); }
  function htmlToText(html) {
    if (!html) return '';
    let h = String(html)
      .replace(/<sup>\s*/gi, '^').replace(/\s*<\/sup>/gi, '')
      .replace(/<\/(li|p|ul|ol|div|pre|h[1-6]|tr)>|<br\s*\/?>/gi, '$&\n');
    let text = '';
    try {
      if (typeof DOMParser === 'function') {
        const doc = new DOMParser().parseFromString(h, 'text/html');
        text = (doc && doc.body) ? doc.body.textContent || '' : '';
      } else {
        text = stripTags(h);
      }
    } catch (_) {
      text = stripTags(h);
    }
    return text.replace(/ /g, ' ');
  }
  function collapse(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
  function clamp(text, n) { const s = String(text || ''); return s.length > n ? s.slice(0, n) : s; }

  function excerptOf(html) { return clamp(collapse(htmlToText(html)), EXCERPT_MAX); }

  function constraintsOf(html) {
    const lines = htmlToText(html).split(/\n+/);
    const keep = [];
    for (const raw of lines) {
      for (const sentence of collapse(raw).split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
        const s = sentence.trim();
        if (!s) continue;
        if (s.includes('<=') || s.includes('≤') || s.includes('10^')) keep.push(s);
      }
    }
    return clamp(keep.join('\n'), CONSTRAINTS_MAX);
  }

  function parseSimilar(raw) {
    try {
      const arr = JSON.parse(raw || '[]');
      return Array.isArray(arr) ? arr.map((s) => s && s.titleSlug).filter(Boolean) : [];
    } catch (_) { return []; }
  }

  function mapRestSubmission(s) {
    return {
      id: Number(s.id),
      slug: s.title_slug || null,
      title: s.title || null,
      status_code: s.status == null ? null : Number(s.status),
      status_msg: s.status_display || null,
      lang: s.lang || null,
      timestamp: s.timestamp == null ? null : Number(s.timestamp),
      code: typeof s.code === 'string' ? s.code : null
    };
  }

  function mapDetails(id, d) {
    if (!d) return null;
    return {
      submission_id: Number(id),
      last_testcase: d.lastTestcase ?? null,
      expected_output: d.expectedOutput ?? null,
      code_output: d.codeOutput ?? null,
      error_text: d.runtimeError || d.compileError || d.fullCodeOutput || null,
      runtime_percentile: d.runtimePercentile ?? null,
      total_correct: d.totalCorrect ?? null,
      total_testcases: d.totalTestcases ?? null,
      status_code: d.statusCode ?? null,
      timestamp: d.timestamp == null ? null : Number(d.timestamp),
      lang: (d.lang && d.lang.name) || null,
      slug: (d.question && d.question.titleSlug) || null,
      code: typeof d.code === 'string' ? d.code : null
    };
  }

  function mapListRowV2(r) {
    return {
      slug: r.titleSlug, title: r.title, frontendId: r.questionFrontendId == null ? null : String(r.questionFrontendId),
      paidOnly: !!r.paidOnly, difficulty: r.difficulty || null, acRate: r.acRate ?? null,
      tags: (r.topicTags || []).map((t) => t && t.slug).filter(Boolean)
    };
  }
  function mapListRowV1(r) {
    return {
      slug: r.titleSlug, title: r.title, frontendId: r.frontendQuestionId == null ? null : String(r.frontendQuestionId),
      paidOnly: !!r.paidOnly, difficulty: r.difficulty || null, acRate: r.acRate ?? null,
      tags: (r.topicTags || []).map((t) => t && t.slug).filter(Boolean)
    };
  }

  function flattenTagCounts(tagProblemCounts) {
    const out = {};
    if (!tagProblemCounts) return out;
    for (const tier of ['fundamental', 'intermediate', 'advanced']) {
      for (const t of tagProblemCounts[tier] || []) {
        if (t && t.tagSlug) out[t.tagSlug] = Number(t.problemsSolved) || 0;
      }
    }
    return out;
  }
  function mapProgress(p) {
    const bucket = (arr) => {
      const o = { easy: 0, medium: 0, hard: 0, total: 0 };
      for (const x of arr || []) {
        const k = String(x.difficulty || '').toLowerCase();
        const n = Number(x.count) || 0;
        if (k in o) o[k] = n;
        o.total += n;
      }
      return o;
    };
    return { accepted: bucket(p && p.numAcceptedQuestions), failed: bucket(p && p.numFailedQuestions), untouched: bucket(p && p.numUntouchedQuestions) };
  }

  // ---------- timing ----------
  function abortError() { return new LcError('aborted', 'aborted'); }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      function onAbort() { clearTimeout(t); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function waitVisible(signal, onHidden) {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined' || !document.hidden) return resolve();
      if (signal && signal.aborted) return reject(abortError());
      try { if (onHidden) onHidden(); } catch (_) { /* ignore */ }
      function check() {
        if (!document.hidden) { cleanup(); resolve(); }
      }
      function onAbort() { cleanup(); reject(abortError()); }
      function cleanup() {
        document.removeEventListener('visibilitychange', check);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      document.addEventListener('visibilitychange', check);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Serialises all callers so the 1 req/s spacing holds across concurrent users of the client.
  let chain = Promise.resolve();
  let lastReqAt = 0;
  let requestCount = 0;
  function throttle(opts) {
    const run = chain.then(async () => {
      if (opts.waitVisible !== false) await waitVisible(opts.signal, opts.onHidden);
      const wait = lastReqAt + rateMs() - Date.now();
      if (wait > 0) await sleep(wait, opts.signal);
      if (opts.signal && opts.signal.aborted) throw abortError();
      lastReqAt = Date.now();
    });
    chain = run.catch(() => {});
    return run;
  }

  // ---------- request ----------
  // Resolves {status, json, text}. Throws LcError codes: aborted | challenge | lc_logged_out | rate_limited | network.
  async function request(url, init, opts) {
    init = init || {};
    opts = opts || {};
    const headers = Object.assign({
      'accept': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'x-csrftoken': csrfToken(typeof document !== 'undefined' ? document.cookie : '')
    }, init.headers || {});
    if (init.body != null && !headers['content-type']) headers['content-type'] = 'application/json';
    const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
    let attempt = 0;
    for (;;) {
      attempt++;
      await throttle(opts);
      requestCount++;
      let res, text;
      try {
        res = await fetch(url, Object.assign({}, init, { headers, signal: opts.signal }));
        text = await res.text();
      } catch (err) {
        if (opts.signal && opts.signal.aborted) throw abortError();
        if (err && err.name === 'AbortError') throw abortError();
        if (attempt >= maxAttempts) throw new LcError('network', `network error after ${attempt} attempts: ${err && err.message}`);
        const waitMs = backoffMs(attempt, null, Date.now());
        notifyBackoff(opts, { attempt, waitMs, status: 0 });
        await sleep(waitMs, opts.signal);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
        const waitMs = backoffMs(attempt, ra, Date.now());
        if (attempt >= maxAttempts) throw new LcError('rate_limited', `HTTP ${res.status} after ${attempt} attempts`, { status: res.status, retryAfterMs: waitMs });
        notifyBackoff(opts, { attempt, waitMs, status: res.status });
        await sleep(waitMs, opts.signal);
        continue;
      }
      if (isHtml(text)) throw new LcError('challenge', `HTML page instead of JSON (HTTP ${res.status})`, { status: res.status });
      if (res.status === 401 || res.status === 403) throw new LcError('lc_logged_out', `HTTP ${res.status}`, { status: res.status });
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* leave null */ }
      return { status: res.status, json, text };
    }
  }
  function notifyBackoff(opts, info) {
    try { if (opts.onBackoff) opts.onBackoff(info); } catch (_) { /* ignore */ }
  }

  // ---------- GraphQL ----------
  async function gql(query, variables, operationName, opts) {
    let q = query;
    for (let i = 0; i < MAX_DRIFT_RETRIES; i++) {
      const { json, text } = await request(location.origin + '/graphql/', {
        method: 'POST',
        body: JSON.stringify({ query: q, variables: variables || {}, operationName })
      }, opts);
      if (!json) throw new LcError('bad_response', `GraphQL ${operationName}: non-JSON response: ${String(text || '').slice(0, 120)}`);
      const errs = json.errors || [];
      const unknown = unknownFields(errs);
      if (unknown.length) {
        for (const field of unknown) q = pruneField(q, field);
        try {
          const h = globalThis.AnchorLC && globalThis.AnchorLC.hooks && globalThis.AnchorLC.hooks.onDrift;
          if (h) h({ operationName, fields: unknown });
        } catch (_) { /* ignore */ }
        continue;
      }
      if (errs.length) throw new LcError('gql_error', `GraphQL ${operationName}: ${errs.map((e) => e && e.message).join(' | ')}`, { operationName });
      return json.data || {};
    }
    throw new LcError('gql_error', `GraphQL ${operationName}: too many schema-drift retries`, { operationName });
  }

  // ---------- high-level calls ----------
  async function whoami(opts) {
    const d = await gql(Q.Q_WHOAMI, {}, 'globalData', opts);
    const u = d.userStatus || {};
    return { isSignedIn: !!u.isSignedIn, username: u.username || null, userId: u.userId ?? null, isPremium: !!u.isPremium };
  }

  // Pages the solved list (V2, then V1 on GraphQL error). onPage(rows, {skip, total, mode}) may return false to stop.
  // Resolves {rows, total, mode, stopped}.
  async function listSolved(onPage, opts) {
    const rows = [];
    const seen = new Set();
    let skip = 0;
    let mode = 'v2';
    let total = null;
    let stopped = false;
    async function verifySignedIn() {
      const me = await whoami(opts);
      if (!me.isSignedIn) throw new LcError('lc_logged_out', 'LeetCode answered as an anonymous visitor');
    }
    function push(mapped) {
      for (const r of mapped) { if (r.slug && !seen.has(r.slug)) { seen.add(r.slug); rows.push(r); } }
    }
    for (;;) {
      if (mode === 'v2') {
        let d;
        try {
          d = await gql(Q.Q_LIST_V2, {
            categorySlug: 'all-code-essentials', limit: LIST_PAGE, skip,
            filters: { filterCombineType: 'ALL', statusFilter: { questionStatuses: ['SOLVED'], operator: 'IS' } }
          }, 'problemsetQuestionListV2', opts);
        } catch (err) {
          if (!isLcError(err, 'gql_error') && !isLcError(err, 'bad_response')) throw err;
          mode = 'v1'; skip = 0; rows.length = 0; seen.clear(); continue;
        }
        const page = d.problemsetQuestionListV2 || {};
        const raw = page.questions || [];
        const solved = raw.filter((r) => String(r.status || '').toUpperCase() === 'SOLVED');
        if (raw.length && solved.length === 0) {
          await verifySignedIn();
          // signed in but the filter is being ignored: the V2 list is unusable, try V1 once
          if (skip === 0) { mode = 'v1'; rows.length = 0; seen.clear(); continue; }
          throw new LcError('list_unusable', 'solved filter ignored by LeetCode');
        }
        push(solved.map(mapListRowV2));
        total = page.totalLength ?? total;
        if (onPage && (await onPage(rows, { skip, total, mode })) === false) { stopped = true; break; }
        if (!page.hasMore || raw.length === 0) break;
        skip += raw.length;
        if (skip > LIST_SKIP_CAP) break;
      } else {
        const d = await gql(Q.Q_LIST_V1, { categorySlug: '', limit: LIST_PAGE, skip, filters: { status: 'AC' } }, 'problemsetQuestionList', opts);
        const page = d.problemsetQuestionList || {};
        const raw = page.questions || [];
        const solved = raw.filter((r) => String(r.status || '').toLowerCase() === 'ac');
        if (raw.length && solved.length === 0) {
          await verifySignedIn();
          throw new LcError('list_unusable', 'solved filter ignored by LeetCode (v1)');
        }
        push(solved.map(mapListRowV1));
        total = page.total ?? total;
        if (onPage && (await onPage(rows, { skip, total, mode })) === false) { stopped = true; break; }
        if (raw.length === 0 || skip + raw.length >= (page.total || 0)) break;
        skip += raw.length;
        if (skip > LIST_SKIP_CAP) break;
      }
    }
    return { rows, total, mode, stopped };
  }

  async function skillStats(username, opts) {
    const d = await gql(Q.Q_SKILLS, { username }, 'skillStats', opts);
    const tpc = d.matchedUser && d.matchedUser.tagProblemCounts;
    return { tagCounts: flattenTagCounts(tpc), raw: tpc || null };
  }

  async function progress(username, opts) {
    const d = await gql(Q.Q_PROGRESS, { userSlug: username }, 'userProfileUserQuestionProgressV2', opts);
    return mapProgress(d.userProfileUserQuestionProgressV2 || null);
  }

  // Newest-first sweep of GET /api/submissions/. cursor = {offset, lastKey}. onPage(items, nextCursor, {hasNext})
  // may return false to stop early. opts.stopAtId: drop ids <= stopAtId and end the sweep (incremental sync).
  // Resolves {cursor, done, pages, stopped}.
  async function sweepSubmissions(cursor, onPage, opts) {
    opts = opts || {};
    let offset = Number(cursor && cursor.offset) || 0;
    let lastKey = (cursor && cursor.lastKey) || '';
    let pages = 0;
    const stopAtId = opts.stopAtId == null ? null : Number(opts.stopAtId);
    for (;;) {
      const url = `${location.origin}/api/submissions/?offset=${offset}&limit=${REST_PAGE}&lastkey=${encodeURIComponent(lastKey)}`;
      const { json, text } = await request(url, { method: 'GET' }, opts);
      if (!json || !Array.isArray(json.submissions_dump)) throw new LcError('bad_response', `REST submissions: unexpected body ${String(text || '').slice(0, 120)}`);
      const dump = json.submissions_dump;
      let items = dump.filter((s) => s && (s.is_pending == null || s.is_pending === 'Not Pending')).map(mapRestSubmission);
      let reachedOld = false;
      if (stopAtId != null) {
        const fresh = items.filter((s) => s.id > stopAtId);
        reachedOld = fresh.length < items.length;
        items = fresh;
      }
      offset += dump.length;
      lastKey = json.last_key || '';
      const hasNext = !!json.has_next && dump.length > 0 && !reachedOld;
      const next = { offset, lastKey, done: !hasNext };
      pages++;
      if (onPage && (await onPage(items, next, { hasNext })) === false) return { cursor: next, done: !hasNext, pages, stopped: true };
      if (!hasNext) return { cursor: next, done: true, pages, stopped: false };
    }
  }

  async function submissionDetails(id, opts) {
    const d = await gql(Q.Q_DETAILS, { submissionId: Number(id) }, 'submissionDetails', opts);
    return mapDetails(id, d.submissionDetails || null);
  }

  async function latestSubmissionForSlug(slug, opts) {
    const d = await gql(Q.Q_SUBS_FOR_PROBLEM, { offset: 0, limit: 1, lastKey: null, questionSlug: slug }, 'submissionList', opts);
    const page = d.questionSubmissionList || {};
    const s = (page.submissions || [])[0];
    if (!s) return { submission: null, details: null };
    const submission = {
      id: Number(s.id), slug: s.titleSlug || slug, title: s.title || null,
      status_code: STATUS_BY_DISPLAY[s.statusDisplay] ?? null, status_msg: s.statusDisplay || null,
      lang: s.lang || null, timestamp: s.timestamp == null ? null : Number(s.timestamp), is_pending: s.isPending ?? null
    };
    let details = null;
    if (submission.is_pending == null || submission.is_pending === 'Not Pending') {
      details = await submissionDetails(submission.id, opts);
      if (details && submission.status_code == null) submission.status_code = details.status_code;
      if (details && details.code != null) submission.code = details.code;
    }
    return { submission, details };
  }

  async function problemMeta(slug, opts) {
    const d = await gql(Q.Q_PROBLEM, { titleSlug: slug }, 'questionDetail', opts);
    const q = d.question;
    if (!q) return null;
    const content = q.content || '';
    return {
      slug: q.titleSlug || slug,
      questionId: q.questionId == null ? null : String(q.questionId),
      questionFrontendId: q.questionFrontendId == null ? null : String(q.questionFrontendId),
      title: q.title || null,
      difficulty: q.difficulty || null,
      isPaidOnly: !!q.isPaidOnly,
      acRate: q.acRate ?? null,
      topicTags: (q.topicTags || []).map((t) => t && t.slug).filter(Boolean),
      similarQuestions: parseSimilar(q.similarQuestions),
      hints: (q.hints || []).map((h) => collapse(htmlToText(h))).filter(Boolean),
      // Wire names read by PUT /api/lc/problems/:slug (problemService.normalizeProblem).
      statement_excerpt: excerptOf(content),
      constraints_text: constraintsOf(content)
    };
  }

  globalThis.AnchorLC = {
    LcError, isLcError, toPlain, STATUS_BY_DISPLAY,
    hooks: { onDrift: null },
    request, gql,
    whoami, listSolved, skillStats, progress, sweepSubmissions, submissionDetails, latestSubmissionForSlug, problemMeta,
    stats: () => ({ requests: requestCount, lastReqAt }),
    // pure helpers exposed for tests/fixtures
    _pure: { isHtml, backoffMs, csrfToken, pruneField, unknownFields, htmlToText, excerptOf, constraintsOf, mapRestSubmission, mapDetails, flattenTagCounts, mapProgress, parseSimilar }
  };
})();
