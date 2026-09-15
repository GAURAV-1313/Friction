#!/usr/bin/env node
'use strict';
/**
 * Run the Recall habit-detection rule layer over a LeetCode export made by extract.js.
 *
 *   node analyze.js <export-dir> [--seed subpatterns.json] [--out <dir>]
 *
 * Produces in <out> (default <export-dir>/analysis/):
 *   attempts.json         per-problem attempt sequences with verdict buckets
 *   aggregates.json       per-family / per-sub-pattern aggregates + baselines + habit candidates
 *   anchor_coverage.json  how often a personal anchor exists under each eligibility rule
 *   labeling_sample.json  failed submissions (with code + next attempt) for bug-locus labeling
 *   report.md             human-readable summary
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const EXPORT = args.find((a) => !a.startsWith('--'));
if (!EXPORT) { console.error('usage: node analyze.js <export-dir> [--seed subpatterns.json] [--out dir]'); process.exit(1); }
function flag(n, d) { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1]; }
const SEED_FILE = flag('seed', path.join(__dirname, 'subpatterns.json'));
const OUT = flag('out', path.join(EXPORT, 'analysis'));
fs.mkdirSync(OUT, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const normDiff = (d) => String(d || '').toLowerCase();
const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// ---------- load ----------
const solved = readJson(path.join(EXPORT, 'solved.json'), []);
const attempted = readJson(path.join(EXPORT, 'attempted.json'), []);
const submissions = readJson(path.join(EXPORT, 'submissions.json'), []);
const problems = new Map();
for (const r of [...solved, ...attempted]) problems.set(r.titleSlug, { slug: r.titleSlug, title: r.title, frontendId: r.questionFrontendId, difficulty: normDiff(r.difficulty), tags: r.topicTags || [], similar: [], hints: [], content: null, solved: r.status === 'SOLVED' || String(r.status).toLowerCase() === 'ac' });
const probDir = path.join(EXPORT, 'problems');
if (fs.existsSync(probDir)) for (const f of fs.readdirSync(probDir)) {
  const p = readJson(path.join(probDir, f), null); if (!p || p.error) continue;
  const cur = problems.get(p.titleSlug) || { slug: p.titleSlug, title: p.title, solved: false };
  problems.set(p.titleSlug, { ...cur, title: p.title || cur.title, frontendId: p.questionFrontendId || cur.frontendId, difficulty: normDiff(p.difficulty || cur.difficulty), tags: (p.topicTags && p.topicTags.length ? p.topicTags : cur.tags) || [], similar: p.similarQuestions || [], hints: p.hints || [], content: p.content || null });
}
const details = new Map();
const detDir = path.join(EXPORT, 'details');
if (fs.existsSync(detDir)) for (const f of fs.readdirSync(detDir)) { const d = readJson(path.join(detDir, f), null); if (d && !d.error) details.set(String(d.id), d); }
const solvedSet = new Set([...problems.values()].filter((p) => p.solved).map((p) => p.slug));

// ---------- families + sub-patterns ----------
const DP_TAGS = new Set(['dynamic-programming', 'memoization', 'bitmask', 'game-theory', 'knapsack-problem', 'complete-knapsack', 'dp-on-trees', 'longest-increasing-subsequence', 'longest-common-subsequence', '0-1-knapsack', 'multiple-knapsack', 'mixed-knapsack', 'minimax-algorithm', 'zero-sum-game', 'impartial-game', 'sprague-grundy-theorem', 'combinatorics']);
const GRAPH_TAGS = new Set(['graph', 'breadth-first-search', 'depth-first-search', 'topological-sort', 'shortest-path', 'union-find', 'minimum-spanning-tree', 'strongly-connected-component', 'biconnected-component', 'eulerian-circuit', 'dijkstra', 'directed-acyclic-graph', 'bipartite-graph', 'graph-coloring', 'kosarajus-algorithm', 'tarjans-scc-algorithm', 'bellman-ford-algorithm', 'floyd-warshall-algorithm', 'prims-algorithm', 'kruskals-algorithm', 'boruvkas-algorithm', '0-1-bfs', 'bidirectional-search', 'a-search', 'heuristic-search', 'eulerian-path', 'eulerian-graph', 'semi-eulerian-graph', 'hamiltonian-path', 'articulation-point', 'bridge-graph', 'matching-graph', 'maximum-matching', 'flow-network', 'maximum-flow', 'k-shortest-path', 'lowest-common-ancestor', 'binary-lifting']);
const FINE_ALGO = new Set(['knapsack-problem', 'complete-knapsack', '0-1-knapsack', 'multiple-knapsack', 'mixed-knapsack', 'dp-on-trees', 'longest-increasing-subsequence', 'longest-common-subsequence', 'minimax-algorithm', 'zero-sum-game', 'bitmask', 'game-theory', 'memoization', 'dijkstra', 'topological-sort', 'directed-acyclic-graph', 'union-find', 'bipartite-graph', 'graph-coloring', 'kosarajus-algorithm', 'tarjans-scc-algorithm', 'strongly-connected-component', 'bellman-ford-algorithm', 'floyd-warshall-algorithm', 'shortest-path', 'minimum-spanning-tree', 'prims-algorithm', 'kruskals-algorithm', '0-1-bfs', 'bidirectional-search', 'eulerian-path', 'eulerian-circuit', 'hamiltonian-path', 'articulation-point', 'bridge-graph', 'biconnected-component']);
const UMBRELLA = new Set(['array', 'string', 'hash-table', 'math', 'sorting', 'dynamic-programming', 'graph', 'depth-first-search', 'breadth-first-search', 'matrix', 'tree', 'binary-tree', 'greedy', 'simulation', 'two-pointers']);
function familiesOf(tags) { const f = []; if (tags.some((t) => DP_TAGS.has(t))) f.push('dp'); if (tags.some((t) => GRAPH_TAGS.has(t))) f.push('graph'); return f; }
const seed = readJson(SEED_FILE, null);
const membership = new Map(); // slug -> [{id, primary, family}]
const subLabel = new Map();
if (seed && seed.subpatterns) for (const sp of seed.subpatterns) {
  subLabel.set(sp.id, sp.label || sp.id);
  for (const p of sp.problems || []) { if (p.verified === false) continue; if (!membership.has(p.slug)) membership.set(p.slug, []); membership.get(p.slug).push({ id: sp.id, primary: !!p.primary, family: sp.family }); }
}
function primarySub(slug) { const m = membership.get(slug) || []; return (m.find((x) => x.primary) || m[0] || null); }

// ---------- verdict buckets ----------
const STATUS_BY_DISPLAY = { 'Accepted': 10, 'Wrong Answer': 11, 'Memory Limit Exceeded': 12, 'Output Limit Exceeded': 13, 'Time Limit Exceeded': 14, 'Runtime Error': 15, 'Internal Error': 16, 'Compile Error': 20, 'Unknown Error': 21 };
function statusOf(s) { return s.statusCode ?? STATUS_BY_DISPLAY[s.statusDisplay] ?? null; }
function isEdgeShaped(tc) {
  const t = String(tc || '').trim();
  if (!t) return true;
  const first = t.split('\n')[0].trim();
  if (first === '[]' || first === '""' || first === '0' || first === '1' || first === '[[]]') return true;
  if (/^\[[^,\[\]]*\]$/.test(first)) return true;          // single element list
  if (/^"[^"]{0,1}"$/.test(first)) return true;            // empty or 1-char string
  if (t.length <= 3) return true;
  return false;
}
function bucketOf(sub, det) {
  const code = statusOf(sub);
  if (code === 10) return 'ac';
  if (code === 20) return 'ce';
  if (code === 14) return 'tle';
  if (code === 12) return 'mle_state';
  if (code === 13) return 'ole';
  if (code === 15) {
    const e = String((det && (det.runtimeError || det.fullCodeOutput)) || '');
    if (/signed integer overflow|negation of -2147483648|cannot be represented in type|shift exponent .* too large|left shift of/i.test(e)) return 're_overflow';
    if (/addition of unsigned offset|subtraction of unsigned offset|unsigned offset .* overflowed/i.test(e)) return 're_index';
    if (/RecursionError|StackOverflow|maximum recursion|stack overflow/i.test(e)) return 're_recursion';
    if (/IndexError|ArrayIndexOutOfBounds|out of range|index out of bounds|out_of_range|vector::_M_range_check/i.test(e)) return 're_index';
    if (/KeyError|NoneType|NullPointer|null pointer|nullptr|undefined is not|TypeError: Cannot read/i.test(e)) return 're_null_memo';
    if (/heap-buffer-overflow|AddressSanitizer|SIGSEGV|segmentation/i.test(e)) return 're_index';
    return det ? 're_other' : 're_unknown';
  }
  if (code === 11) {
    if (!det) return 'wa_unknown';
    const tc = det.lastTestcase || '';
    if (isEdgeShaped(tc)) return 'wa_edge_empty';
    if (/2147483647|-2147483648|1000000000|10\^9|999999999|9223372036854775807/.test(tc)) return 'wa_bounds_overflow';
    const exp = Number(String(det.expectedOutput || '').trim()); const got = Number(String(det.codeOutput || '').trim());
    if (Number.isFinite(exp) && Number.isFinite(got) && got !== exp && (Math.abs(got) >= 1000000007 || ((got - exp) % 1000000007 === 0))) return 'wa_modulo';
    return 'wa_logic';
  }
  return 'other';
}
const BASE_CASE_SHAPED = new Set(['wa_edge_empty', 're_null_memo']);
const TRANSITION_SHAPED = new Set(['wa_logic', 'wa_bounds_overflow', 'wa_modulo', 're_index']);
const OVERFLOW_SHAPED = new Set(['re_overflow', 'wa_bounds_overflow', 'wa_modulo']);

// ---------- attempts per problem ----------
const bySlug = new Map();
for (const s of submissions) { if (!s.titleSlug) continue; if (s.isPending && s.isPending !== 'Not Pending') continue; if (!bySlug.has(s.titleSlug)) bySlug.set(s.titleSlug, []); bySlug.get(s.titleSlug).push(s); }
function similarity(a, b) { // crude line-overlap similarity for "quick after TLE" detection
  const la = new Set(String(a || '').split('\n').map((l) => l.trim()).filter(Boolean)); const lb = new Set(String(b || '').split('\n').map((l) => l.trim()).filter(Boolean));
  if (!la.size || !lb.size) return 0; let inter = 0; for (const l of la) if (lb.has(l)) inter++; return inter / Math.max(la.size, lb.size);
}
const attempts = [];
for (const [slug, list] of bySlug) {
  list.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const p = problems.get(slug) || { slug, title: list[0].title, difficulty: null, tags: [], similar: [] };
  const seq = list.map((s) => { const det = details.get(String(s.id)) || null; return { id: s.id, ts: Number(s.timestamp), status: statusOf(s), statusDisplay: s.statusDisplay, lang: s.lang, bucket: bucketOf(s, det), hasDetails: !!det, runtimePercentile: det ? det.runtimePercentile : null, codeLen: (s.code || (det && det.code) || '').length }; });
  const firstAc = seq.findIndex((x) => x.status === 10);
  const fails = firstAc === -1 ? seq.filter((x) => x.status !== 10) : seq.slice(0, firstAc);
  let fragile = [];
  if (firstAc !== -1) {
    const ac = seq[firstAc]; const prev = seq[firstAc - 1];
    if (ac.runtimePercentile !== null && ac.runtimePercentile !== undefined && ac.runtimePercentile < 10) fragile.push('low_percentile');
    if (prev && prev.status === 14 && ac.ts - prev.ts < 300) {
      const codeA = (list[firstAc].code || (details.get(String(ac.id)) || {}).code || ''); const codeP = (list[firstAc - 1].code || (details.get(String(prev.id)) || {}).code || '');
      if (similarity(codeA, codeP) > 0.8) fragile.push('quick_after_tle');
    }
  }
  attempts.push({ slug, title: p.title, difficulty: p.difficulty, tags: p.tags, families: familiesOf(p.tags), subpatterns: membership.get(slug) || [], primary: primarySub(slug), n_submissions: seq.length, first_ts: seq[0].ts, first_ac_ts: firstAc === -1 ? null : seq[firstAc].ts, attempts_to_ac: firstAc === -1 ? null : firstAc + 1, solved: firstAc !== -1, fails_before_ac: fails.length, fail_buckets: fails.map((f) => f.bucket), time_to_ac_s: firstAc === -1 ? null : seq[firstAc].ts - seq[0].ts, fragile_flags: fragile, sequence: seq });
}
attempts.sort((a, b) => a.first_ts - b.first_ts);
writeJson(path.join(OUT, 'attempts.json'), attempts);

// ---------- aggregates ----------
const solvedAttempts = attempts.filter((a) => a.solved);
function aggregate(items) {
  const fails = items.flatMap((a) => a.fail_buckets);
  const known = fails.filter((b) => !/unknown/.test(b));
  const hist = {}; for (const b of fails) hist[b] = (hist[b] || 0) + 1;
  const baseShaped = known.filter((b) => BASE_CASE_SHAPED.has(b)).length; const transShaped = known.filter((b) => TRANSITION_SHAPED.has(b)).length;
  const solvedItems = items.filter((a) => a.solved);
  return {
    n_problems: items.length, n_solved: solvedItems.length, n_fails: fails.length, n_fails_with_details: known.length, fail_hist: hist,
    base_case_skew: known.length ? r2(baseShaped / known.length) : null, transition_skew: known.length ? r2(transShaped / known.length) : null,
    tle_share: fails.length ? r2(fails.filter((b) => b === 'tle').length / fails.length) : null,
    overflow_share: fails.length ? r2(fails.filter((b) => OVERFLOW_SHAPED.has(b)).length / fails.length) : null,
    re_share: fails.length ? r2(fails.filter((b) => b.startsWith('re_')).length / fails.length) : null,
    mean_attempts_to_ac: r2(mean(solvedItems.map((a) => a.attempts_to_ac))), median_attempts_to_ac: median(solvedItems.map((a) => a.attempts_to_ac)),
    first_try_rate: solvedItems.length ? r2(solvedItems.filter((a) => a.attempts_to_ac === 1).length / solvedItems.length) : null,
    fragile_ac: solvedItems.filter((a) => a.fragile_flags.length).length, fragile_flags: solvedItems.flatMap((a) => a.fragile_flags).reduce((h, f) => (h[f] = (h[f] || 0) + 1, h), {}),
    problems: items.map((a) => a.slug)
  };
}
const global = aggregate(attempts);
// competing baselines (claim 1 test): lifetime vs recent window vs difficulty-stratified
const lastTs = attempts.length ? Math.max(...attempts.map((a) => a.first_ts)) : 0;
const recent90 = solvedAttempts.filter((a) => a.first_ts >= lastTs - 90 * 86400);
const recent100 = solvedAttempts.slice(-100);
const byDiff = {}; for (const d of ['easy', 'medium', 'hard']) byDiff[d] = r2(mean(solvedAttempts.filter((a) => a.difficulty === d).map((a) => a.attempts_to_ac)));
const baselines = { lifetime_mean: global.mean_attempts_to_ac, recent_90d_mean: r2(mean(recent90.map((a) => a.attempts_to_ac))), recent_90d_n: recent90.length, recent_100_problems_mean: r2(mean(recent100.map((a) => a.attempts_to_ac))), by_difficulty: byDiff };
// drift: mean attempts_to_ac per quarter of the solving history
const quarters = []; const q = Math.max(1, Math.ceil(solvedAttempts.length / 4));
for (let i = 0; i < solvedAttempts.length; i += q) { const chunk = solvedAttempts.slice(i, i + q); quarters.push({ from: new Date(chunk[0].first_ts * 1000).toISOString().slice(0, 10), n: chunk.length, mean_attempts_to_ac: r2(mean(chunk.map((a) => a.attempts_to_ac))), first_try_rate: r2(chunk.filter((a) => a.attempts_to_ac === 1).length / chunk.length) }); }

const families = {}; for (const f of ['dp', 'graph']) families[f] = aggregate(attempts.filter((a) => a.families.includes(f)));
const subs = {};
for (const id of subLabel.keys()) { const items = attempts.filter((a) => a.subpatterns.some((m) => m.id === id)); if (items.length) subs[id] = { label: subLabel.get(id), ...aggregate(items) }; }
const subsPrimary = {};
for (const id of subLabel.keys()) { const items = attempts.filter((a) => a.primary && a.primary.id === id); if (items.length) subsPrimary[id] = aggregate(items); }
function gapRatios(agg) {
  const m = agg.mean_attempts_to_ac; if (m === null) return null;
  const strat = (() => { const xs = agg.problems.map((s) => attempts.find((a) => a.slug === s)).filter((a) => a && a.solved); const ws = xs.map((a) => byDiff[a.difficulty]).filter((x) => x); return ws.length ? mean(ws) : null; })();
  return { vs_lifetime: baselines.lifetime_mean ? r2(m / baselines.lifetime_mean) : null, vs_recent_90d: baselines.recent_90d_mean ? r2(m / baselines.recent_90d_mean) : null, vs_recent_100: baselines.recent_100_problems_mean ? r2(m / baselines.recent_100_problems_mean) : null, vs_difficulty_matched: strat ? r2(m / strat) : null };
}
for (const id of Object.keys(subs)) subs[id].gap = gapRatios(subs[id]);
for (const f of Object.keys(families)) families[f].gap = gapRatios(families[f]);

// habit candidates using the design thresholds (v0)
const candidates = [];
if (global.n_fails >= 10 && global.overflow_share !== null && global.overflow_share >= 0.1) candidates.push({ category: 'overflow_habit', subpattern: 'global', confidence_rule: global.overflow_share >= 0.2 ? 'high' : 'medium', evidence: { n_fails: global.n_fails, overflow_share: global.overflow_share, n_overflow: Math.round(global.overflow_share * global.n_fails) }, judgment_required: false });
for (const [id, a] of Object.entries(subs)) {
  const fam = id.split('.')[0];
  if (a.n_problems >= 3 && a.n_fails_with_details >= 5 && a.base_case_skew !== null && a.base_case_skew >= 0.7) candidates.push({ category: 'recurrence_error_base', subpattern: id, confidence_rule: 'high', evidence: { n_problems: a.n_problems, n_fails: a.n_fails_with_details, base_case_skew: a.base_case_skew }, judgment_required: false });
  if (a.n_problems >= 3 && a.n_fails_with_details >= 5 && a.transition_skew !== null && a.transition_skew >= 0.7) candidates.push({ category: 'recurrence_error_transition', subpattern: id, confidence_rule: 'high', evidence: { n_problems: a.n_problems, n_fails: a.n_fails_with_details, transition_skew: a.transition_skew }, judgment_required: false });
  if (a.n_solved >= 4 && a.gap) for (const [k, v] of Object.entries(a.gap)) if (v !== null && v >= 1.5) candidates.push({ category: 'subpattern_specific_difficulty_gap', subpattern: id, baseline: k, ratio: v, confidence_rule: a.n_solved >= 6 ? 'high' : 'medium', evidence: { n_solved: a.n_solved, mean_attempts_to_ac: a.mean_attempts_to_ac }, judgment_required: false });
  if (a.n_fails >= 4 && a.tle_share !== null && a.tle_share >= 0.5) candidates.push({ category: 'tle_root_cause_profile', subpattern: id, confidence_rule: 'medium', evidence: { n_fails: a.n_fails, tle_share: a.tle_share }, judgment_required: false });
  if (fam === 'graph' && a.n_fails >= 4 && a.re_share !== null && (a.re_share + (a.tle_share || 0)) >= 0.6) candidates.push({ category: 'graph_mechanics_error', subpattern: id, confidence_rule: 'low', evidence: { n_fails: a.n_fails, re_share: a.re_share, tle_share: a.tle_share }, judgment_required: true });
}

// ---------- anchor coverage (claim 8 test) ----------
const coverage = { rules: {}, per_problem: [] };
const famProblems = attempts.filter((a) => a.families.length && a.solved);
const specificTagsShared = (a, b) => { const shared = a.tags.filter((t) => b.tags.includes(t)); return { n: shared.length, specific: shared.filter((t) => !UMBRELLA.has(t)).length }; };
for (const a of famProblems) {
  const others = famProblems.filter((b) => b.slug !== a.slug);
  const seedAnchors = others.filter((b) => a.subpatterns.some((m) => b.subpatterns.some((n) => n.id === m.id))).map((b) => b.slug);
  const pa = problems.get(a.slug) || { similar: [] };
  const simAnchors = others.filter((b) => (pa.similar || []).includes(b.slug) || ((problems.get(b.slug) || {}).similar || []).includes(a.slug)).map((b) => b.slug);
  const tagAnchors = others.filter((b) => { const s = specificTagsShared(a, b); return s.n >= 2 && s.specific >= 1; }).map((b) => b.slug);
  const fineAnchors = others.filter((b) => a.tags.some((t) => FINE_ALGO.has(t) && b.tags.includes(t))).map((b) => b.slug);
  coverage.per_problem.push({ slug: a.slug, in_seed: a.subpatterns.length > 0, has_fine_tag: a.tags.some((t) => FINE_ALGO.has(t)), seed_anchors: seedAnchors.length, similar_anchors: simAnchors.length, tag_anchors: tagAnchors.length, fine_tag_anchors: fineAnchors.length, seed_and_fine_agree: seedAnchors.filter((x) => fineAnchors.includes(x)).length, similar_not_in_seed_subpattern: simAnchors.filter((s) => !seedAnchors.includes(s)).length });
}
const n = coverage.per_problem.length || 1;
coverage.rules = {
  n_family_problems_solved: coverage.per_problem.length,
  in_seed_share: r2(coverage.per_problem.filter((x) => x.in_seed).length / n),
  has_seed_anchor: r2(coverage.per_problem.filter((x) => x.seed_anchors > 0).length / n),
  has_similar_anchor: r2(coverage.per_problem.filter((x) => x.similar_anchors > 0).length / n),
  has_tag_anchor: r2(coverage.per_problem.filter((x) => x.tag_anchors > 0).length / n),
  has_fine_tag: r2(coverage.per_problem.filter((x) => x.has_fine_tag).length / n),
  has_fine_tag_anchor: r2(coverage.per_problem.filter((x) => x.fine_tag_anchors > 0).length / n),
  has_any_anchor: r2(coverage.per_problem.filter((x) => x.seed_anchors + x.similar_anchors + x.tag_anchors + x.fine_tag_anchors > 0).length / n),
  similar_links_outside_seed_subpattern: coverage.per_problem.reduce((s, x) => s + x.similar_not_in_seed_subpattern, 0)
};
writeJson(path.join(OUT, 'anchor_coverage.json'), coverage);

writeJson(path.join(OUT, 'aggregates.json'), { generated_at: new Date().toISOString(), export: path.resolve(EXPORT), seed: seed ? { file: SEED_FILE, subpatterns: seed.subpatterns.length } : null, global, baselines, drift_by_quarter: quarters, families, subpatterns: subs, subpatterns_primary_only: subsPrimary, habit_candidates: candidates });

// ---------- labeling sample (claim 2 test) ----------
const sample = {}; const PER_BUCKET = 12;
const failedSubs = [];
for (const a of attempts) a.sequence.forEach((s, i) => { if (s.status !== 10 && s.hasDetails) failedSubs.push({ a, s, next: a.sequence[i + 1] || null }); });
failedSubs.sort((x, y) => (y.a.families.length - x.a.families.length) || (y.a.subpatterns.length - x.a.subpatterns.length) || ((y.next ? 1 : 0) - (x.next ? 1 : 0)));
for (const { a, s, next } of failedSubs) {
  const b = s.bucket; if (!sample[b]) sample[b] = []; if (sample[b].length >= PER_BUCKET) continue;
  const det = details.get(String(s.id)); const raw = bySlug.get(a.slug).find((x) => String(x.id) === String(s.id)) || {};
  const nextRaw = next ? (bySlug.get(a.slug).find((x) => String(x.id) === String(next.id)) || {}) : null; const nextDet = next ? details.get(String(next.id)) : null;
  const p = problems.get(a.slug) || {};
  sample[b].push({ submission_id: s.id, slug: a.slug, title: a.title, difficulty: a.difficulty, tags: a.tags, subpatterns: a.subpatterns.map((m) => m.id), bucket: b, statusDisplay: s.statusDisplay, lang: s.lang, attempt_index: a.sequence.indexOf(s) + 1, of_attempts: a.sequence.length,
    lastTestcase: String(det.lastTestcase || '').slice(0, 600), expectedOutput: String(det.expectedOutput || '').slice(0, 300), codeOutput: String(det.codeOutput || '').slice(0, 300), errorText: String(det.runtimeError || det.compileError || det.fullCodeOutput || '').slice(0, 600), totalCorrect: det.totalCorrect, totalTestcases: det.totalTestcases,
    code: raw.code || det.code || null, next: next ? { submission_id: next.id, statusDisplay: next.statusDisplay, bucket: next.bucket, code: nextRaw.code || (nextDet && nextDet.code) || null } : null,
    statement: stripHtml(p.content).slice(0, 1500) });
}
writeJson(path.join(OUT, 'labeling_sample.json'), sample);
// one small file per item so labeling agents can read just their own item
const itemsDir = path.join(OUT, 'labeling_items'); fs.rmSync(itemsDir, { recursive: true, force: true }); fs.mkdirSync(itemsDir, { recursive: true });
const itemIndex = [];
for (const [b, xs] of Object.entries(sample)) for (const x of xs) { const file = path.resolve(itemsDir, `${b}__${x.submission_id}.json`); writeJson(file, x); itemIndex.push({ file, bucket: b, submission_id: x.submission_id, slug: x.slug }); }
writeJson(path.join(OUT, 'labeling_index.json'), itemIndex);

// ---------- report ----------
const L = [];
L.push(`# Habit-rule calibration report`, ``, `Export: ${path.resolve(EXPORT)}  Seed: ${seed ? `${seed.subpatterns.length} sub-patterns` : 'none (families only)'}`, ``);
L.push(`## Global`, ``, `| metric | value |`, `|---|---|`, `| problems with submissions | ${global.n_problems} |`, `| solved | ${global.n_solved} |`, `| failed submissions before first AC | ${global.n_fails} (${global.n_fails_with_details} with judge details) |`, `| mean / median attempts to AC | ${global.mean_attempts_to_ac} / ${global.median_attempts_to_ac} |`, `| first-try rate | ${global.first_try_rate} |`, `| fragile first-ACs | ${global.fragile_ac} ${JSON.stringify(global.fragile_flags)} |`, ``);
L.push(`Verdict buckets over all pre-AC failures: ${Object.entries(global.fail_hist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`, ``);
L.push(`## Baselines (claim 1: does the self-relative baseline drift?)`, ``, `| baseline | mean attempts to AC |`, `|---|---|`, `| lifetime | ${baselines.lifetime_mean} |`, `| last 90 days (n=${baselines.recent_90d_n}) | ${baselines.recent_90d_mean} |`, `| last 100 problems | ${baselines.recent_100_problems_mean} |`, `| by difficulty | easy ${byDiff.easy}, medium ${byDiff.medium}, hard ${byDiff.hard} |`, ``);
L.push(`Drift by quarter of solving history:`, ``, `| from | n | mean attempts | first-try rate |`, `|---|---|---|---|`, ...quarters.map((x) => `| ${x.from} | ${x.n} | ${x.mean_attempts_to_ac} | ${x.first_try_rate} |`), ``);
L.push(`## Families`, ``, `| family | problems | solved | fails | base-case skew | transition skew | tle share | mean attempts | gap vs lifetime / 90d / diff-matched |`, `|---|---|---|---|---|---|---|---|---|`);
for (const [f, a] of Object.entries(families)) L.push(`| ${f} | ${a.n_problems} | ${a.n_solved} | ${a.n_fails} | ${a.base_case_skew} | ${a.transition_skew} | ${a.tle_share} | ${a.mean_attempts_to_ac} | ${a.gap ? `${a.gap.vs_lifetime} / ${a.gap.vs_recent_90d} / ${a.gap.vs_difficulty_matched}` : '-'} |`);
L.push(``, `## Sub-patterns (any membership)`, ``, `| sub-pattern | problems | solved | fails (w/ details) | base-case skew | transition skew | tle share | mean attempts | gap vs lifetime / 90d / diff-matched |`, `|---|---|---|---|---|---|---|---|---|`);
for (const [id, a] of Object.entries(subs).sort((x, y) => y[1].n_problems - x[1].n_problems)) L.push(`| ${id} | ${a.n_problems} | ${a.n_solved} | ${a.n_fails} (${a.n_fails_with_details}) | ${a.base_case_skew} | ${a.transition_skew} | ${a.tle_share} | ${a.mean_attempts_to_ac} | ${a.gap ? `${a.gap.vs_lifetime} / ${a.gap.vs_recent_90d} / ${a.gap.vs_difficulty_matched}` : '-'} |`);
L.push(``, `## Habit candidates (design v0 thresholds)`, ``);
if (!candidates.length) L.push(`None crossed the floors.`); else { L.push(`| category | sub-pattern | confidence | evidence |`, `|---|---|---|---|`); for (const c of candidates) L.push(`| ${c.category} | ${c.subpattern}${c.baseline ? ` (${c.baseline} x${c.ratio})` : ''} | ${c.confidence_rule} | ${JSON.stringify(c.evidence)} |`); }
L.push(``, `## Recall coverage (claim 8)`, ``, `| rule | share of solved DP/graph problems with >=1 personal anchor |`, `|---|---|`, `| problem is in the seed at all | ${coverage.rules.in_seed_share} |`, `| seed sub-pattern match | ${coverage.rules.has_seed_anchor} |`, `| LeetCode similarQuestions link | ${coverage.rules.has_similar_anchor} |`, `| >=2 shared tags incl. one specific | ${coverage.rules.has_tag_anchor} |`, `| shared fine-grained algorithm tag (LeetCode's own, e.g. dijkstra, 0-1-knapsack) | ${coverage.rules.has_fine_tag_anchor} (problem itself has a fine tag: ${coverage.rules.has_fine_tag}) |`, `| any rule | ${coverage.rules.has_any_anchor} |`, ``, `similarQuestions links that point OUTSIDE the seed sub-pattern: ${coverage.rules.similar_links_outside_seed_subpattern}`, ``);
L.push(`## Labeling sample`, ``, Object.entries(sample).map(([b, xs]) => `${b}: ${xs.length}`).join(', '), ``, `See labeling_sample.json: each failed submission with its code, judge output, and the next attempt, ready for bug-locus labeling.`);
fs.writeFileSync(path.join(OUT, 'report.md'), L.join('\n'));
console.log(L.join('\n'));
console.log(`\nWrote ${OUT}`);
