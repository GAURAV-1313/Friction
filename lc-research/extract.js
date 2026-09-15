#!/usr/bin/env node
'use strict';
/**
 * LeetCode account export (for the Recall tutor calibration study).
 *
 * Standalone: Node >= 18, no npm install needed. Run it ON THE ACCOUNT OWNER'S machine,
 * while they are logged in to leetcode.com in a browser.
 *
 *   LEETCODE_COOKIE="LEETCODE_SESSION=<value>; csrftoken=<value>" node extract.js
 *
 * How to get the two cookie values (Chrome): open https://leetcode.com while logged in,
 * press F12 -> Application tab -> Storage -> Cookies -> https://leetcode.com, copy the
 * "Value" column for LEETCODE_SESSION and for csrftoken. Never share the cookie itself;
 * only share the output folder this script creates.
 *
 * Options:
 *   --out <dir>        output folder (default: ./lc-export-<username>-<YYYYMMDD>)
 *   --rate <n>         max requests per second (default 1; do not go above 2)
 *   --details <mode>   all | failed-plus-first-ac (default) | none
 *   --families <list>  restrict per-submission details + problem metadata to families,
 *                      e.g. --families dp,graph   (default: all)
 *   --no-content       do not download problem statements
 *   --check            only verify login, print counts + time estimate, download nothing
 *   --resume           continue an interrupted run into the same --out folder
 *
 * What it downloads (all of it is the account owner's own data):
 *   whoami.json, profile.json         identity, per-tag solved counts, difficulty progress
 *   solved.json, attempted.json       every solved / attempted problem with tags+difficulty
 *   submissions.json                  every submission ever made (verdict, lang, time, code)
 *   problems/<slug>.json              problem metadata (tags, similar questions, hints, statement)
 *   details/<id>.json                 per-submission judge details (failing test, expected vs got,
 *                                     runtime error text, runtime percentile)
 *   manifest.json                     counts + settings used
 */

const fs = require('fs');
const path = require('path');

// ---------- CLI ----------
const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}
const RATE = Math.min(2, Math.max(0.2, Number(flag('rate', 1)) || 1));
const DETAILS_MODE = String(flag('details', 'failed-plus-first-ac'));
const FAMILIES = String(flag('families', 'all')).split(',').map((s) => s.trim()).filter(Boolean);
const WANT_CONTENT = !args.includes('--no-content');
const CHECK_ONLY = args.includes('--check');
const RESUME = args.includes('--resume');
let OUT = flag('out', null);

// ---------- cookie ----------
const COOKIE = (process.env.LEETCODE_COOKIE || '').trim() ||
  (process.env.LEETCODE_SESSION ? `LEETCODE_SESSION=${process.env.LEETCODE_SESSION}; csrftoken=${process.env.CSRFTOKEN || process.env.csrftoken || ''}` : '');
if (!COOKIE) {
  console.error('Missing LEETCODE_COOKIE.\n\nRun like this (values from your browser cookies for leetcode.com):\n  LEETCODE_COOKIE="LEETCODE_SESSION=...; csrftoken=..." node extract.js\n');
  process.exit(1);
}
const CSRF = (COOKIE.match(/csrftoken=([^;]+)/) || [])[1] || '';
if (!/LEETCODE_SESSION=/.test(COOKIE)) console.warn('Warning: cookie has no LEETCODE_SESSION; session-only data will fail.');
if (!CSRF) console.warn('Warning: cookie has no csrftoken; some requests may be rejected.');

const BASE = 'https://leetcode.com';
const HEADERS = {
  'content-type': 'application/json',
  'accept': 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'referer': BASE + '/',
  'origin': BASE,
  'cookie': COOKIE,
  'x-csrftoken': CSRF,
  'x-requested-with': 'XMLHttpRequest'
};

// ---------- utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReqAt = 0;
let requestCount = 0;
async function throttle() {
  const gap = 1000 / RATE;
  const wait = lastReqAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
}
function isHtml(text) { return /^\s*<(!doctype|html)/i.test(text || ''); }

