#!/usr/bin/env node
'use strict';
/**
 * Build the exact tutor context Anchor would have at a moment in this student's history.
 *   node demo_context.js <export-dir> --slug <problem> [--replay <submission_id>] [--rung N] --out <file>
 * Time-travels: only history strictly before the replayed submission is visible.
 */
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const EXPORT = args.find((a) => !a.startsWith('--'));
const flag = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1]; };
const SLUG = flag('slug'); const REPLAY = flag('replay', null); const RUNG = Number(flag('rung', 0)); const OUT = flag('out', `demo_${SLUG}.json`);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const A = path.join(EXPORT, 'analysis');
const attempts = readJson(path.join(A, 'attempts.json'), []);
const seed = readJson(path.join(__dirname, 'subpatterns.json'), { subpatterns: [] });
const catalog = readJson(path.join(__dirname, 'catalog.json'), { problems: [] });
const labels = readJson(path.join(A, 'labels.json'), []);
const details = new Map(); for (const f of fs.readdirSync(path.join(EXPORT, 'details'))) { const d = readJson(path.join(EXPORT, 'details', f), null); if (d && !d.error) details.set(String(d.id), d); }
const subs = readJson(path.join(EXPORT, 'submissions.json'), []); const subById = new Map(subs.map((s) => [String(s.id), s]));
const catBySlug = new Map(catalog.problems.map((p) => [p.slug, p]));
const membership = new Map(); const subLabel = new Map();
for (const sp of seed.subpatterns) { subLabel.set(sp.id, sp.label); for (const p of sp.problems) { if (!membership.has(p.slug)) membership.set(p.slug, []); membership.get(p.slug).push({ id: sp.id, primary: !!p.primary, family: sp.family }); } }
const FINE = new Set(['knapsack-problem', 'complete-knapsack', '0-1-knapsack', 'multiple-knapsack', 'dp-on-trees', 'longest-increasing-subsequence', 'longest-common-subsequence', 'minimax-algorithm', 'zero-sum-game', 'bitmask', 'game-theory', 'memoization', 'dijkstra', 'topological-sort', 'directed-acyclic-graph', 'union-find', 'bipartite-graph', 'graph-coloring', 'kosarajus-algorithm', 'tarjans-scc-algorithm', 'strongly-connected-component', 'bellman-ford-algorithm', 'floyd-warshall-algorithm', 'shortest-path', 'minimum-spanning-tree', 'prims-algorithm', 'kruskals-algorithm', '0-1-bfs', 'bidirectional-search', 'eulerian-path', 'eulerian-circuit', 'hamiltonian-path', 'articulation-point', 'bridge-graph']);
const UMBRELLA = new Set(['array', 'string', 'hash-table', 'math', 'sorting', 'dynamic-programming', 'graph', 'depth-first-search', 'breadth-first-search', 'matrix', 'tree', 'binary-tree', 'greedy', 'simulation', 'two-pointers']);
const DPT = new Set(['dynamic-programming', 'memoization', 'bitmask', 'game-theory', 'knapsack-problem', 'complete-knapsack', 'dp-on-trees', 'longest-increasing-subsequence', 'longest-common-subsequence', '0-1-knapsack']);
const GRT = new Set(['graph', 'breadth-first-search', 'depth-first-search', 'topological-sort', 'shortest-path', 'union-find', 'minimum-spanning-tree', 'strongly-connected-component', 'dijkstra', 'directed-acyclic-graph', 'bipartite-graph', 'bellman-ford-algorithm', 'floyd-warshall-algorithm', '0-1-bfs']);
const OVERFLOW = new Set(['re_overflow', 'wa_modulo', 'wa_bounds_overflow']);
const r2 = (x) => Math.round(x * 100) / 100; const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ---- target problem ----
const pfile = path.join(EXPORT, 'problems', `${SLUG}.json`); let P = readJson(pfile, null);
if (!P) { const c = catBySlug.get(SLUG); if (!c) throw new Error('unknown slug ' + SLUG); P = { titleSlug: SLUG, title: c.title, difficulty: c.difficulty, topicTags: c.tags, questionFrontendId: c.frontendId, content: null, hints: [], similarQuestions: [] }; }
const tags = (P.topicTags || []).map((t) => (typeof t === 'string' ? t : t.slug));
const statement = stripHtml(P.content).slice(0, 1500) || '(statement not available offline; rely on the title and tags)';
const constraints = stripHtml(P.content).match(/[^.]*(<=|≤|10\^)[^.]*/g) || [];

