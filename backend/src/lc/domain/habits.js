'use strict';
const { OVERFLOW_SHAPED, BUCKET_TIERS, WINDOW_S } = require('./constants');
const { baselines, difficultyMatchedBaseline, mean, r2 } = require('./aggregate');

const BIG_CONSTRAINT = /10\^(9|18)|1e9|10\s*\^\s*9|1000000007|10\^9\s*\+\s*7|\bmod(ulo)?\b/i;

/**
 * computeHabits({ attempts, asOf, seed }) -> habit[]
 * Deterministic. Each habit: {key, category, subpattern, bucket, tier, live, counts, evidence, statement_template}
 * Stale habits (live=false) are returned so the caller can persist state; the prompt only ever sees live ones.
 */
function computeHabits({ attempts, asOf, seed }) {
  const now = asOf || Math.floor(Date.now() / 1000);
  const solved = attempts.filter((a) => a.solved && a.first_ac_ts < now).sort((a, b) => a.first_ac_ts - b.first_ac_ts);
  const base = baselines(solved);
  const failEvents = [];
  for (const a of attempts) {
    const fails = a.solved ? a.sequence.slice(0, a.attempts_to_ac - 1) : a.sequence.filter((s) => s.status !== 10);
    for (const s of fails) if (s.ts < now) failEvents.push({ slug: a.slug, subs: (a.subpatterns || []).map((m) => m.id), bucket: s.bucket, ts: s.ts, recent: now - s.ts < WINDOW_S });
  }
  const habits = [];
  // 1. Integer overflow / missing modulo (global, tier high).
  const ovAll = failEvents.filter((e) => OVERFLOW_SHAPED.has(e.bucket));
  const ovRecent = ovAll.filter((e) => e.recent);
  const failRecent = failEvents.filter((e) => e.recent);
  if (ovAll.length >= 5 && failEvents.length && ovAll.length / failEvents.length >= 0.08) {
    habits.push({
      key: 'overflow', category: 'overflow', subpattern: null, bucket: 're_overflow', tier: 'high',
      live: ovRecent.length >= 3 && ovRecent.length / Math.max(1, failRecent.length) >= 0.08,
      counts: { n: ovAll.length, of: failEvents.length, recent_n: ovRecent.length, recent_of: failRecent.length },
      evidence: { examples: [...new Set(ovAll.slice(-5).map((e) => e.slug))].slice(-3) },
      statement_template: 'overflow'
    });
  }
  // 2 + 3. Per sub-pattern: attempts gap and bucket skew.
  const subIds = new Set();
  for (const a of attempts) for (const m of a.subpatterns || []) subIds.add(m.id);
  for (const id of [...subIds].sort()) {
    const items = solved.filter((a) => (a.subpatterns || []).some((m) => m.id === id));
    if (items.length >= 4) {
      const mu = mean(items.map((a) => a.attempts_to_ac));
      const expected = difficultyMatchedBaseline(items, base);
      const recentItems = items.filter((a) => now - a.first_ac_ts < WINDOW_S);
      const muRecent = mean(recentItems.map((a) => a.attempts_to_ac));
      const expRecent = recentItems.length ? difficultyMatchedBaseline(recentItems, base) : expected;
      if (expected && mu / expected >= 1.5) {
        habits.push({
          key: `gap:${id}`, category: 'gap', subpattern: id, bucket: null, tier: 'medium',
          live: recentItems.length >= 2 && muRecent !== null && expRecent && muRecent / expRecent >= 1.5,
          counts: { n: items.length, mean_attempts: r2(mu), expected: r2(expected), recent_n: recentItems.length, recent_mean: r2(muRecent), ratio: r2(mu / expected) },
          evidence: { examples: items.slice(-3).map((a) => a.slug) },
          statement_template: 'gap'
        });
      }
    }
    const ev = failEvents.filter((e) => e.subs.includes(id) && !/unknown/.test(e.bucket));
    if (ev.length >= 5) {
      const hist = {};
      for (const e of ev) hist[e.bucket] = (hist[e.bucket] || 0) + 1;
      const top = Object.entries(hist).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      const tier = BUCKET_TIERS[top[0]] || null;
      if (tier && top[1] / ev.length >= 0.6) {
        habits.push({
          key: `bucket:${id}:${top[0]}`, category: 'bucket', subpattern: id, bucket: top[0], tier,
          live: ev.filter((e) => e.recent && e.bucket === top[0]).length >= 3,
          counts: { n: top[1], of: ev.length, share: r2(top[1] / ev.length), recent_n: ev.filter((e) => e.recent && e.bucket === top[0]).length },
          evidence: { examples: [...new Set(ev.filter((e) => e.bucket === top[0]).slice(-5).map((e) => e.slug))].slice(-3) },
          statement_template: 'bucket'
        });
      }
    }
  }
  return habits;
}

