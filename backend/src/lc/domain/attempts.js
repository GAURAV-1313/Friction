'use strict';
const { statusOf, bucketOf } = require('./buckets');
const { normDiff } = require('./seed');

// Crude line-overlap similarity, used only for the quick_after_tle fragile flag.
function similarity(a, b) {
  const la = new Set(String(a || '').split('\n').map((l) => l.trim()).filter(Boolean));
  const lb = new Set(String(b || '').split('\n').map((l) => l.trim()).filter(Boolean));
  if (!la.size || !lb.size) return 0;
  let inter = 0;
  for (const l of la) if (lb.has(l)) inter++;
  return inter / Math.max(la.size, lb.size);
}

function normalizeSubmission(s) {
  const id = s.lc_submission_id ?? s.id;
  const hasFlag = s.has_details === 1 || s.has_details === true;
  const anyDetail = [s.last_testcase, s.lastTestcase, s.error_text, s.runtimeError, s.compileError, s.expected_output, s.expectedOutput, s.code_output, s.codeOutput].some((v) => v !== undefined && v !== null && v !== '');
  const detailsPresent = hasFlag || (s.has_details === undefined && anyDetail);
  const bucket = s.verdict_bucket || bucketOf(s, detailsPresent ? s : null);
  return {
    id: id === undefined || id === null ? null : Number(id),
    slug: s.slug || s.titleSlug || s.title_slug || null,
    title: s.title || null,
    ts: Number(s.ts ?? s.timestamp ?? 0),
    status: statusOf(s),
    statusDisplay: s.status_msg ?? s.statusDisplay ?? s.status_display ?? null,
    lang: s.lang || null,
    bucket,
    hasDetails: !!detailsPresent,
    runtimePercentile: s.runtime_percentile ?? s.runtimePercentile ?? null,
    pending: s.isPending && s.isPending !== 'Not Pending'
  };
}

/**
 * buildAttempts(submissions, problemsBySlug, seed, { codeLookup })
 *  submissions: DB rows or wire rows; problemsBySlug: Map slug -> {title, difficulty, tags}
 *  codeLookup(id) -> string|null (only consulted for TLE->AC pairs within 300 s)
 * Returns one attempt record per problem, oldest first (same shape as lc-research analyze.js).
 */
function buildAttempts(submissions, problemsBySlug, seed, opts = {}) {
  const codeLookup = opts.codeLookup || (() => null);
  const bySlug = new Map();
  for (const raw of submissions || []) {
    const s = normalizeSubmission(raw);
    if (!s.slug || s.pending || s.id === null) continue;
    if (!bySlug.has(s.slug)) bySlug.set(s.slug, []);
    bySlug.get(s.slug).push(s);
  }
  const attempts = [];
  for (const [slug, list] of bySlug) {
    list.sort((a, b) => a.ts - b.ts || a.id - b.id);
    const p = (problemsBySlug && problemsBySlug.get(slug)) || (seed && seed.problemFromCatalog(slug)) || {};
    const tags = p.tags || p.topic_tags || [];
    const seq = list.map((s) => ({ id: s.id, ts: s.ts, status: s.status, statusDisplay: s.statusDisplay, lang: s.lang, bucket: s.bucket, hasDetails: s.hasDetails, runtimePercentile: s.runtimePercentile }));
    const firstAc = seq.findIndex((x) => x.status === 10);
    const fails = firstAc === -1 ? seq.filter((x) => x.status !== 10) : seq.slice(0, firstAc);
    const fragile = [];
    if (firstAc > 0) {
      const ac = seq[firstAc];
      const prev = seq[firstAc - 1];
      if (prev.status === 14 && ac.ts - prev.ts < 300) {
        const codeA = codeLookup(ac.id);
        const codeP = codeLookup(prev.id);
        if (codeA && codeP && similarity(codeA, codeP) > 0.8) fragile.push('quick_after_tle');
      }
    }
    attempts.push({
      slug,
      title: p.title || list[0].title || slug,
      difficulty: normDiff(p.difficulty),
      tags,
      families: seed ? seed.familiesOf(tags) : [],
      subpatterns: seed ? seed.subpatternsOf(slug) : [],
      primary: seed ? seed.primarySub(slug) : null,
      n_submissions: seq.length,
      first_ts: seq[0].ts,
      first_ac_ts: firstAc === -1 ? null : seq[firstAc].ts,
      first_ac_id: firstAc === -1 ? null : seq[firstAc].id,
      attempts_to_ac: firstAc === -1 ? null : firstAc + 1,
      solved: firstAc !== -1,
      fails_before_ac: fails.length,
      fail_buckets: fails.map((f) => f.bucket),
      time_to_ac_s: firstAc === -1 ? null : seq[firstAc].ts - seq[0].ts,
      fragile_flags: fragile,
      sequence: seq
    });
  }
  attempts.sort((a, b) => a.first_ts - b.first_ts || (a.slug < b.slug ? -1 : 1));
  return attempts;
}

module.exports = { similarity, normalizeSubmission, buildAttempts };
