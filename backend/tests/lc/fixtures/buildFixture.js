'use strict';
// In-memory synthetic student history for the Recall domain goldens (port of lc-research/make_fixture.js).
// Deterministic: a seeded LCG drives every varying quantity; timestamps are relative to FIXTURE_NOW, never Date.now().
// No real student code or data: slugs come from the shipped seed/catalog, verdict details are synthesized,
// and the only `code` fields are the hand-written snippets in ./snippets.js.
//
// Planted signals (all C++):
//   1. dp.interval bucket habit, LIVE, tier medium: 5 seed problems, 2-3 wa_edge_empty-shaped fails each, recent.
//      (Side effect: those extra attempts also raise a live gap:dp.interval habit; goldens assert it.)
//   2. overflow habit, LIVE, tier high: 6 recent runtime errors with the UBSan signed-overflow message.
//   3. gap:dp.kadane_max_subarray, STALE: 5 seed problems solved at 4-6 attempts, all > 400 days old, mixed buckets.
//   4. one TLE->AC pair 200 s apart with near-identical code (quick_after_tle) and one with different code (no flag).
//   5. 21 recent first-try solves across graph.dijkstra / graph.topological_sort / dp.knapsack_01 (anchor pool),
//      plus 3 older easy first-try solves as baseline filler.
const { loadSeed } = require('../../../src/lc/domain/seed');
const SNIPPETS = require('./snippets');

const FIXTURE_NOW = 1789171200; // 2026-09-12T00:00:00Z
const DAY = 86400;
const DEFAULT_SEED = 7;
const FIRST_ID = 1000001;

const OVERFLOW_ERROR = 'runtime error: signed integer overflow: 27131803 + 2123074792 cannot be represented in type int';
const INDEX_ERROR = 'Line 14: Char 24: runtime error: addition of unsigned offset to 0x602000000010 overflowed to 0x60200000000c (stl_vector.h)';
const EDGE_TESTCASES = ['[]', '[1]', '""', '"a"', '[[]]', '0'];

const PLANTED = Object.freeze({
  interval: ['burst-balloons', 'strange-printer', 'minimum-cost-to-merge-stones', 'minimum-score-triangulation-of-polygon', 'count-different-palindromic-subsequences'],
  kadane: ['maximum-subarray', 'maximum-product-subarray', 'maximum-sum-circular-subarray', 'maximum-absolute-sum-of-any-subarray', 'k-concatenation-maximum-sum'],
  overflow_solved: ['reverse-integer', 'divide-two-integers'],
  overflow_unsolved: ['multiply-strings'],
  quick_after_tle: 'longest-substring-without-repeating-characters',
  slow_after_tle: 'kth-largest-element-in-an-array',
  first_try: {
    'graph.dijkstra': ['network-delay-time', 'path-with-minimum-effort', 'swim-in-rising-water', 'the-maze-ii', 'reachable-nodes-in-subdivided-graph', 'minimum-obstacle-removal-to-reach-corner', 'second-minimum-time-to-reach-destination'],
    'graph.topological_sort': ['course-schedule', 'course-schedule-ii', 'alien-dictionary', 'parallel-courses-iii', 'parallel-courses', 'course-schedule-iv', 'all-ancestors-of-a-node-in-a-directed-acyclic-graph'],
    'dp.knapsack_01': ['partition-equal-subset-sum', 'target-sum', 'last-stone-weight-ii', 'ones-and-zeroes', 'length-of-the-longest-subsequence-that-sums-to-target', 'profitable-schemes', 'tallest-billboard']
  },
  easy_fillers: ['two-sum', 'valid-parentheses', 'merge-two-sorted-lists']
});

// Replay targets: an unsolved interval problem (seed anchors), coin-change (fine-tag anchors from knapsack_01),
// and an unsolved Dijkstra problem (seed + fine-tag anchors with varied scores).
const TARGET_SLUGS = Object.freeze(['minimum-cost-to-cut-a-stick', 'coin-change', 'path-with-maximum-probability']);

