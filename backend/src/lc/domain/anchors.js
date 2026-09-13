'use strict';
const { FINE_ALGO, UMBRELLA, DIFFICULTY_RANK, ANCHOR_MIN_SCORE, WINDOW_S } = require('./constants');

const r2 = (x) => Math.round(x * 100) / 100;

/**
 * scoreAnchors({ target:{slug, tags, difficulty}, solvedAttempts, asOf, seed, minScore, limit })
 * Eligibility: shared seed sub-pattern OR shared fine-grained algorithm tag. similarQuestions never gates.
 */
function scoreAnchors({ target, solvedAttempts, asOf, seed, minScore = ANCHOR_MIN_SCORE, limit = 3 }) {
  const now = asOf || Math.floor(Date.now() / 1000);
  const mySubs = seed.subpatternsOf(target.slug);
  const myTags = target.tags || [];
  const myFine = myTags.filter((t) => FINE_ALGO.has(t));
  const mySpecific = myTags.filter((t) => !UMBRELLA.has(t));
  const myRank = DIFFICULTY_RANK[String(target.difficulty || '').toLowerCase()] ?? 1;
  const cands = [];
  for (const a of solvedAttempts) {
    if (!a.solved || a.slug === target.slug || (a.first_ac_ts && a.first_ac_ts >= now)) continue;
    const theirSubs = seed.subpatternsOf(a.slug);
    const sharedSub = mySubs.filter((m) => theirSubs.some((n) => n.id === m.id));
    const sharedFine = myFine.filter((t) => a.tags.includes(t));
    if (!sharedSub.length && !sharedFine.length) continue;
    const sharedSpecific = mySpecific.filter((t) => a.tags.includes(t));
    const primaryMatch = sharedSub.some((m) => m.primary && theirSubs.some((n) => n.id === m.id && n.primary));
    let score = 3 * (sharedSub.length > 0) + (primaryMatch ? 1 : 0) + 2 * (sharedFine.length > 0) + 0.5 * sharedSpecific.length;
    if (a.first_ac_ts && now - a.first_ac_ts < WINDOW_S) score += 0.5;
    if (a.attempts_to_ac === 1) score += 0.2;
    if (Math.abs((DIFFICULTY_RANK[a.difficulty] ?? 1) - myRank) === 2) score -= 0.5;
    const why = sharedSub.length ? `same idea: ${seed.subLabel.get(sharedSub[0].id)}` : `shares LeetCode's ${sharedFine[0]} tag`;
    cands.push({
      slug: a.slug,
      title: a.title,
      difficulty: a.difficulty,
      score: r2(score),
      why,
      subpattern: sharedSub.length ? sharedSub[0].id : null,
      fine_tag: sharedFine[0] || null,
      solved_on: a.first_ac_ts ? new Date(a.first_ac_ts * 1000).toISOString().slice(0, 10) : null,
      attempts_to_ac: a.attempts_to_ac,
      first_ac_submission_id: a.first_ac_id
    });
  }
  cands.sort((x, y) => y.score - x.score || (y.solved_on || '').localeCompare(x.solved_on || '') || x.slug.localeCompare(y.slug));
  const top = cands.slice(0, limit);
  if (!top.length) return { anchors: [], omitted_reason: 'no_eligible' };
  if (top[0].score < minScore) return { anchors: [], omitted_reason: 'below_threshold' };
  return { anchors: top.filter((c) => c.score >= minScore), omitted_reason: null };
}

module.exports = { scoreAnchors };
