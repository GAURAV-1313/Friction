'use strict';
const { DP_TAGS, GRAPH_TAGS, UMBRELLA, FAMILY_LABEL } = require('./constants');

const WEIGHT = { easy: 1, medium: 2, hard: 4 };

function levelOf(c) {
  if (!c || c.solved === 0) return 'new';
  if (c.w > 30 || c.hard >= 5) return 'strong';
  if (c.w > 12 || c.hard >= 2) return 'solid';
  return 'learning';
}

function countsFor(items) {
  const c = { solved: items.length, w: 0, hard: 0 };
  for (const a of items) { c.w += WEIGHT[a.difficulty] || 1; if (a.difficulty === 'hard') c.hard++; }
  return c;
}

function familyLevel(solvedAttempts, tagSet, label) {
  const items = solvedAttempts.filter((a) => a.tags.some((t) => tagSet.has(t)));
  const c = countsFor(items);
  const recent = items.slice().sort((a, b) => a.first_ac_ts - b.first_ac_ts).slice(-3);
  return { label, level: levelOf(c), solved: c.solved, hard: c.hard, sample: recent.map((a) => a.title) };
}

function skillSummary(solvedAttemptsIn, asOf) {
  const solved = solvedAttemptsIn.filter((a) => a.solved && (asOf === undefined || asOf === null || a.first_ac_ts < asOf));
  const tagCount = {};
  for (const a of solved) for (const t of a.tags) { tagCount[t] = tagCount[t] || { solved: 0, w: 0, hard: 0 }; tagCount[t].solved++; tagCount[t].w += WEIGHT[a.difficulty] || 1; if (a.difficulty === 'hard') tagCount[t].hard++; }
  const counts = { easy: solved.filter((a) => a.difficulty === 'easy').length, medium: solved.filter((a) => a.difficulty === 'medium').length, hard: solved.filter((a) => a.difficulty === 'hard').length };
  const band = solved.length < 30 ? 'beginner' : (solved.length < 150 || counts.hard < 10) ? 'intermediate' : 'advanced';
  const tagLevels = {};
  for (const [t, c] of Object.entries(tagCount)) tagLevels[t] = { level: levelOf(c), solved: c.solved };
  const strengths = Object.entries(tagCount).filter(([t]) => !UMBRELLA.has(t)).sort((a, b) => b[1].w - a[1].w || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([t, c]) => ({ tag: t, solved: c.solved }));
  const dp = familyLevel(solved, DP_TAGS, FAMILY_LABEL.dp);
  const graph = familyLevel(solved, GRAPH_TAGS, FAMILY_LABEL.graph);
  const gaps = [];
  if (band !== 'beginner') { if (dp.level === 'new' || dp.level === 'learning') gaps.push('dp'); if (graph.level === 'new' || graph.level === 'learning') gaps.push('graph'); }
  return {
    version: 'v0',
    computed_at: asOf || null,
    band,
    solved: solved.length,
    counts,
    dp,
    graph,
    strengths,
    gaps,
    tag_levels: tagLevels,
    cold_start: solved.length === 0 ? 'none' : solved.length <= 20 ? 'thin' : 'ok'
  };
}

module.exports = { levelOf, familyLevel, skillSummary, WEIGHT };