const BUCKET_WORDS = {
  en: { re_overflow: 'integer overflow', re_null_memo: 'a null or missing-entry crash', tle: 'a time limit', wa_logic: 'a wrong answer on a normal case', wa_modulo: 'a modulo or overflow mismatch', wa_edge_empty: 'a wrong answer on a tiny input', re_index: 'an out-of-bounds index', mle_state: 'a memory limit' },
  hinglish: { re_overflow: 'integer overflow', re_null_memo: 'null ya missing-entry crash', tle: 'time limit', wa_logic: 'normal case pe wrong answer', wa_modulo: 'modulo ya overflow mismatch', wa_edge_empty: 'chhote input pe wrong answer', re_index: 'out-of-bounds index', mle_state: 'memory limit' }
};

function renderStatement(habit, lang, seed) {
  const hi = lang === 'hinglish';
  const c = habit.counts || {};
  const label = habit.subpattern && seed ? (seed.subLabel.get(habit.subpattern) || habit.subpattern) : habit.subpattern;
  if (habit.statement_template === 'overflow') {
    return hi
      ? `Tumhare ${c.of} failed submissions mein se ${c.n} integer overflow ya missing-modulo errors the${c.recent_n ? `, ${c.recent_n} pichhle 6 mahine mein` : ''}.`
      : `${c.n} of your ${c.of} failed submissions were integer overflow or missing-modulo errors${c.recent_n ? `, ${c.recent_n} of them in the last 6 months` : ''}.`;
  }
  if (habit.statement_template === 'gap') {
    return hi
      ? `${label}: ${c.n} solve kiye, average ${c.mean_attempts} attempts vs tumhare usual ${c.expected}${c.recent_n ? ` (pichhle 6 mahine: ${c.recent_n} solved, ${c.recent_mean} attempts)` : ''}.`
      : `${label}: ${c.n} solved at ${c.mean_attempts} attempts on average versus your usual ${c.expected}${c.recent_n ? ` (last 6 months: ${c.recent_n} solved at ${c.recent_mean})` : ''}.`;
  }
  const word = (BUCKET_WORDS[hi ? 'hinglish' : 'en'][habit.bucket] || habit.bucket);
  return hi
    ? `${label} problems pe tumhare ${c.of} failures mein se ${c.n} ${word} the.`
    : `On ${label} problems, ${c.n} of your ${c.of} failures were ${word}.`;
}

/**
 * selectRelevantHabits(habits, targetSubIds, problem, {states}) -> <=2 live habits relevant to this problem.
 * Never stale, never dismissed, never tier low. Global overflow only when constraints suggest large values.
 */
function selectRelevantHabits(habits, targetSubIds, problem, opts = {}) {
  const states = opts.states || {};
  const eligible = habits.filter((h) => h.live && h.tier !== 'low' && states[h.key] !== 'dismissed' && states[h.key] !== 'stale');
  const subs = new Set(targetSubIds || []);
  const text = `${(problem && problem.constraints_text) || ''} ${(problem && problem.statement_excerpt) || ''}`;
  const scored = eligible.map((h) => {
    let relevant = false;
    let s = 0;
    if (h.subpattern && subs.has(h.subpattern)) { relevant = true; s += 3; }
    if (h.category === 'overflow' && BIG_CONSTRAINT.test(text)) { relevant = true; s += 2; }
    if (!relevant) return { h, s: 0 };
    if (states[h.key] === 'confirmed') s += 1;
    if (h.tier === 'high') s += 0.5;
    return { h, s };
  }).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.h.key.localeCompare(b.h.key));
  return scored.slice(0, 2).map((x) => x.h);
}

module.exports = { computeHabits, renderStatement, selectRelevantHabits, BIG_CONSTRAINT };