// ---- time travel ----
let asOf = Infinity, replaySub = null, replayDet = null, myAttempt = attempts.find((a) => a.slug === SLUG) || null;
if (REPLAY) { replaySub = subById.get(String(REPLAY)); replayDet = details.get(String(REPLAY)); if (!replaySub) throw new Error('unknown submission ' + REPLAY); asOf = Number(replaySub.timestamp); }
const solvedBefore = attempts.filter((a) => a.solved && a.first_ac_ts < asOf && a.slug !== SLUG);
const attemptsBefore = attempts.filter((a) => a.first_ts < asOf && a.slug !== SLUG);

// ---- skill summary ----
const tagCount = {}; for (const a of solvedBefore) for (const t of a.tags) { tagCount[t] = tagCount[t] || { solved: 0, w: 0, hard: 0 }; tagCount[t].solved++; tagCount[t].w += a.difficulty === 'hard' ? 4 : a.difficulty === 'medium' ? 2 : 1; if (a.difficulty === 'hard') tagCount[t].hard++; }
const level = (c) => (!c || c.solved === 0) ? 'new' : (c.w > 30 || c.hard >= 5) ? 'strong' : (c.w > 12 || c.hard >= 2) ? 'solid' : 'learning';
const fam = (set) => { const items = solvedBefore.filter((a) => a.tags.some((t) => set.has(t))); const c = { solved: items.length, w: items.reduce((s, a) => s + (a.difficulty === 'hard' ? 4 : a.difficulty === 'medium' ? 2 : 1), 0), hard: items.filter((a) => a.difficulty === 'hard').length }; return { level: level(c), solved: c.solved, sample: items.slice(-3).map((a) => a.title) }; };
const counts = { easy: solvedBefore.filter((a) => a.difficulty === 'easy').length, medium: solvedBefore.filter((a) => a.difficulty === 'medium').length, hard: solvedBefore.filter((a) => a.difficulty === 'hard').length };
const band = solvedBefore.length < 30 ? 'beginner' : (solvedBefore.length < 150 || counts.hard < 10) ? 'intermediate' : 'advanced';
const strengths = Object.entries(tagCount).filter(([t]) => !UMBRELLA.has(t)).sort((a, b) => b[1].w - a[1].w).slice(0, 4).map(([t, c]) => `${t} (${c.solved})`);
const skill = { band, solved: solvedBefore.length, counts, dp: fam(DPT), graph: fam(GRT), strengths };