async function request(url, { method = 'GET', body = null, extraHeaders = {} } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    await throttle();
    requestCount++;
    let res, text;
    try {
      res = await fetch(url, { method, headers: { ...HEADERS, ...extraHeaders }, body });
      text = await res.text();
    } catch (err) {
      if (attempt >= 6) throw new Error(`network error after ${attempt} attempts: ${err.message}`);
      const wait = 2000 * Math.pow(2, attempt - 1);
      console.warn(`  network error (${err.message}); retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 429 || res.status >= 500 || (res.status === 403 && isHtml(text))) {
      if (attempt >= 6) throw new Error(`HTTP ${res.status} after ${attempt} attempts (${isHtml(text) ? 'HTML/challenge page' : text.slice(0, 200)})`);
      const ra = Number(res.headers.get('retry-after'));
      const wait = ra > 0 ? ra * 1000 : Math.min(60000, 2000 * Math.pow(2, attempt));
      console.warn(`  HTTP ${res.status}${isHtml(text) ? ' (challenge page)' : ''}; backing off ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (isHtml(text)) throw new Error(`got an HTML page instead of JSON from ${url} (HTTP ${res.status}) - are you logged in / is Cloudflare blocking?`);
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* leave null */ }
    return { status: res.status, json, text };
  }
}

