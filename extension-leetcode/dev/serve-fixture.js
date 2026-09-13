#!/usr/bin/env node
'use strict';
/**
 * serve-fixture.js: a fake leetcode.com on http://localhost:4173 for offline extension testing.
 * No dependencies (http, fs, path, url only). Data comes from fixture/data/*.json (synthetic).
 *
 *   node extension-leetcode/dev/serve-fixture.js            # PORT=4173 by default
 *
 * Routes
 *   GET  /                                     302 -> the first target problem
 *   GET  /problems/:slug/*, /problemset/*      fixture/index.html (the fake problem page)
 *   GET  /page.js, /fake-monaco.js, /data/*    static files from fixture/
 *   POST /problems/:slug/submit/               {submission_id} (verdict from a '// verdict: X' marker, default AC)
 *   POST /problems/:slug/interpret_solution/   {interpret_id: 'runcode_...'} (Run Code noise)
 *   GET  /submissions/detail/:id/v2/check/     PENDING x2 then SUCCESS (keeps returning SUCCESS: dedupe test)
 *   GET  /submissions/detail/runcode_<id>/check/  Run Code result (must never be captured)
 *   POST /graphql/                             dispatched by operationName (see GQL below)
 *   GET  /api/submissions/?offset&limit&lastkey  REST dump pages, newest first (401 when logged out)
 *
 * Fault switches are cookies set by buttons on the page (value '1' = on):
 *   fake_logged_out  globalData says signed out, list rows are TO_DO, /api/submissions/ is 401
 *   fake_429         every 7th sync request (graphql or /api/submissions/) is 429 with Retry-After: 3
 *   fake_cf          sync requests answer 200 with a Cloudflare-style HTML challenge body
 *   fake_drift       questionDetail errors with 'Cannot query field "acRate"' while the query still has it
 * Paging is deliberately small (5 list rows, 8 dump rows per page) so the sync engine pages several times.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 4173;
const ROOT = path.join(__dirname, 'fixture');
const DATA = path.join(ROOT, 'data');
const LIST_PAGE_MAX = 5;
const DUMP_PAGE_MAX = 8;
const PENDING_POLLS = 2;
const FAKE_429_EVERY = 7;
const BODY_LIMIT = 2 * 1024 * 1024;
const CSRF = 'fixture-csrf-token';
const USER = { userId: 424242, username: 'fixture_student' };

// ---------- data ----------
function readJson(name) { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); }
const solved = readJson('solved.json');
const problems = readJson('problems.json');
const subsFile = readJson('submissions.json');
const skills = readJson('skills.json');

const SOLVED_ROWS = solved.questions;
const DUMP = subsFile.submissions.slice().sort((a, b) => b.timestamp - a.timestamp || b.id - a.id); // newest first
const DETAILS = subsFile.details;
const PROBLEM_SLUGS = Object.keys(problems);
const TARGET_SLUGS = PROBLEM_SLUGS.filter((s) => !SOLVED_ROWS.some((r) => r.titleSlug === s));

// ---------- in-memory session state ----------
let nextSubmissionId = 1900000001;
const liveSubmissions = new Map();  // id -> {slug, question_id, lang, typed_code, verdict, polls, timestamp}
const liveDump = [];                // REST-dump rows for submissions made in this session (newest first)
let syncRequestCount = 0;           // counts graphql + /api/submissions/ for the fake_429 switch
let runcodeCount = 0;

// ---------- verdict templates ----------
const OVERFLOW = "Line 14: Char 24: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int' (solution.cpp)";
const VERDICTS = {
  AC: { status_code: 10, status_msg: 'Accepted', total_correct: 44, total_testcases: 44, status_runtime: '18 ms', runtime_percentile: 91.3, status_memory: '12.4 MB', memory_percentile: 55.1, run_success: true, last_testcase: '', expected_output: '', code_output: '' },
  WA: { status_code: 11, status_msg: 'Wrong Answer', total_correct: 17, total_testcases: 44, status_runtime: 'N/A', runtime_percentile: null, run_success: true, last_testcase: '[1]', expected_output: '1', code_output: '0', compare_result: '11111111111111111000000000000000000000000000' },
  TLE: { status_code: 14, status_msg: 'Time Limit Exceeded', total_correct: 30, total_testcases: 44, status_runtime: 'N/A', runtime_percentile: null, run_success: false, last_testcase: '[3,1,5,8,3,1,5,8,3,1,5,8,3,1,5,8,3,1,5,8,3,1,5,8,3,1,5,8,3,1,5,8,3,1,5,8,3,1,5,8]', expected_output: '', code_output: '' },
  RE: { status_code: 15, status_msg: 'Runtime Error', total_correct: 12, total_testcases: 44, status_runtime: 'N/A', runtime_percentile: null, run_success: false, runtime_error: OVERFLOW, full_runtime_error: OVERFLOW + '\nSUMMARY: UndefinedBehaviorSanitizer: undefined-behavior solution.cpp:14:24', last_testcase: '[1000000000,1000000000,1000000000]', expected_output: '3000000000', code_output: '' },
  CE: { status_code: 20, status_msg: 'Compile Error', total_correct: null, total_testcases: null, status_runtime: 'N/A', runtime_percentile: null, run_success: false, compile_error: "Line 5: Char 20: error: expected ';' after expression", full_compile_error: "Line 5: Char 20: error: expected ';' after expression\n        int best = 0\n                   ^\n                   ;\n1 error generated.", last_testcase: '', expected_output: '', code_output: '' },
  MLE: { status_code: 12, status_msg: 'Memory Limit Exceeded', total_correct: 33, total_testcases: 44, status_runtime: 'N/A', runtime_percentile: null, run_success: false, status_memory: '900.1 MB', last_testcase: '5000\n[[1,2]]\n[1,1,1,1,1]', expected_output: '', code_output: '' },
  RESTRICT: { status_code: 50, status_msg: 'Restricted', total_correct: null, total_testcases: null, status_runtime: 'N/A', runtime_percentile: null, run_success: false, last_testcase: '', expected_output: '', code_output: '' }
};
const VERDICT_RE = /\/\/\s*verdict:\s*(AC|WA|TLE|RE|CE|MLE|RESTRICT)\b/i;

// ---------- helpers ----------
function now() { return new Date().toISOString().slice(11, 23); }
function log(req, status, extra) {
  const on = activeFaults(req);
  console.log(`[fixture] ${now()} ${req.method} ${req.url} -> ${status}${extra ? ' ' + extra : ''}${on.length ? ' faults=' + on.join(',') : ''}`);
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function fault(req, name) { return cookies(req)[name] === '1'; }
function activeFaults(req) {
  return ['fake_logged_out', 'fake_429', 'fake_cf', 'fake_drift'].filter((n) => fault(req, n)).map((n) => n.replace('fake_', ''));
}
function send(res, status, body, headers) {
  const h = Object.assign({ 'cache-control': 'no-store' }, headers || {});
  let payload = body;
  if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
    payload = JSON.stringify(body);
    h['content-type'] = h['content-type'] || 'application/json; charset=utf-8';
  }
  res.writeHead(status, h);
  res.end(payload === undefined ? '' : payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseJson(text) { try { return JSON.parse(text); } catch (_) { return null; } }
function pick(obj, keys) { const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; }
function b64(s) { return Buffer.from(String(s)).toString('base64'); }
function qidOf(slug) { return problems[slug] ? Number(problems[slug].questionId) : null; }
function titleOf(slug) { return problems[slug] ? problems[slug].title : slug; }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(req, res, rel) {
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { send(res, 404, { error: 'not_found' }); log(req, 404); return; }
  send(res, 200, fs.readFileSync(file), { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  log(req, 200);
}
function servePage(req, res, note) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'));
  send(res, 200, html, { 'content-type': MIME['.html'], 'set-cookie': `csrftoken=${CSRF}; Path=/; SameSite=Lax` });
  log(req, 200, note);
}

// A sync request (graphql or REST dump) passes through the fault switches first. Returns true when handled.
function applySyncFaults(req, res) {
  syncRequestCount++;
  if (fault(req, 'fake_429') && syncRequestCount % FAKE_429_EVERY === 0) {
    send(res, 429, { detail: 'Request was throttled (fixture fake_429).' }, { 'retry-after': '3' });
    log(req, 429, `sync_req=${syncRequestCount} retry-after=3`);
    return true;
  }
  if (fault(req, 'fake_cf')) {
    const html = '<!DOCTYPE html><html lang="en"><head><title>Just a moment...</title></head><body><h1>Checking your browser before accessing leetcode.com</h1><p>Fixture Cloudflare challenge (cookie fake_cf=1). Turn the switch off on the page, then Resume the sync.</p></body></html>';
    send(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge' });
    log(req, 200, 'challenge_html');
    return true;
  }
  return false;
}

// ---------- submissions (live) ----------
function registerSubmission(slug, body) {
  const code = typeof body.typed_code === 'string' ? body.typed_code : '';
  const m = VERDICT_RE.exec(code);
  const verdict = m ? m[1].toUpperCase() : 'AC';
  const id = nextSubmissionId++;
  const ts = Math.floor(Date.now() / 1000);
  const rec = { id, slug, question_id: body.question_id ?? qidOf(slug), lang: body.lang || 'cpp', typed_code: code, verdict, polls: 0, timestamp: ts };
  liveSubmissions.set(String(id), rec);
  const v = VERDICTS[verdict];
  liveDump.unshift({
    id, question_id: Number(rec.question_id) || 0, lang: rec.lang, lang_name: rec.lang === 'cpp' ? 'C++' : rec.lang, time: 'just now', timestamp: ts,
    status: v.status_code, status_display: v.status_msg, runtime: v.status_runtime || 'N/A', url: `/submissions/detail/${id}/`, is_pending: 'Not Pending',
    title: titleOf(slug), memory: v.status_memory || 'N/A', code, compare_result: '', title_slug: slug, has_notes: false, flag_type: 1, frontend_id: problems[slug] ? Number(problems[slug].questionFrontendId) : 0
  });
  return rec;
}

function checkPayload(rec, sid) {
  const v = VERDICTS[rec.verdict] || VERDICTS.AC;
  const finish = Math.floor(Date.now() / 1000);
  return Object.assign({
    state: 'SUCCESS', submission_id: String(sid), question_id: String(rec.question_id ?? ''), lang: rec.lang, pretty_lang: rec.lang === 'cpp' ? 'C++' : rec.lang,
    finished: true, task_finish_time: finish * 1000, task_name: `judger.judgetask.Judge.${sid}`, elapsed_time: 812, memory: 12400000,
    display_runtime: v.status_runtime === 'N/A' ? 'N/A' : String(parseInt(v.status_runtime, 10)), std_output: '', std_output_list: ['', ''], expected_std_output_list: ['', ''],
    runtime_error: '', full_runtime_error: '', compile_error: '', full_compile_error: '', input_formatted: v.last_testcase, input: v.last_testcase
  }, v);
}

function detailsFor(sid) {
  if (DETAILS[sid]) return DETAILS[sid];
  const rec = liveSubmissions.get(String(sid));
  if (!rec) return null;
  const v = VERDICTS[rec.verdict] || VERDICTS.AC;
  return {
    id: rec.id, runtime: v.status_code === 10 ? 18 : -1, runtimeDisplay: v.status_runtime || 'N/A', runtimePercentile: v.runtime_percentile, memory: 12400000, memoryDisplay: v.status_memory || 'N/A', memoryPercentile: v.memory_percentile ?? null,
    code: rec.typed_code, timestamp: rec.timestamp, statusCode: v.status_code, lang: { name: rec.lang, verboseName: rec.lang === 'cpp' ? 'C++' : rec.lang },
    question: { questionId: String(rec.question_id ?? ''), titleSlug: rec.slug }, notes: '', topicTags: (problems[rec.slug] ? problems[rec.slug].topicTags : []).map((t) => ({ slug: t.slug })),
    runtimeError: v.runtime_error || '', compileError: v.compile_error || '', lastTestcase: v.last_testcase || '', codeOutput: v.code_output || '', expectedOutput: v.expected_output || '',
    totalCorrect: v.total_correct, totalTestcases: v.total_testcases, fullCodeOutput: v.full_runtime_error || v.full_compile_error || ''
  };
}

// ---------- GraphQL ----------
const GQL = {
  globalData(req) {
    if (fault(req, 'fake_logged_out')) return { data: { userStatus: { userId: null, username: '', isSignedIn: false, isPremium: false } } };
    return { data: { userStatus: { userId: USER.userId, username: USER.username, isSignedIn: true, isPremium: false } } };
  },
  problemsetQuestionListV2(req, vars) {
    const limit = Math.max(1, Math.min(Number(vars.limit) || LIST_PAGE_MAX, LIST_PAGE_MAX));
    const skip = Math.max(0, Number(vars.skip) || 0);
    let rows;
    if (fault(req, 'fake_logged_out')) {
      // signed out: the SOLVED filter is silently ignored and the whole catalogue comes back as TO_DO
      rows = PROBLEM_SLUGS.map((slug) => {
        const p = problems[slug];
        return { id: p.questionId, titleSlug: slug, title: p.title, questionFrontendId: p.questionFrontendId, paidOnly: p.isPaidOnly, difficulty: p.difficulty.toUpperCase(), status: 'TO_DO', acRate: p.acRate, topicTags: p.topicTags };
      });
    } else {
      rows = SOLVED_ROWS;
    }
    const page = rows.slice(skip, skip + limit);
    return { data: { problemsetQuestionListV2: { questions: page, totalLength: rows.length, finishedLength: fault(req, 'fake_logged_out') ? 0 : rows.length, hasMore: skip + page.length < rows.length } }, note: `skip=${skip} rows=${page.length}/${rows.length}` };
  },
  problemsetQuestionList(req, vars) {
    const limit = Math.max(1, Math.min(Number(vars.limit) || LIST_PAGE_MAX, LIST_PAGE_MAX));
    const skip = Math.max(0, Number(vars.skip) || 0);
    const out = fault(req, 'fake_logged_out') ? 'notac' : 'ac';
    const rows = SOLVED_ROWS.map((r) => ({ titleSlug: r.titleSlug, title: r.title, frontendQuestionId: r.questionFrontendId, paidOnly: r.paidOnly, difficulty: r.difficulty[0] + r.difficulty.slice(1).toLowerCase(), status: out, acRate: r.acRate, topicTags: r.topicTags }));
    const page = rows.slice(skip, skip + limit);
    return { data: { problemsetQuestionList: { total: rows.length, questions: page } }, note: `v1 skip=${skip} rows=${page.length}/${rows.length}` };
  },
  skillStats(req, vars) {
    if (vars.username !== USER.username) return { data: { matchedUser: null } };
    return { data: { matchedUser: { tagProblemCounts: skills.tagProblemCounts } } };
  },
  userProfileUserQuestionProgressV2(req, vars) {
    if (vars.userSlug !== USER.username) return { data: { userProfileUserQuestionProgressV2: null } };
    return { data: { userProfileUserQuestionProgressV2: skills.progress } };
  },
  submissionList(req, vars) {
    if (fault(req, 'fake_logged_out')) return { data: { questionSubmissionList: null } };
    const slug = vars.questionSlug;
    const limit = Math.max(1, Number(vars.limit) || 1);
    const offset = Math.max(0, Number(vars.offset) || 0);
    const all = [...liveDump, ...DUMP].filter((s) => s.title_slug === slug);
    const page = all.slice(offset, offset + limit).map((s) => ({
      id: String(s.id), title: s.title, titleSlug: s.title_slug, status: null, statusDisplay: s.status_display, lang: s.lang, langName: s.lang_name,
      runtime: s.runtime, timestamp: String(s.timestamp), url: s.url, isPending: s.is_pending, memory: s.memory
    }));
    return { data: { questionSubmissionList: { lastKey: null, hasNext: offset + page.length < all.length, submissions: page } } };
  },
  submissionDetails(req, vars) {
    if (fault(req, 'fake_logged_out')) return { data: { submissionDetails: null } };
    const d = detailsFor(String(vars.submissionId));
    return { data: { submissionDetails: d ? Object.assign({}, d, { id: undefined }) : null }, note: d ? `id=${vars.submissionId}` : `id=${vars.submissionId} missing` };
  },
  questionDetail(req, vars, query) {
    if (fault(req, 'fake_drift') && /\bacRate\b/.test(query || '')) {
      return { errors: [{ message: 'Cannot query field "acRate" on type "QuestionNode".', locations: [{ line: 3, column: 60 }] }], data: null, note: 'drift: acRate rejected', status: 200 };
    }
    const p = problems[vars.titleSlug];
    if (!p) return { data: { question: null }, note: 'unknown slug' };
    const q = {
      questionId: p.questionId, questionFrontendId: p.questionFrontendId, title: p.title, titleSlug: p.titleSlug, difficulty: p.difficulty, isPaidOnly: p.isPaidOnly,
      acRate: p.acRate, topicTags: p.topicTags, similarQuestions: JSON.stringify(p.similarQuestions), hints: p.hints, stats: p.stats, content: p.content
    };
    if (fault(req, 'fake_drift')) delete q.acRate; // a pruned query would not ask for it
    return { data: { question: q } };
  }
};

async function handleGraphql(req, res) {
  const text = await readBody(req);
  const body = parseJson(text) || {};
  const op = body.operationName || (String(body.query || '').match(/^\s*(?:query|mutation)\s+(\w+)/) || [])[1] || '?';
  if (!req.headers['x-csrftoken']) console.log(`[fixture] ${now()} note: graphql ${op} without x-csrftoken header`);
  if (applySyncFaults(req, res)) return;
  const fn = GQL[op];
  if (!fn) { send(res, 200, { errors: [{ message: `Fixture has no handler for operation ${op}` }], data: null }); log(req, 200, `op=${op} unhandled`); return; }
  const out = fn(req, body.variables || {}, body.query);
  const payload = out.errors ? { errors: out.errors, data: out.data === undefined ? null : out.data } : { data: out.data };
  send(res, 200, payload);
  log(req, 200, `op=${op}${out.note ? ' ' + out.note : ''}`);
}

// ---------- REST dump ----------
function handleDump(req, res, url) {
  if (applySyncFaults(req, res)) return;
  if (fault(req, 'fake_logged_out')) { send(res, 401, { detail: 'Authentication credentials were not provided.' }); log(req, 401); return; }
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 20, DUMP_PAGE_MAX));
  const all = [...liveDump, ...DUMP];
  const page = all.slice(offset, offset + limit);
  const hasNext = offset + page.length < all.length;
  send(res, 200, { submissions_dump: page, has_next: hasNext, last_key: hasNext && page.length ? b64(page[page.length - 1].id) : null });
  log(req, 200, `offset=${offset} rows=${page.length}/${all.length} has_next=${hasNext}`);
}

// ---------- router ----------
const RE_PROBLEM = /^\/problems\/([a-z0-9-]+)(?:\/([a-z_]+)\/?)?\/?$/i;
const RE_SUBMIT = /^\/problems\/([a-z0-9-]+)\/submit\/?$/i;
const RE_RUN = /^\/problems\/([a-z0-9-]+)\/interpret_solution\/?$/i;
const RE_CHECK_V2 = /^\/submissions\/detail\/(\d+)\/v2\/check\/?$/;
const RE_CHECK_V1 = /^\/submissions\/detail\/(\d+)\/check\/?$/;
const RE_RUNCODE = /^\/submissions\/detail\/(runcode_[\w.-]+)\/check\/?$/;

async function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/') { send(res, 302, '', { location: `/problems/${TARGET_SLUGS[0] || PROBLEM_SLUGS[0]}/description/` }); log(req, 302); return; }
  if (m === 'GET' && p === '/favicon.ico') { send(res, 204, ''); return; }
  if (m === 'GET' && (p === '/page.js' || p === '/fake-monaco.js' || p === '/index.html' || p.startsWith('/data/'))) { serveStatic(req, res, p.slice(1)); return; }
  if (m === 'GET' && p === '/__fixture/meta') { send(res, 200, { targets: TARGET_SLUGS, solved: SOLVED_ROWS.map((r) => r.titleSlug), live_submissions: liveSubmissions.size, sync_requests: syncRequestCount }); log(req, 200); return; }

  if (m === 'POST' && p === '/graphql/') { await handleGraphql(req, res); return; }
  if (m === 'GET' && p === '/api/submissions/') { handleDump(req, res, url); return; }

  let x;
  if (m === 'POST' && (x = RE_SUBMIT.exec(p))) {
    const body = parseJson(await readBody(req)) || {};
    if (fault(req, 'fake_logged_out')) { send(res, 403, { error: 'You must be logged in to submit (fixture).' }); log(req, 403); return; }
    const rec = registerSubmission(x[1], body);
    send(res, 200, { submission_id: rec.id });
    log(req, 200, `submission_id=${rec.id} verdict=${rec.verdict} lang=${rec.lang} code_chars=${rec.typed_code.length}`);
    return;
  }
  if (m === 'POST' && (x = RE_RUN.exec(p))) {
    await readBody(req);
    const id = `runcode_${Math.floor(Date.now() / 1000)}.${(++runcodeCount).toString().padStart(4, '0')}`;
    send(res, 200, { interpret_id: id, test_case: '[3,1,5,8]', interpret_expected_id: id + '_expected' });
    log(req, 200, `interpret_id=${id}`);
    return;
  }
  if (m === 'GET' && (x = RE_RUNCODE.exec(p))) {
    send(res, 200, { state: 'SUCCESS', status_code: 10, status_msg: 'Accepted', run_success: true, code_answer: ['167'], expected_code_answer: ['167'], correct_answer: true, total_correct: 1, total_testcases: 1, status_runtime: '4 ms', lang: 'cpp', task_name: `judger.runcodetask.RunCode.${x[1]}` });
    log(req, 200, 'runcode noise (must not be captured)');
    return;
  }
  if (m === 'GET' && (x = RE_CHECK_V2.exec(p) || RE_CHECK_V1.exec(p))) {
    const sid = x[1];
    let rec = liveSubmissions.get(sid);
    if (!rec) {
      // unknown id (e.g. after an extension reload, or the page's "orphan check" button): answer as a finished AC
      rec = { id: Number(sid), slug: 'unknown', question_id: null, lang: 'cpp', typed_code: '', verdict: 'AC', polls: PENDING_POLLS, timestamp: Math.floor(Date.now() / 1000), orphan: true };
      liveSubmissions.set(sid, rec);
    }
    rec.polls++;
    if (rec.polls <= PENDING_POLLS) { send(res, 200, { state: 'PENDING' }); log(req, 200, `poll=${rec.polls} PENDING`); return; }
    send(res, 200, checkPayload(rec, sid));
    log(req, 200, `poll=${rec.polls} SUCCESS ${rec.verdict}${rec.orphan ? ' (orphan id)' : ''}${rec.polls > PENDING_POLLS + 1 ? ' (repeat: dedupe test)' : ''}`);
    return;
  }
  if (m === 'GET' && (RE_PROBLEM.test(p) || p === '/problems/' || p === '/problems' || p.startsWith('/problemset') || p.startsWith('/contest'))) {
    const pm = RE_PROBLEM.exec(p);
    servePage(req, res, pm ? `page slug=${pm[1]}${pm[2] ? ' tab=' + pm[2] : ''}${url.search ? ' ' + url.search : ''}` : 'page (non-problem)');
    return;
  }
  send(res, 404, { error: 'not_found', path: p });
  log(req, 404);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    try { send(res, 500, { error: 'fixture_error', message: String(err && err.message || err) }); } catch (_) { /* ignore */ }
    log(req, 500, String(err && err.message || err));
  });
});

server.listen(PORT, () => {
  console.log(`[fixture] fake leetcode on http://localhost:${PORT}`);
  console.log(`[fixture] targets: ${TARGET_SLUGS.join(', ')}`);
  console.log(`[fixture] solved: ${SOLVED_ROWS.length} problems, ${DUMP.length} submissions, ${Object.keys(DETAILS).length} details`);
  console.log('[fixture] open a problem: http://localhost:' + PORT + '/problems/' + (TARGET_SLUGS[0] || PROBLEM_SLUGS[0]) + '/description/');
});