// ---- anchors ----
const mySubs = membership.get(SLUG) || []; const myFine = tags.filter((t) => FINE.has(t));
const cands = [];
for (const a of solvedBefore) {
  const theirSubs = membership.get(a.slug) || []; const sharedSub = mySubs.filter((m) => theirSubs.some((n) => n.id === m.id));
  const sharedFine = myFine.filter((t) => a.tags.includes(t)); const sharedSpecific = tags.filter((t) => !UMBRELLA.has(t) && a.tags.includes(t));
  if (!sharedSub.length && !sharedFine.length) continue;
  let score = 3 * (sharedSub.length > 0) + (sharedSub.some((m) => m.primary && theirSubs.find((n) => n.id === m.id && n.primary)) ? 1 : 0) + 2 * (sharedFine.length > 0) + 0.5 * sharedSpecific.length;
  const ageDays = (asOf === Infinity ? Date.now() / 1000 : asOf) - a.first_ac_ts; score += ageDays < 180 * 86400 ? 0.5 : 0; if (a.attempts_to_ac === 1) score += 0.2;
  const dr = { easy: 0, medium: 1, hard: 2 }; if (Math.abs((dr[a.difficulty] ?? 1) - (dr[P.difficulty?.toLowerCase()] ?? 1)) === 2) score -= 0.5;
  const why = sharedSub.length ? `same idea: ${subLabel.get(sharedSub[0].id)}` : `shares LeetCode's ${sharedFine[0]} tag`;
  cands.push({ slug: a.slug, title: a.title, difficulty: a.difficulty, score: r2(score), why, solved_on: new Date(a.first_ac_ts * 1000).toISOString().slice(0, 10), attempts_to_ac: a.attempts_to_ac, first_ac_id: a.sequence[a.attempts_to_ac - 1].id });
}
cands.sort((x, y) => y.score - x.score); const anchors = cands.slice(0, 3);
for (const an of anchors) { const d = details.get(String(an.first_ac_id)); an.code_excerpt = d && d.code ? d.code.split('\n').slice(0, 40).join('\n') : null; }

// ---- habits as-of (recency-aware) ----
const nowTs = asOf === Infinity ? Math.max(...attempts.map((a) => a.first_ts)) : asOf; const WINDOW = 180 * 86400;
const failEvents = []; for (const a of attemptsBefore) { const fails = a.solved ? a.sequence.slice(0, a.attempts_to_ac - 1) : a.sequence.filter((s) => s.status !== 10); for (const s of fails) if (s.ts < asOf) failEvents.push({ slug: a.slug, subs: (membership.get(a.slug) || []).map((m) => m.id), bucket: s.bucket, ts: s.ts, recent: nowTs - s.ts < WINDOW }); }
const habits = [];
const ovAll = failEvents.filter((e) => OVERFLOW.has(e.bucket)); const ovRecent = ovAll.filter((e) => e.recent); const failRecent = failEvents.filter((e) => e.recent);
if (ovAll.length >= 5 && ovAll.length / failEvents.length >= 0.08) habits.push({ key: 'overflow', live: ovRecent.length >= 3 && ovRecent.length / Math.max(1, failRecent.length) >= 0.08, statement: `${ovAll.length} of ${failEvents.length} failed submissions were integer overflow or missing-modulo errors${ovRecent.length ? `; ${ovRecent.length} of them in the last 6 months` : ''}. Examples: ${[...new Set(ovAll.slice(-3).map((e) => e.slug))].join(', ')}.`, precision_tier: 'high' });
const recent100 = solvedBefore.slice(-100); const base = mean(recent100.map((a) => a.attempts_to_ac)) || 1.5;
for (const m of mySubs) {
  const items = solvedBefore.filter((a) => (membership.get(a.slug) || []).some((n) => n.id === m.id)); if (items.length < 4) continue;
  const mu = mean(items.map((a) => a.attempts_to_ac)); const recentItems = items.filter((a) => nowTs - a.first_ac_ts < WINDOW); const muRecent = mean(recentItems.map((a) => a.attempts_to_ac));
  if (mu / base >= 1.5) habits.push({ key: `gap:${m.id}`, live: recentItems.length >= 2 && muRecent / base >= 1.5, statement: `${subLabel.get(m.id)}: ${items.length} solved with ${r2(mu)} attempts on average vs your usual ${r2(base)}${recentItems.length ? `; in the last 6 months ${recentItems.length} solved at ${r2(muRecent)} attempts` : '; none solved in the last 6 months'}.`, precision_tier: 'medium' });
  const ev = failEvents.filter((e) => e.subs.includes(m.id) && !/unknown/.test(e.bucket)); if (ev.length >= 5) { const hist = {}; for (const e of ev) hist[e.bucket] = (hist[e.bucket] || 0) + 1; const top = Object.entries(hist).sort((a, b) => b[1] - a[1])[0]; if (top[1] / ev.length >= 0.6) habits.push({ key: `bucket:${m.id}:${top[0]}`, live: ev.filter((e) => e.recent && e.bucket === top[0]).length >= 3, statement: `On ${subLabel.get(m.id)} problems, ${top[1]} of your ${ev.length} failures were ${top[0].replace(/_/g, ' ')}.`, precision_tier: ['re_overflow', 're_null_memo', 'tle'].includes(top[0]) ? 'high' : top[0] === 'mle_state' ? 'low' : 'medium' }); }
}