const STATUS_MSG = { 10: 'Accepted', 11: 'Wrong Answer', 14: 'Time Limit Exceeded', 15: 'Runtime Error' };

function makeRand(seed) {
  let s = seed;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
}

function buildFixture({ seed = DEFAULT_SEED, now = FIXTURE_NOW } = {}) {
  const rand = makeRand(seed);
  const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const seedObj = loadSeed();
  const events = [];
  const daysAgo = (d) => now - Math.round(d * DAY);

  // ---- detail shapes (all synthetic) ----
  let edgeIdx = 0;
  const edgeFail = () => ({ status_code: 11, last_testcase: EDGE_TESTCASES[edgeIdx++ % EDGE_TESTCASES.length], expected_output: '0', code_output: '-1', error_text: '' });
  const logicFail = () => ({ status_code: 11, last_testcase: '[3,1,5,8]', expected_output: '167', code_output: '150', error_text: '' });
  const tleFail = () => ({ status_code: 14, last_testcase: '[100000 elements omitted]', expected_output: '', code_output: '', error_text: '' });
  const indexFail = () => ({ status_code: 15, last_testcase: '[5,3,8]', expected_output: '', code_output: '', error_text: INDEX_ERROR });
  const overflowFail = () => ({ status_code: 15, last_testcase: '[2147483647,1]', expected_output: '', code_output: '', error_text: OVERFLOW_ERROR });
  const KADANE_ROTATION = [logicFail, tleFail, edgeFail, indexFail];
  let kadaneRot = 0;

  const pushFail = (slug, ts, det) => events.push({ slug, ts, status_code: det.status_code, has_details: 1, last_testcase: det.last_testcase, expected_output: det.expected_output, code_output: det.code_output, error_text: det.error_text, runtime_percentile: null });
  const pushAc = (slug, ts, extra = {}) => events.push({ slug, ts, status_code: 10, has_details: 0, runtime_percentile: Math.round((5 + rand() * 90) * 100) / 100, ...extra });

  // 1. dp.interval: recent, 2-3 base-case-shaped WA each, the third problem gets one extra wa_logic (share stays >= 0.6).
  PLANTED.interval.forEach((slug, i) => {
    let t = daysAgo(150 - i * 32) + randInt(0, 6 * 3600);
    const nEdge = randInt(2, 3);
    for (let k = 0; k < nEdge; k++) { t += randInt(300, 1500); pushFail(slug, t, edgeFail()); }
    if (i === 2) { t += randInt(300, 900); pushFail(slug, t, logicFail()); }
    t += randInt(600, 2400);
    pushAc(slug, t);
  });

  // 2. overflow: 3 problems, 2 UBSan signed-overflow REs each, recent; the third never gets solved.
  [...PLANTED.overflow_solved, ...PLANTED.overflow_unsolved].forEach((slug, i) => {
    let t = daysAgo(95 - i * 40) + randInt(0, 6 * 3600);
    for (let k = 0; k < 2; k++) { t += randInt(200, 900); pushFail(slug, t, overflowFail()); }
    if (PLANTED.overflow_solved.includes(slug)) { t += randInt(600, 1800); pushAc(slug, t); }
  });

  // 3. dp.kadane_max_subarray: stale (> 400 days), 3-5 fails rotating through four buckets, then AC.
  PLANTED.kadane.forEach((slug, i) => {
    let t = daysAgo(520 - i * 20) + randInt(0, 6 * 3600);
    const nFails = randInt(3, 5);
    for (let k = 0; k < nFails; k++) { t += randInt(300, 1800); pushFail(slug, t, KADANE_ROTATION[kadaneRot++ % KADANE_ROTATION.length]()); }
    t += randInt(600, 2400);
    pushAc(slug, t);
  });

  // 4. TLE -> AC pairs exactly 200 s apart; code only on these four rows.
  {
    const t1 = daysAgo(40) + randInt(0, 6 * 3600);
    events.push({ slug: PLANTED.quick_after_tle, ts: t1, status_code: 14, has_details: 1, last_testcase: '"a" repeated 50000 times', expected_output: '', code_output: '', error_text: '', runtime_percentile: null, code: SNIPPETS.TLE_SLIDING_WINDOW_NAIVE });
    pushAc(PLANTED.quick_after_tle, t1 + 200, { code: SNIPPETS.AC_SLIDING_WINDOW_SIMILAR });
    const t2 = daysAgo(33) + randInt(0, 6 * 3600);
    events.push({ slug: PLANTED.slow_after_tle, ts: t2, status_code: 14, has_details: 1, last_testcase: '[100000 elements omitted]', expected_output: '', code_output: '', error_text: '', runtime_percentile: null, code: SNIPPETS.TLE_KTH_LARGEST_NAIVE });
    pushAc(PLANTED.slow_after_tle, t2 + 200, { code: SNIPPETS.AC_KTH_LARGEST_DIFFERENT });
  }

  // 5. first-try anchor pool, interleaved across the three sub-patterns, 170 -> ~3 days ago.
  const firstTry = [];
  const groups = Object.values(PLANTED.first_try);
  for (let k = 0; k < 7; k++) for (const g of groups) firstTry.push(g[k]);
  firstTry.forEach((slug, i) => pushAc(slug, daysAgo(170 - i * 8) + randInt(0, 12 * 3600)));
  PLANTED.easy_fillers.forEach((slug, i) => pushAc(slug, daysAgo(400 - i * 100) + randInt(0, 12 * 3600)));

  // ---- materialise DB-shaped rows: ids increase with time, like real LeetCode ids ----
  events.sort((a, b) => a.ts - b.ts);
  const submissions = events.map((e, i) => {
    const row = { lc_submission_id: FIRST_ID + i, slug: e.slug, status_code: e.status_code, status_msg: STATUS_MSG[e.status_code], lang: 'cpp', ts: e.ts, has_details: e.has_details, runtime_percentile: e.runtime_percentile };
    // Detail columns are present only when has_details=1: normalizeSubmission treats any defined detail key
    // (even null) as "details present", which would turn a detail-less WA into wa_edge_empty.
    if (e.has_details) { row.last_testcase = e.last_testcase; row.expected_output = e.expected_output; row.code_output = e.code_output; row.error_text = e.error_text; }
    if (e.code !== undefined) row.code = e.code;
    return row;
  });

  const problemsBySlug = new Map();
  for (const e of events) {
    if (problemsBySlug.has(e.slug)) continue;
    const c = seedObj.problemFromCatalog(e.slug);
    if (!c) throw new Error(`fixture slug missing from catalog: ${e.slug}`);
    problemsBySlug.set(e.slug, { slug: c.slug, title: c.title, difficulty: c.difficulty, tags: c.tags.slice(), frontendId: c.frontendId });
  }
  const solvedSlugs = [...new Set(events.filter((e) => e.status_code === 10).map((e) => e.slug))];
  const solved = solvedSlugs.map((slug) => { const p = problemsBySlug.get(slug); return { slug, title: p.title, difficulty: p.difficulty, tags: p.tags.slice() }; });

  return { seed, now, submissions, solved, problemsBySlug, seedObj, planted: PLANTED, targets: TARGET_SLUGS };
}

// codeLookup for buildAttempts: only rows that carry `code` resolve.
function codeLookupFor(submissions) {
  const byId = new Map();
  for (const s of submissions) if (s.code !== undefined) byId.set(Number(s.lc_submission_id), s.code);
  return (id) => byId.get(Number(id)) || null;
}

module.exports = { buildFixture, codeLookupFor, FIXTURE_NOW, DEFAULT_SEED, PLANTED, TARGET_SLUGS, OVERFLOW_ERROR, INDEX_ERROR };