// GraphQL with automatic pruning of fields the schema no longer has.
async function gql(query, variables, operationName) {
  let q = query;
  for (let i = 0; i < 10; i++) {
    const { status, json, text } = await request(BASE + '/graphql/', {
      method: 'POST',
      body: JSON.stringify({ query: q, variables, operationName })
    });
    if (status === 401 || status === 403) throw new Error(`GraphQL ${operationName}: HTTP ${status} - session rejected`);
    if (!json) throw new Error(`GraphQL ${operationName}: non-JSON response: ${text.slice(0, 200)}`);
    const errs = json.errors || [];
    const unknown = errs.map((e) => (e.message || '').match(/Cannot query field ["'](\w+)["']/)).filter(Boolean);
    if (unknown.length) {
      for (const m of unknown) {
        const field = m[1];
        q = q.replace(new RegExp(`\\b${field}\\b(\\s*\\{[^{}]*(\\{[^{}]*\\}[^{}]*)*\\})?`, 'g'), '');
      }
      console.warn(`  schema drift in ${operationName}: dropped field(s) ${unknown.map((m) => m[1]).join(', ')} and retrying`);
      continue;
    }
    if (errs.length) throw new Error(`GraphQL ${operationName}: ${errs.map((e) => e.message).join(' | ')}`);
    return json.data;
  }
  throw new Error(`GraphQL ${operationName}: too many schema-drift retries`);
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return def; }
}

const DP_TAGS = new Set(['dynamic-programming', 'memoization', 'bitmask', 'game-theory', 'knapsack-problem', 'complete-knapsack', 'dp-on-trees', 'longest-increasing-subsequence', 'longest-common-subsequence', '0-1-knapsack', 'multiple-knapsack', 'mixed-knapsack', 'minimax-algorithm', 'zero-sum-game', 'impartial-game', 'sprague-grundy-theorem', 'combinatorics']);
const GRAPH_TAGS = new Set(['graph', 'breadth-first-search', 'depth-first-search', 'topological-sort', 'shortest-path', 'union-find', 'minimum-spanning-tree', 'strongly-connected-component', 'biconnected-component', 'eulerian-circuit', 'dijkstra', 'directed-acyclic-graph', 'bipartite-graph', 'graph-coloring', 'kosarajus-algorithm', 'tarjans-scc-algorithm', 'bellman-ford-algorithm', 'floyd-warshall-algorithm', 'prims-algorithm', 'kruskals-algorithm', 'boruvkas-algorithm', '0-1-bfs', 'bidirectional-search', 'a-search', 'heuristic-search', 'eulerian-path', 'eulerian-graph', 'semi-eulerian-graph', 'hamiltonian-path', 'articulation-point', 'bridge-graph', 'matching-graph', 'maximum-matching', 'flow-network', 'maximum-flow', 'k-shortest-path', 'lowest-common-ancestor', 'binary-lifting']);
function familiesOf(tagSlugs) {
  const f = new Set();
  for (const t of tagSlugs || []) {
    if (DP_TAGS.has(t)) f.add('dp');
    if (GRAPH_TAGS.has(t)) f.add('graph');
  }
  return [...f];
}
function inScope(tagSlugs) {
  if (FAMILIES.includes('all')) return true;
  const fams = familiesOf(tagSlugs);
  return fams.some((f) => FAMILIES.includes(f));
}

// ---------- queries ----------
const Q_WHOAMI = `query globalData { userStatus { userId username isSignedIn isPremium } }`;
const Q_SKILLS = `query skillStats($username: String!) { matchedUser(username: $username) { tagProblemCounts { advanced { tagName tagSlug problemsSolved } intermediate { tagName tagSlug problemsSolved } fundamental { tagName tagSlug problemsSolved } } } }`;
const Q_PROGRESS = `query userProfileUserQuestionProgressV2($userSlug: String!) { userProfileUserQuestionProgressV2(userSlug: $userSlug) { numAcceptedQuestions { count difficulty } numFailedQuestions { count difficulty } numUntouchedQuestions { count difficulty } } }`;
const Q_LIST_V2 = `query problemsetQuestionListV2($filters: QuestionFilterInput, $limit: Int, $skip: Int, $categorySlug: String) {
  problemsetQuestionListV2(filters: $filters, limit: $limit, skip: $skip, categorySlug: $categorySlug) {
    questions { id titleSlug title questionFrontendId paidOnly difficulty status acRate topicTags { name slug } }
    totalLength finishedLength hasMore
  }
}`;
const Q_LIST_V1 = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList: questionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
    total: totalNum
    questions: data { titleSlug title frontendQuestionId: questionFrontendId paidOnly: isPaidOnly difficulty status acRate topicTags { name slug } }
  }
}`;
const Q_SUBS_FOR_PROBLEM = `query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String!) {
  questionSubmissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
    lastKey hasNext
    submissions { id title titleSlug status statusDisplay lang langName runtime timestamp url isPending memory }
  }
}`;
const Q_DETAILS = `query submissionDetails($submissionId: Int!) {
  submissionDetails(submissionId: $submissionId) {
    runtime runtimeDisplay runtimePercentile memory memoryDisplay memoryPercentile
    code timestamp statusCode
    lang { name verboseName }
    question { questionId titleSlug }
    notes topicTags { slug }
    runtimeError compileError lastTestcase codeOutput expectedOutput totalCorrect totalTestcases fullCodeOutput
  }
}`;
const Q_PROBLEM = `query questionDetail($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId questionFrontendId title titleSlug difficulty isPaidOnly acRate
    topicTags { name slug } similarQuestions hints stats
    ${WANT_CONTENT ? 'content' : ''}
  }
}`;

// ---------- steps ----------
async function whoami() {
  const d = await gql(Q_WHOAMI, {}, 'globalData');
  return d.userStatus || {};
}

async function fetchList(statusFilter) {
  // statusFilter: 'SOLVED' | 'ATTEMPTED'
  const out = [];
  let skip = 0;
  let mode = 'v2';
  for (;;) {
    if (mode === 'v2') {
      let d;
      try {
        d = await gql(Q_LIST_V2, {
          categorySlug: 'all-code-essentials', limit: 100, skip,
          filters: { filterCombineType: 'ALL', statusFilter: { questionStatuses: [statusFilter], operator: 'IS' } }
        }, 'problemsetQuestionListV2');
      } catch (err) {
        console.warn(`  V2 list failed (${err.message.slice(0, 120)}); falling back to V1 questionList`);
        mode = 'v1'; skip = 0; out.length = 0; continue;
      }
      const page = d.problemsetQuestionListV2 || {};
      const rows = page.questions || [];
      for (const r of rows) {
        // never trust the filter: a logged-out session silently returns the whole catalogue
        if (String(r.status || '').toUpperCase() !== statusFilter) continue;
        out.push({ titleSlug: r.titleSlug, title: r.title, questionFrontendId: r.questionFrontendId, paidOnly: !!r.paidOnly, difficulty: r.difficulty, status: r.status, acRate: r.acRate, topicTags: (r.topicTags || []).map((t) => t.slug) });
      }
      process.stdout.write(`\r  ${statusFilter}: ${out.length} rows (page skip=${skip}, total=${page.totalLength})   `);
      if (!page.hasMore || rows.length === 0) break;
      skip += rows.length;
      if (skip > 20000) break;
    } else {
      const d = await gql(Q_LIST_V1, { categorySlug: '', limit: 100, skip, filters: { status: statusFilter === 'SOLVED' ? 'AC' : 'NOT_STARTED' } }, 'problemsetQuestionList');
      const page = d.problemsetQuestionList || {};
      const rows = page.questions || [];
      for (const r of rows) {
        const st = String(r.status || '').toLowerCase();
        if (statusFilter === 'SOLVED' && st !== 'ac') continue;
        if (statusFilter === 'ATTEMPTED' && st !== 'notac') continue;
        out.push({ titleSlug: r.titleSlug, title: r.title, questionFrontendId: r.frontendQuestionId, paidOnly: !!r.paidOnly, difficulty: r.difficulty, status: r.status, acRate: r.acRate, topicTags: (r.topicTags || []).map((t) => t.slug) });
      }
      process.stdout.write(`\r  ${statusFilter} (v1): ${out.length} rows (skip=${skip}, total=${page.total})   `);
      if (rows.length === 0 || skip + rows.length >= (page.total || 0)) break;
      skip += rows.length;
    }
  }
  process.stdout.write('\n');
  return out;
}

async function sweepSubmissionsRest(state, file) {
  // GET /api/submissions/?offset=&limit=20&lastkey=  -> { submissions_dump: [...], has_next, last_key }
  const subs = readJson(file, []);
  const seen = new Set(subs.map((s) => String(s.id)));
  let offset = state.sweep?.offset || 0;
  let lastKey = state.sweep?.lastKey || '';
  if (state.sweep?.done) return subs;
  for (;;) {
    const url = `${BASE}/api/submissions/?offset=${offset}&limit=20&lastkey=${encodeURIComponent(lastKey)}`;
    const { status, json, text } = await request(url);
    if (status === 401 || status === 403) throw new Error(`REST submissions: HTTP ${status}`);
    if (!json || !Array.isArray(json.submissions_dump)) throw new Error(`REST submissions: unexpected body ${text.slice(0, 200)}`);
    for (const s of json.submissions_dump) {
      if (seen.has(String(s.id))) continue;
      seen.add(String(s.id));
      subs.push({
        id: s.id, titleSlug: s.title_slug, title: s.title, questionFrontendId: s.frontend_id || null, questionId: s.question_id || null,
        statusCode: s.status, statusDisplay: s.status_display, lang: s.lang, langName: s.lang_name,
        runtime: s.runtime, memory: s.memory, timestamp: s.timestamp, time: s.time, isPending: s.is_pending,
        hasNotes: s.has_notes, flagType: s.flag_type, compareResult: s.compare_result || null, code: s.code || null, source: 'rest'
      });
    }
    offset += json.submissions_dump.length;
    lastKey = json.last_key || '';
    state.sweep = { offset, lastKey, done: !json.has_next };
    writeJson(file, subs);
    writeJson(path.join(OUT, 'state.json'), state);
    process.stdout.write(`\r  submissions: ${subs.length} (offset ${offset})   `);
    if (!json.has_next || json.submissions_dump.length === 0) break;
  }
  process.stdout.write('\n');
  state.sweep.done = true;
  writeJson(path.join(OUT, 'state.json'), state);
  return subs;
}

async function sweepSubmissionsGraphql(slugs, state, file) {
  const subs = readJson(file, []);
  const seen = new Set(subs.map((s) => String(s.id)));
  const done = new Set(state.gqlSweepDone || []);
  let i = 0;
  for (const slug of slugs) {
    i++;
    if (done.has(slug)) continue;
    let offset = 0, lastKey = null;
    for (;;) {
      const d = await gql(Q_SUBS_FOR_PROBLEM, { offset, limit: 20, lastKey, questionSlug: slug }, 'submissionList');
      const page = d.questionSubmissionList;
      if (!page) throw new Error('questionSubmissionList returned null - session expired?');
      for (const s of page.submissions || []) {
        if (seen.has(String(s.id))) continue;
        seen.add(String(s.id));
        subs.push({ id: Number(s.id), titleSlug: s.titleSlug || slug, title: s.title, statusCode: null, statusDisplay: s.statusDisplay, lang: s.lang, langName: s.langName, runtime: s.runtime, memory: s.memory, timestamp: Number(s.timestamp), isPending: s.isPending, code: null, source: 'graphql' });
      }
      if (!page.hasNext) break;
      offset += (page.submissions || []).length;
      lastKey = page.lastKey;
    }
    done.add(slug);
    state.gqlSweepDone = [...done];
    if (i % 10 === 0) { writeJson(file, subs); writeJson(path.join(OUT, 'state.json'), state); }
    process.stdout.write(`\r  submissions via GraphQL: problem ${i}/${slugs.length}, ${subs.length} rows   `);
  }
  process.stdout.write('\n');
  writeJson(file, subs);
  writeJson(path.join(OUT, 'state.json'), state);
  return subs;
}

const STATUS_BY_DISPLAY = { 'Accepted': 10, 'Wrong Answer': 11, 'Memory Limit Exceeded': 12, 'Output Limit Exceeded': 13, 'Time Limit Exceeded': 14, 'Runtime Error': 15, 'Internal Error': 16, 'Compile Error': 20, 'Unknown Error': 21 };

function planDetails(subs, tagsBySlug) {
  if (DETAILS_MODE === 'none') return [];
  const byProblem = new Map();
  for (const s of subs) {
    if (s.isPending && s.isPending !== 'Not Pending') continue;
    if (!byProblem.has(s.titleSlug)) byProblem.set(s.titleSlug, []);
    byProblem.get(s.titleSlug).push(s);
  }
  const wanted = [];
  for (const [slug, list] of byProblem) {
    if (!inScope(tagsBySlug.get(slug))) continue;
    list.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    let firstAcSeen = false;
    for (const s of list) {
      const code = s.statusCode ?? STATUS_BY_DISPLAY[s.statusDisplay] ?? null;
      const isAc = code === 10;
      if (DETAILS_MODE === 'all') { wanted.push(s.id); continue; }
      if (!isAc) { wanted.push(s.id); continue; }
      if (!firstAcSeen) { wanted.push(s.id); firstAcSeen = true; }
    }
  }
  return wanted;
}

async function fetchDetails(ids) {
  const dir = path.join(OUT, 'details');
  fs.mkdirSync(dir, { recursive: true });
  let done = 0, skipped = 0, failed = 0;
  const started = Date.now();
  for (const id of ids) {
    const file = path.join(dir, `${id}.json`);
    if (fs.existsSync(file)) { skipped++; continue; }
    try {
      const d = await gql(Q_DETAILS, { submissionId: Number(id) }, 'submissionDetails');
      if (!d.submissionDetails) { failed++; writeJson(file, { id, error: 'null (not your submission / session expired?)' }); }
      else writeJson(file, { id, ...d.submissionDetails });
    } catch (err) {
      failed++;
      writeJson(file, { id, error: err.message });
      if (/session rejected|expired/i.test(err.message)) throw err;
    }
    done++;
    const rate = done / ((Date.now() - started) / 1000);
    const left = ids.length - done - skipped;
    process.stdout.write(`\r  details: ${done + skipped}/${ids.length} (failed ${failed}) ~${Math.round(left / Math.max(rate, 0.1) / 60)} min left   `);
  }
  process.stdout.write('\n');
  return { done, skipped, failed };
}

async function fetchProblems(slugs) {
  const dir = path.join(OUT, 'problems');
  fs.mkdirSync(dir, { recursive: true });
  let done = 0, skipped = 0, failed = 0;
  for (const slug of slugs) {
    const file = path.join(dir, `${slug}.json`);
    if (fs.existsSync(file)) { skipped++; continue; }
    try {
      const d = await gql(Q_PROBLEM, { titleSlug: slug }, 'questionDetail');
      const q = d.question;
      if (!q) { failed++; writeJson(file, { titleSlug: slug, error: 'null' }); }
      else {
        let similar = [];
        try { similar = JSON.parse(q.similarQuestions || '[]'); } catch (_) { /* ignore */ }
        writeJson(file, { ...q, topicTags: (q.topicTags || []).map((t) => t.slug), similarQuestions: similar.map((s) => s.titleSlug), similarQuestionsRaw: similar });
      }
    } catch (err) { failed++; writeJson(file, { titleSlug: slug, error: err.message }); }
    done++;
    process.stdout.write(`\r  problems: ${done + skipped}/${slugs.length} (failed ${failed})   `);
  }
  process.stdout.write('\n');
  return { done, skipped, failed };
}

// ---------- main ----------
(async function main() {
  console.log(`LeetCode export - rate ${RATE} req/s, details=${DETAILS_MODE}, families=${FAMILIES.join(',')}, content=${WANT_CONTENT}`);
  console.log('1/6 checking login...');
  const me = await whoami();
  if (!me.isSignedIn || !me.username) {
    console.error('Not signed in. LeetCode answered as an anonymous visitor, so the cookie is missing, expired, or from another browser profile. Copy fresh LEETCODE_SESSION + csrftoken values and try again.');
    process.exit(2);
  }
  console.log(`  signed in as ${me.username}${me.isPremium ? ' (premium)' : ''}`);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (!OUT) OUT = path.resolve(`lc-export-${me.username}-${today}`);
  OUT = path.resolve(OUT);
  if (fs.existsSync(OUT) && !RESUME && !CHECK_ONLY) {
    const files = fs.readdirSync(OUT);
    if (files.length) { console.error(`Output folder ${OUT} already exists and is not empty. Add --resume to continue it, or pick another --out.`); process.exit(3); }
  }
  fs.mkdirSync(OUT, { recursive: true });
  const state = RESUME ? readJson(path.join(OUT, 'state.json'), {}) : {};
  writeJson(path.join(OUT, 'whoami.json'), { username: me.username, userId: me.userId, isPremium: me.isPremium, exportedAt: new Date().toISOString() });

  console.log('2/6 profile...');
  const profile = { username: me.username };
  try { profile.tagProblemCounts = (await gql(Q_SKILLS, { username: me.username }, 'skillStats')).matchedUser?.tagProblemCounts || null; } catch (e) { profile.tagProblemCountsError = e.message; }
  try { profile.progress = (await gql(Q_PROGRESS, { userSlug: me.username }, 'userProfileUserQuestionProgressV2')).userProfileUserQuestionProgressV2 || null; } catch (e) { profile.progressError = e.message; }
  writeJson(path.join(OUT, 'profile.json'), profile);
  const accepted = (profile.progress?.numAcceptedQuestions || []).reduce((n, x) => n + (x.count || 0), 0);
  console.log(`  LeetCode reports ${accepted} accepted problems`);

  console.log('3/6 solved + attempted lists...');
  const solved = RESUME && fs.existsSync(path.join(OUT, 'solved.json')) ? readJson(path.join(OUT, 'solved.json'), []) : await fetchList('SOLVED');
  writeJson(path.join(OUT, 'solved.json'), solved);
  const attempted = RESUME && fs.existsSync(path.join(OUT, 'attempted.json')) ? readJson(path.join(OUT, 'attempted.json'), []) : await fetchList('ATTEMPTED');
  writeJson(path.join(OUT, 'attempted.json'), attempted);
  if (solved.length === 0) {
    console.error('The solved list came back empty even though you are signed in. LeetCode may have changed the list API; send me the console output above.');
    process.exit(4);
  }
  if (accepted && Math.abs(accepted - solved.length) > Math.max(5, accepted * 0.05)) {
    console.warn(`  warning: list has ${solved.length} solved but profile says ${accepted}; continuing`);
  }
  const tagsBySlug = new Map();
  for (const r of [...solved, ...attempted]) tagsBySlug.set(r.titleSlug, r.topicTags);
  const famCount = { dp: 0, graph: 0 };
  for (const r of solved) for (const f of familiesOf(r.topicTags)) famCount[f]++;
  console.log(`  solved ${solved.length} (dp ${famCount.dp}, graph ${famCount.graph}), attempted-not-solved ${attempted.length}`);

  if (CHECK_ONLY) {
    const est = solved.length * 1.8 / 20 + solved.length + attempted.length;
    console.log(`\nCheck complete. A full run would make roughly ${Math.round(est)}+ requests before per-submission details, i.e. about ${Math.round(est / RATE / 60)} minutes plus details. Re-run without --check to export.`);
    return;
  }

  console.log('4/6 all submissions...');
  const subsFile = path.join(OUT, 'submissions.json');
  let subs;
  try {
    subs = await sweepSubmissionsRest(state, subsFile);
  } catch (err) {
    console.warn(`  REST submissions sweep failed (${err.message.slice(0, 160)}); using per-problem GraphQL instead`);
    const slugs = [...new Set([...solved, ...attempted].map((r) => r.titleSlug))];
    subs = await sweepSubmissionsGraphql(slugs, state, subsFile);
  }
  const counts = {};
  for (const s of subs) counts[s.statusDisplay || s.statusCode] = (counts[s.statusDisplay || s.statusCode] || 0) + 1;
  console.log(`  ${subs.length} submissions: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  console.log('5/6 problem metadata...');
  const allSlugs = new Set([...solved, ...attempted].map((r) => r.titleSlug));
  for (const s of subs) if (s.titleSlug) allSlugs.add(s.titleSlug);
  const problemSlugs = [...allSlugs].filter((slug) => !tagsBySlug.has(slug) || inScope(tagsBySlug.get(slug)));
  console.log(`  ${problemSlugs.length} problems in scope (~${Math.round(problemSlugs.length / RATE / 60)} min)`);
  const pr = await fetchProblems(problemSlugs);
  for (const slug of problemSlugs) {
    if (!tagsBySlug.has(slug)) {
      const p = readJson(path.join(OUT, 'problems', `${slug}.json`), null);
      if (p && p.topicTags) tagsBySlug.set(slug, p.topicTags);
    }
  }

  console.log('6/6 per-submission details...');
  const wanted = planDetails(subs, tagsBySlug);
  console.log(`  ${wanted.length} submissions planned (~${Math.round(wanted.length / RATE / 60)} min)`);
  const dr = await fetchDetails(wanted);

  const manifest = {
    username: me.username, exportedAt: new Date().toISOString(), settings: { rate: RATE, details: DETAILS_MODE, families: FAMILIES, content: WANT_CONTENT },
    counts: { solved: solved.length, attempted: attempted.length, submissions: subs.length, submissionsByStatus: counts, problems: pr, details: dr, requests: requestCount }
  };
  writeJson(path.join(OUT, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(OUT, 'README.txt'), `LeetCode export for ${me.username} made ${manifest.exportedAt}\nThis folder contains this account's own submissions including source code. Zip the whole folder and send it.\nNothing in here contains the login cookie.\n`);
  console.log(`\nDone. ${requestCount} requests. Output: ${OUT}\nZip that whole folder and send it over.`);
})().catch((err) => {
  console.error('\nFailed:', err.message);
  console.error('If this was a rate limit or network blip, re-run the same command with --resume.');
  process.exit(1);
});