// ---- verdict + code + policy ----
let verdict = null, code = null, priorFailsHere = 0;
if (replaySub) { priorFailsHere = myAttempt ? myAttempt.sequence.filter((s) => s.ts < asOf && s.status !== 10).length : 0; code = replaySub.code || (replayDet && replayDet.code) || null; verdict = { status: replaySub.statusDisplay, bucket: (myAttempt && (myAttempt.sequence.find((s) => String(s.id) === String(REPLAY)) || {}).bucket) || null, lastTestcase: String((replayDet || {}).lastTestcase || '').slice(0, 300), expected: String((replayDet || {}).expectedOutput || '').slice(0, 200), got: String((replayDet || {}).codeOutput || '').slice(0, 200), error: String((replayDet || {}).runtimeError || (replayDet || {}).compileError || '').slice(0, 400), passed: `${(replayDet || {}).totalCorrect ?? '?'}/${(replayDet || {}).totalTestcases ?? '?'}` }; }
const attemptsCount = priorFailsHere + (replaySub ? 1 : 0); const maxRung = Math.min(4, replaySub ? 3 : 2); const rung = RUNG || (replaySub ? 3 : 2);
const contract = { rung, max_rung: maxRung, diagnostic_focus: replaySub && verdict ? verdict.bucket : null, code_allowed: rung === 4 ? 'blanked_pseudocode' : 'none', must_end_with_question: true };

// ---- ground truth (hidden from tutors) ----
const lab = labels.find((l) => String(l.submission_id) === String(REPLAY)); let truth = null;
if (replaySub) { const seq = myAttempt.sequence; const i = seq.findIndex((s) => String(s.id) === String(REPLAY)); const next = seq[i + 1]; const nextSub = next ? subById.get(String(next.id)) : null; truth = { real_bug_locus: lab ? lab.final_locus : null, fix_summary: lab ? lab.votes[0].fix : null, evidence: lab ? lab.votes[0].evidence : null, next_attempt_status: next ? next.statusDisplay : null, next_attempt_code: nextSub ? (nextSub.code || (details.get(String(next.id)) || {}).code || null) : null }; }

const ctx = { case: { slug: SLUG, replay: REPLAY, as_of: asOf === Infinity ? null : new Date(asOf * 1000).toISOString(), history_visible: { solved: solvedBefore.length, failed_events: failEvents.length } }, problem: { title: P.title, frontend_id: P.questionFrontendId, difficulty: P.difficulty, tags, statement, constraints: constraints.slice(0, 6), leetcode_hints: (P.hints || []).map(stripHtml) }, student: skill, anchors, habits, verdict, current_code: code, contract, truth };
fs.writeFileSync(OUT, JSON.stringify(ctx, null, 1));
console.log(`${SLUG}${REPLAY ? ' replay ' + REPLAY : ''}: history ${solvedBefore.length} solved, anchors ${anchors.length} [${anchors.map((a) => a.slug).join(', ')}], habits ${habits.length} [${habits.map((h) => h.key + (h.live ? '' : ' (stale)')).join(', ')}], rung ${rung}${verdict ? ', verdict ' + verdict.status + '/' + verdict.bucket : ''}${truth ? ', truth=' + truth.real_bug_locus : ''} -> ${OUT}`);
