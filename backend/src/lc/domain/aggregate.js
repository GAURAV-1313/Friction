'use strict';
const { BASE_CASE_SHAPED, TRANSITION_SHAPED, OVERFLOW_SHAPED, RECENT_N } = require('./constants');

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);

function aggregate(items) {
  const fails = items.flatMap((a) => a.fail_buckets);
  const known = fails.filter((b) => !/unknown/.test(b));
  const hist = {};
  for (const b of fails) hist[b] = (hist[b] || 0) + 1;
  const baseShaped = known.filter((b) => BASE_CASE_SHAPED.has(b)).length;
  const transShaped = known.filter((b) => TRANSITION_SHAPED.has(b)).length;
  const solvedItems = items.filter((a) => a.solved);
  const flagHist = {};
  for (const a of solvedItems) for (const f of a.fragile_flags) flagHist[f] = (flagHist[f] || 0) + 1;
  return {
    n_problems: items.length,
    n_solved: solvedItems.length,
    n_fails: fails.length,
    n_fails_with_details: known.length,
    fail_hist: hist,
    base_case_skew: known.length ? r2(baseShaped / known.length) : null,
    transition_skew: known.length ? r2(transShaped / known.length) : null,
    tle_share: fails.length ? r2(fails.filter((b) => b === 'tle').length / fails.length) : null,
    overflow_share: fails.length ? r2(fails.filter((b) => OVERFLOW_SHAPED.has(b)).length / fails.length) : null,
    re_share: fails.length ? r2(fails.filter((b) => b.startsWith('re_')).length / fails.length) : null,
    mean_attempts_to_ac: r2(mean(solvedItems.map((a) => a.attempts_to_ac))),
    median_attempts_to_ac: median(solvedItems.map((a) => a.attempts_to_ac)),
    first_try_rate: solvedItems.length ? r2(solvedItems.filter((a) => a.attempts_to_ac === 1).length / solvedItems.length) : null,
    fragile_ac: solvedItems.filter((a) => a.fragile_flags.length).length,
    fragile_flags: flagHist,
    problems: items.map((a) => a.slug)
  };
}

// Baselines over the trailing RECENT_N solved problems (ordered by first_ac_ts), difficulty-stratified.
function baselines(solvedAttempts, recentN = RECENT_N) {
  const solved = solvedAttempts.filter((a) => a.solved).slice().sort((a, b) => a.first_ac_ts - b.first_ac_ts);
  const recent = solved.slice(-recentN);
  const byDiff = {};
  for (const d of ['easy', 'medium', 'hard']) byDiff[d] = r2(mean(recent.filter((a) => a.difficulty === d).map((a) => a.attempts_to_ac)));
  return {
    n_solved: solved.length,
    lifetime_mean: r2(mean(solved.map((a) => a.attempts_to_ac))),
    recent_mean: r2(mean(recent.map((a) => a.attempts_to_ac))),
    recent_n: recent.length,
    by_difficulty: byDiff
  };
}

// Expected attempts for a set of problems given their difficulties, from the recent baseline.
function difficultyMatchedBaseline(items, base) {
  const ws = items.map((a) => (base && base.by_difficulty ? base.by_difficulty[a.difficulty] : null)).filter((x) => x !== null && x !== undefined);
  if (ws.length) return mean(ws);
  if (base && base.recent_mean) return base.recent_mean;
  return 1.5;
}

module.exports = { aggregate, baselines, difficultyMatchedBaseline, mean, median, r2 };
