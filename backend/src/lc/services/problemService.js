'use strict';
/**
 * problemService: the shared problem cache (lc_problems). HTML stripped, excerpt clamped to 1500 and
 * constraints to 1000 chars, first writer wins per column (repo.problems.upsertFirstWriter).
 *
 *   upsertProblem(pool, userId, slug, body, { seed }) -> { ok, slug, created }
 */
const repo = require('../db/repo');
const { HttpError } = require('../middleware/errors');
const { isSlug, clampStr, stripHtml, isPlainObject } = require('../middleware/validate');
const { normDiff } = require('../domain/seed');

const EXCERPT_CAP = 1500;
const CONSTRAINTS_CAP = 1000;
const TITLE_CAP = 255;
const ID_CAP = 16;
const MAX_TAGS = 40;
const MAX_SIMILAR = 50;
const MAX_HINTS = 10;
const HINT_CAP = 500;

const text = (v, n) => { const s = clampStr(stripHtml(v), n); return s && s.trim() ? s.trim() : null; };
// Like text() but keeps line structure (the extension joins constraint lines with '\n'; contextBuilder splits them back).
const multiline = (v, n) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/<\/(li|p|div|tr)>|<br\s*\/?>/gi, '\n').split(/\r?\n/).map((l) => stripHtml(l)).filter(Boolean).join('\n');
  const c = clampStr(s, n);
  return c && c.trim() ? c.trim() : null;
};
const idStr = (v) => (v === undefined || v === null || v === '' ? null : String(v).trim().slice(0, ID_CAP) || null);

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const raw = typeof t === 'string' ? t : (t && typeof t.slug === 'string' ? t.slug : null);
    if (!raw) continue;
    const s = raw.trim().toLowerCase().slice(0, 64);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function cleanSlugs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    const s = typeof x === 'string' ? x : (x && typeof x.titleSlug === 'string' ? x.titleSlug : (x && typeof x.slug === 'string' ? x.slug : null));
    if (isSlug(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_SIMILAR) break;
  }
  return out;
}

function cleanHints(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const h of list) {
    const s = text(h, HINT_CAP);
    if (s) out.push(s);
    if (out.length >= MAX_HINTS) break;
  }
  return out;
}

function normalizeProblem(userId, slug, body, seed) {
  if (!isSlug(slug)) throw new HttpError(400, 'invalid_slug');
  if (!isPlainObject(body)) throw new HttpError(400, 'invalid_body');
  const cat = seed ? seed.problemFromCatalog(slug) : null;
  const title = text(body.title, TITLE_CAP) || (cat && cat.title) || null;
  if (!title) throw new HttpError(400, 'title_required');
  const tags = cleanTags(body.topic_tags ?? body.topicTags ?? body.tags);
  const similar = cleanSlugs(body.similar_slugs ?? body.similarQuestions);
  const hints = cleanHints(body.hints);
  const catTags = cat && Array.isArray(cat.tags) ? cat.tags : [];
  return {
    slug,
    title,
    frontend_id: idStr(body.frontend_id ?? body.questionFrontendId) || (cat && cat.frontendId) || null,
    question_id: idStr(body.question_id ?? body.questionId),
    difficulty: normDiff(body.difficulty) || (cat && cat.difficulty) || null,
    topic_tags: tags.length ? tags : (catTags.length ? catTags : null),
    similar_slugs: similar.length ? similar : null,
    hints: hints.length ? hints : null,
    // The extension's problemMeta() sends camelCase (statementExcerpt / constraintsText); accept both spellings.
    statement_excerpt: text(body.statement_excerpt ?? body.statementExcerpt ?? body.content, EXCERPT_CAP),
    constraints_text: multiline(body.constraints_text ?? body.constraintsText, CONSTRAINTS_CAP),
    is_paid: !!(body.is_paid ?? body.isPaidOnly),
    first_writer_user_id: userId
  };
}

async function upsertProblem(pool, userId, slug, body, { seed } = {}) {
  const p = normalizeProblem(userId, slug, body, seed);
  const { created } = await repo.problems.upsertFirstWriter(pool, p);
  return { ok: true, slug, created: !!created, has_excerpt: !!p.statement_excerpt, has_constraints: !!p.constraints_text, tags: p.topic_tags || [] };
}

module.exports = { upsertProblem, normalizeProblem, cleanTags, cleanSlugs, cleanHints };
