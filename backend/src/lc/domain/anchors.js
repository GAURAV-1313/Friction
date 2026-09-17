'use strict';
const { TECHNIQUE_TAGS, UMBRELLA, DIFFICULTY_RANK, ANCHOR_MIN_SCORE, WINDOW_S } = require('./constants');

const r2 = (x) => Math.round(x * 100) / 100;

/**
 * scoreAnchors({ target:{slug, tags, difficulty}, solvedAttempts, asOf, seed, minScore, limit })
 *
 * An anchor is a problem the student has already solved that is worth naming while
 * they are stuck on this one. Eligibility runs in three tiers, strongest first:
 *
 *   1. subpattern  a shared verified seed sub-pattern      "same idea: interval DP"
 *   2. technique   a shared technique tag                  "you both solved it with a monotonic stack"
 *   3. topic       two or more shared topic tags           "another array + hash-table problem of yours"
 *
 * The third tier exists so that EVERY problem can be anchored. With only the first
 * two, and with the technique set holding nothing but DP and graph algorithm names,
 * 84% of the catalogue was structurally unanchorable: a problem tagged only
 * ['array','hash-table'] could never match anything, no matter what the student had
 * solved, and the panel then wrongly told them none of their solves was related.
 *
 * A weak anchor is still worse than none, so the tier only sets the starting score.
 * Everything below minScore is dropped, which means a topic-tier candidate has to
 * earn its place with recency or a matching difficulty. similarQuestions never gates.
 */
// Tuned against the real catalogue with a simulated 84-problem history. Because tier
// outranks score in the sort below, this number cannot promote a topic match over a
// sub-pattern or technique one -- measured: the sub-pattern (270) and technique (1714)
// counts are identical at 1.5, 2.0 and 2.5, and only the topic count moves. So it is
// purely a coverage dial for problems where nothing better exists: 49% of the
// catalogue at 1.5, 80% at 2.5. It sits just under ANCHOR_MIN_SCORE so a topic anchor
// still has to earn the last half point from recency or a shared specific tag.
const TOPIC_BASE = 2.5;
const TIER_RANK = { subpattern: 0, technique: 1, topic: 2 };

function scoreAnchors({ target, solvedAttempts, asOf, seed, minScore = ANCHOR_MIN_SCORE, limit = 3 }) {
  const now = asOf || Math.floor(Date.now() / 1000);
  const mySubs = seed.subpatternsOf(target.slug);
  const myTags = target.tags || [];
  const myTech = myTags.filter((t) => TECHNIQUE_TAGS.has(t));
  const mySpecific = myTags.filter((t) => !UMBRELLA.has(t));
  const myRank = DIFFICULTY_RANK[String(target.difficulty || '').toLowerCase()] ?? 1;
  const cands = [];

  for (const a of solvedAttempts) {
    if (!a.solved || a.slug === target.slug || (a.first_ac_ts && a.first_ac_ts >= now)) continue;
    const theirTags = a.tags || [];
    const theirSubs = seed.subpatternsOf(a.slug);
    const sharedSub = mySubs.filter((m) => theirSubs.some((n) => n.id === m.id));
    const sharedTech = myTech.filter((t) => theirTags.includes(t));
    const sharedTags = myTags.filter((t) => theirTags.includes(t));

    // Two shared tags, or all of them when the problem only carries one. Without the
    // second clause a single-tag problem like reverse-integer (['math']) could never
    // be anchored, and we would tell a student who has solved twenty math problems
    // that none of them overlaps.
    const needTags = Math.min(2, myTags.length);
    const tier = sharedSub.length ? 'subpattern'
      : sharedTech.length ? 'technique'
        : (needTags > 0 && sharedTags.length >= needTags) ? 'topic'
          : null;
    if (!tier) continue;

    const sharedSpecific = mySpecific.filter((t) => theirTags.includes(t));
    const primaryMatch = sharedSub.some((m) => m.primary && theirSubs.some((n) => n.id === m.id && n.primary));
    const theirRank = DIFFICULTY_RANK[a.difficulty] ?? 1;

    // Sub-pattern and technique stay ADDITIVE: a candidate that shares both is
    // strictly the better analogy, and collapsing them into one tier base would
    // throw that away. The topic base only applies when neither matched.
    let score = 3 * (sharedSub.length > 0) + (primaryMatch ? 1 : 0) + 2 * (sharedTech.length > 0) + 0.5 * sharedSpecific.length;
    if (tier === 'topic') score += TOPIC_BASE;
    if (a.first_ac_ts && now - a.first_ac_ts < WINDOW_S) score += 0.5;
    if (a.attempts_to_ac === 1) score += 0.2;
    if (Math.abs(theirRank - myRank) === 2) score -= 0.5;

    const why = tier === 'subpattern'
      ? `same idea: ${seed.subLabel.get(sharedSub[0].id)}`
      : tier === 'technique'
        ? `shares LeetCode's ${sharedTech[0]} tag`
        : `another ${sharedTags.slice(0, 2).join(' + ')} problem you solved`;

    cands.push({
      slug: a.slug,
      title: a.title,
      difficulty: a.difficulty,
      score: r2(score),
      why,
      tier,
      subpattern: sharedSub.length ? sharedSub[0].id : null,
      fine_tag: sharedTech[0] || null,
      solved_on: a.first_ac_ts ? new Date(a.first_ac_ts * 1000).toISOString().slice(0, 10) : null,
      attempts_to_ac: a.attempts_to_ac,
      first_ac_submission_id: a.first_ac_id
    });
  }

  // Tier outranks score, not the other way round. "Same idea" beats "same technique"
  // beats "same topic", and score only orders within a tier. A topic match can
  // otherwise accumulate enough recency and tag overlap to outscore a real analogy --
  // which is how a sliding-window problem ended up being anchored to "another
  // hash-table + string problem you solved" instead of to an actual sliding window.
  cands.sort((x, y) => TIER_RANK[x.tier] - TIER_RANK[y.tier]
    || y.score - x.score
    || (y.solved_on || '').localeCompare(x.solved_on || '')
    || x.slug.localeCompare(y.slug));
  const top = cands.slice(0, limit);
  // Never blame the student's history for a gap that is ours. "Nothing of yours is
  // related" is only honest when something of theirs could have been.
  if (!top.length) return { anchors: [], omitted_reason: 'no_eligible' };
  if (top[0].score < minScore) return { anchors: [], omitted_reason: 'below_threshold' };
  return { anchors: top.filter((c) => c.score >= minScore), omitted_reason: null };
}

module.exports = { scoreAnchors };
