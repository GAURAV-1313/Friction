'use strict';
/**
 * anchorService: anchors for a problem = the student's own solved problems that share a verified seed
 * sub-pattern or a fine-grained LeetCode tag (similarQuestions never gates), scored deterministically.
 *
 *   getAnchorsForSlug(pool, userId, slug, { seed, config, now }) ->
 *     { slug, title, difficulty, family, families, subpatterns, anchors:[...+has_code], omitted_reason,
 *       allowed_rung, unlock_reason, submissions_here, solved_here, model_version }
 */
const repo = require('../db/repo');
const modelService = require('./modelService');
const { HttpError } = require('../middleware/errors');
const { isSlug } = require('../middleware/validate');
const { scoreAnchors } = require('../domain/anchors');
const { decideRung } = require('../domain/policy');
const { normDiff } = require('../domain/seed');

function unixNow(now) {
  if (now instanceof Date) return Math.floor(now.getTime() / 1000);
  if (typeof now === 'number' && Number.isFinite(now)) return Math.floor(now > 1e12 ? now / 1000 : now);
  return Math.floor(Date.now() / 1000);
}

function resolveProblem(cached, cat, slug) {
  if (!cached && !cat) return null;
  const tags = (cached && Array.isArray(cached.topic_tags) && cached.topic_tags.length) ? cached.topic_tags : (cat ? cat.tags || [] : []);
  return {
    slug,
    title: (cached && cached.title) || (cat && cat.title) || slug,
    difficulty: normDiff((cached && cached.difficulty) || (cat && cat.difficulty)),
    frontend_id: (cached && cached.frontend_id) || (cat && cat.frontendId) || null,
    tags,
    is_paid: !!((cached && Number(cached.is_paid)) || (cat && cat.paid))
  };
}

async function getAnchorsForSlug(pool, userId, slug, { seed, config, now } = {}) {
  if (!seed) throw new Error('getAnchorsForSlug: seed is required');
  if (!isSlug(slug)) throw new HttpError(400, 'invalid_slug');
  const asOf = unixNow(now);
  const cached = await repo.problems.get(pool, slug);
  const problem = resolveProblem(cached, seed.problemFromCatalog(slug), slug);
  if (!problem) throw new HttpError(404, 'problem_unknown');

  const profile = await repo.profiles.get(pool, userId);
  const loaded = await modelService.loadAttempts(pool, userId, { seed, withCode: false });
  const { anchors, omitted_reason } = scoreAnchors({ target: { slug, tags: problem.tags, difficulty: problem.difficulty }, solvedAttempts: loaded.solvedAttempts, asOf, seed });

  let codeMap = new Map();
  if (profile && Number(profile.consent_code)) {
    const ids = anchors.map((a) => a.first_ac_submission_id).filter((id) => id !== null && id !== undefined);
    if (ids.length) codeMap = await repo.submissions.codeByIds(pool, userId, ids);
  }
  const withCode = anchors.map((a) => ({ ...a, has_code: !!(a.first_ac_submission_id && codeMap.get(Number(a.first_ac_submission_id))) }));

  const here = loaded.bySlug.get(slug) || null;
  const submissionsHere = here ? here.n_submissions : 0;
  const lastFail = here ? [...here.sequence].reverse().find((s) => s.status !== 10) || null : null;
  const contract = decideRung({
    requestedRung: null,
    planStated: false,
    submissionsHere,
    turns: 0,
    lastFailAgeS: lastFail ? Math.max(0, asOf - lastFail.ts) : null,
    lastFailBucket: lastFail ? lastFail.bucket : null,
    isContest: false,
    maxRungGlobal: config && Number.isFinite(config.maxRung) ? config.maxRung : undefined
  });
  const families = seed.familiesOf(problem.tags);
  return {
    slug,
    title: problem.title,
    difficulty: problem.difficulty,
    frontend_id: problem.frontend_id,
    family: families[0] || null,
    families,
    subpatterns: seed.subpatternsOf(slug).map((m) => ({ id: m.id, label: seed.subLabel.get(m.id) || m.id, family: m.family, primary: !!m.primary })),
    anchors: withCode,
    omitted_reason,
    allowed_rung: contract.allowed_rung_next,
    unlock_reason: contract.unlock_reason,
    submissions_here: submissionsHere,
    solved_here: !!(here && here.solved) || loaded.solvedAttempts.some((a) => a.slug === slug),
    model_version: (profile && profile.model_version) || null,
    computed_at: asOf,
    // Every solved title (offered or not); contextBuilder derives guard.offered_titles_not_allowed from it.
    solved_titles: [...new Set((loaded.solvedRows || []).map((r) => r && r.title).filter((t) => typeof t === 'string' && t.trim()))]
  };
}

module.exports = { getAnchorsForSlug, resolveProblem };
