'use strict';
/**
 * contextBuilder: assembles the per-turn tutor context (`ctx`, shape in README.md) from stored rows.
 * Reads only; never writes; never logs. `body.code` is placed in ctx.current_code for this turn and
 * is never persisted by anyone downstream (chatService persists only message text and metadata).
 *
 * Parallel modules are required lazily inside functions so tests can jest.mock them.
 */
const repo = require('../db/repo');
const { HttpError } = require('../middleware/errors');
const { clampStr } = require('../middleware/validate');
const { decideRung } = require('../domain/policy');
const { selectRelevantHabits, renderStatement } = require('../domain/habits');
const { statusOf, bucketOf, tierOf } = require('../domain/buckets');
const { STATUS_BY_DISPLAY } = require('../domain/constants');
const { familiesOf: familiesOfDefault, normDiff } = require('../domain/seed');

const LIMITS = Object.freeze({
  message: 2000, plan: 500, codeLines: 150, codeChars: 20000, excerptLines: 40, historyN: 10, anchors: 3,
  lastTestcase: 300, expected: 200, got: 200, error: 400, lang: 32
});

// Composer chips → the sentence the tutor sees. `no_idea` states no plan (rung 2 stays locked).
const PLAN_CHIPS = Object.freeze({
  no_idea: null,
  have_plan_fails: 'I have a plan but it fails.',
  too_slow: 'My approach works but it is too slow.',
  wrong_on_edge: 'My approach is wrong on an edge case.'
});
// Older panels sent the chip's display label instead of its key; map those too (case-insensitive).
const PLAN_LABELS = Object.freeze({
  'no idea yet': 'no_idea',
  'have a plan, it fails': 'have_plan_fails',
  'too slow': 'too_slow',
  'wrong on an edge': 'wrong_on_edge'
});

const STATUS_LABEL = Object.fromEntries(Object.entries(STATUS_BY_DISPLAY).map(([k, v]) => [v, k]));

// The panel has no plan chips any more: the student's own sentence is the plan channel.
// Deliberately conservative — a plan only ever buys rung 2, but anything that reads as
// "I have nothing" must NOT count, or the effort gate the chips enforced is silently weakened.
const PLAN_INFER = Object.freeze({ minChars: 20, minWords: 4 });

// Anchored, case-insensitive, matched against the whitespace-collapsed message; trailing punctuation is free.
const PLAN_STOP_EN = /^(help( me)?|hints?( please)?|stuck|i'?m (still )?stuck|i am (still )?stuck|idk|i don'?t know|(i ?(have|'?ve) )?no idea( yet)?|(i ?(have|'?ve) )?no idea (where to start|how to start|what to do|how to do this)|give me a hint|any hint|what now|next|more)\W*$/i;
const PLAN_STOP_HI = /^((mujhe )?kuch samajh nahi( aa raha)?( hai)?|samajh nahi aa raha( hai)?|kuch nahi pata|kuch pata nahi|nahi pata|pata nahi|madad|hint do)\W*$/i;
// The exact sentences the panel's affordance slot sends on the student's behalf (EN + Hinglish),
// normalised to lower case with trailing punctuation stripped: a tap must never buy a rung.
const PLAN_STOP_EXACT = Object.freeze(new Set([
  'i am still stuck',
  'that run failed — what broke',
  'that run failed - what broke',
  'abhi bhi atka hoon',
  'wo run fail hua — kya toota',
  'wo run fail hua - kya toota'
]));

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * inferPlan(messageText) -> string|null
 * The student's typed sentence counts as the plan when ALL hold: >= 20 characters,
 * >= 4 distinct whitespace-separated words, and it is not a no-plan utterance (stoplists above).
 * Never throws: a non-string, an empty string or a stoplisted sentence all return null.
 */
function inferPlan(messageText) {
  if (typeof messageText !== 'string') return null;
  const trimmed = messageText.trim();
  const norm = trimmed.replace(/\s+/g, ' ');
  if (norm.length < PLAN_INFER.minChars) return null;
  const lower = norm.toLowerCase();
  const words = new Set(lower.split(' ').filter(Boolean));
  if (words.size < PLAN_INFER.minWords) return null;
  if (PLAN_STOP_EXACT.has(lower.replace(/\W+$/, ''))) return null;
  if (PLAN_STOP_EN.test(norm) || PLAN_STOP_HI.test(norm)) return null;
  return clampStr(trimmed, LIMITS.plan);
}

/**
 * resolvePlan(bodyPlan, sessionPlan, messageText) -> string|null
 * body.plan wins when provided (chip key or free text ≤500); then the session's stored plan;
 * then — only when there is neither — the student's own message, if it is substantive (inferPlan).
 */
function resolvePlan(bodyPlan, sessionPlan, messageText) {
  if (bodyPlan === undefined || bodyPlan === null) {
    if (sessionPlan) return clampStr(sessionPlan, LIMITS.plan);
    return inferPlan(messageText);
  }
  const s = String(bodyPlan).trim();
  if (!s) return null;
  const key = PLAN_LABELS[s.toLowerCase()] || s;
  if (Object.prototype.hasOwnProperty.call(PLAN_CHIPS, key)) return PLAN_CHIPS[key];
  return clampStr(s, LIMITS.plan);
}

function clampCode(code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  const lines = code.split(/\r?\n/).slice(0, LIMITS.codeLines).join('\n');
  return clampStr(lines, LIMITS.codeChars);
}

function excerptOf(code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  return code.split(/\r?\n/).slice(0, LIMITS.excerptLines).join('\n');
}

function buildProblem(row, catalog, slug, familiesOf) {
  if (!row && !catalog) throw new HttpError(409, 'problem_not_cached', { slug });
  const tags = (row && Array.isArray(row.topic_tags) ? row.topic_tags : null) || (catalog && catalog.tags) || [];
  const families = familiesOf(tags);
  return {
    slug,
    title: (row && row.title) || (catalog && catalog.title) || slug,
    frontend_id: (row && row.frontend_id) || (catalog && catalog.frontendId) || null,
    difficulty: normDiff((row && row.difficulty) || (catalog && catalog.difficulty)),
    family: families[0] || null,
    families,
    tags,
    statement: (row && row.statement_excerpt) || null,
    constraints: splitLines(row && row.constraints_text),
    leetcode_hints: (row && Array.isArray(row.hints) ? row.hints : []).map((h) => String(h))
  };
}

// skill.js stores strengths as [{tag, solved}]; the prompt wants 'tag (solved)' strings.
function strengthLabel(x) {
  if (typeof x === 'string') return x.trim() || null;
  if (!x || typeof x !== 'object' || typeof x.tag !== 'string' || !x.tag.trim()) return null;
  const n = Number(x.solved);
  return Number.isFinite(n) ? `${x.tag} (${n})` : x.tag;
}

function buildStudent(skill) {
  if (!skill || typeof skill !== 'object') return null;
  return {
    band: skill.band || null,
    solved: skill.solved ?? 0,
    counts: skill.counts || { easy: 0, medium: 0, hard: 0 },
    dp: skill.dp || null,
    graph: skill.graph || null,
    strengths: (Array.isArray(skill.strengths) ? skill.strengths : []).map(strengthLabel).filter(Boolean),
    gaps: Array.isArray(skill.gaps) ? skill.gaps : []
  };
}

/** Latest submission row (lc_submissions) -> verdict block, or null when nothing was submitted here. */
function buildVerdict(row, now) {
  if (!row) return null;
  const details = row.has_details ? row : null;
  const bucket = row.verdict_bucket || bucketOf(row, details);
  const code = statusOf(row);
  const ts = Number(row.ts) || null;
  return {
    status: row.status_msg || STATUS_LABEL[code] || 'Unknown',
    status_code: code,
    bucket,
    tier: tierOf(bucket),
    lastTestcase: clampStr(row.last_testcase || '', LIMITS.lastTestcase),
    expected: clampStr(row.expected_output || '', LIMITS.expected),
    got: clampStr(row.code_output || '', LIMITS.got),
    error: clampStr(row.error_text || '', LIMITS.error),
    passed: `${row.total_correct ?? '?'}/${row.total_testcases ?? '?'}`,
    age_s: ts && Number.isFinite(now) ? Math.max(0, now - ts) : null
  };
}

// lc_habits row -> the domain habit shape selectRelevantHabits/renderStatement expect.
function toDomainHabit(row) {
  return {
    id: row.id,
    key: row.habit_key,
    category: row.category,
    subpattern: row.subpattern || null,
    bucket: row.bucket || null,
    tier: row.tier,
    live: !!Number(row.live),
    counts: row.counts || {},
    evidence: row.evidence || {},
    statement_template: row.category
  };
}

/**
 * buildChatContext(pool, { userId, slug, body, profile, session?, seed, config, now }) -> ctx
 * Throws HttpError 409 not_synced (no skill_summary), 409 problem_not_cached, 403 contest_mode.
 */
async function buildChatContext(pool, opts) {
  const { userId, slug, profile, seed, config } = opts;
  const body = opts.body || {};
  const now = Number.isFinite(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
  if (!profile || !profile.skill_summary) throw new HttpError(409, 'not_synced');
  const familiesOf = (seed && seed.familiesOf) || familiesOfDefault;
  const language = profile.language === 'hinglish' ? 'hinglish' : 'english';
  const consentCode = !!Number(profile.consent_code);

  // Problem: cached row first, catalog second.
  const row = await repo.problems.get(pool, slug);
  const catalog = !row && seed && typeof seed.problemFromCatalog === 'function' ? seed.problemFromCatalog(slug) : null;
  const problem = buildProblem(row, catalog, slug, familiesOf);

  // Session (may be handed in by the caller to avoid a second lookup).
  const session = opts.session || await repo.sessions.getOrCreate(pool, userId, slug);
  const plan = resolvePlan(body.plan, session && session.plan_text, body.message);

  // Submissions here: count for the ladder, latest for the verdict.
  const here = await repo.submissions.listForSlug(pool, userId, slug);
  const latest = await repo.submissions.latestForSlug(pool, userId, slug);
  const verdict = buildVerdict(latest, now);
  const latestFailing = verdict && verdict.status_code !== 10;
  const contract = decideRung({
    requestedRung: Number.isInteger(body.requested_rung) ? body.requested_rung : null,
    planStated: !!plan,
    submissionsHere: Array.isArray(here) ? here.length : 0,
    turns: Number(session && session.turn_count) || 0,
    lastFailAgeS: latestFailing ? verdict.age_s : null,
    lastFailBucket: latestFailing ? verdict.bucket : null,
    isContest: !!body.is_contest,
    maxRungGlobal: config && Number.isFinite(config.maxRung) ? config.maxRung : undefined
  });
  if (contract.locked) throw new HttpError(403, 'contest_mode');

  // Anchors (top 3); the student's own first-AC code only with consent at rung >= 3.
  const anchorService = require('./anchorService');
  const anchorRes = await anchorService.getAnchorsForSlug(pool, userId, slug, { seed, config, now });
  const top = ((anchorRes && anchorRes.anchors) || []).slice(0, LIMITS.anchors);
  const wantCode = consentCode && contract.rung >= 3;
  let codes = new Map();
  if (wantCode) {
    const ids = top.map((a) => a.first_ac_submission_id ?? a.first_ac_id).filter((id) => id !== null && id !== undefined).map(Number);
    codes = ids.length ? await repo.submissions.codeByIds(pool, userId, ids) : new Map();
  }
  const anchors = top.map((a) => {
    const id = a.first_ac_submission_id ?? a.first_ac_id ?? null;
    return {
      slug: a.slug, title: a.title || a.slug, difficulty: a.difficulty || null, why: a.why || '', solved_on: a.solved_on || null,
      attempts_to_ac: a.attempts_to_ac ?? null, subpattern: a.subpattern || null, fine_tag: a.fine_tag || null,
      code_excerpt: wantCode && id !== null ? excerptOf(codes.get(Number(id))) : null
    };
  });
  // Titles of solved problems that were NOT offered: the guard rewrites them to "a classic problem".
  const offeredTitles = new Set(anchors.map((a) => String(a.title || '').toLowerCase()));
  const targetTitle = String(problem.title || '').toLowerCase();
  const offeredTitlesNotAllowed = [...new Set(((anchorRes && anchorRes.solved_titles) || [])
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim())
    .filter((t) => !offeredTitles.has(t.toLowerCase()) && t.toLowerCase() !== targetTitle))];

  // Habits: live, relevant, <=2, rendered in the student's language.
  const habitRows = await repo.habits.listForUser(pool, userId);
  const states = {};
  for (const h of habitRows) states[h.habit_key] = h.state;
  const targetSubIds = seed && typeof seed.subpatternsOf === 'function' ? seed.subpatternsOf(slug).map((m) => m.id) : [];
  const picked = selectRelevantHabits(habitRows.map(toDomainHabit), targetSubIds, { constraints_text: problem.constraints.join('\n'), statement_excerpt: problem.statement || '' }, { states });
  const habits = picked.map((h) => ({ id: h.id, key: h.key, tier: h.tier, statement: renderStatement(h, language, seed) }));

  const historyRows = await repo.messages.lastN(pool, session.id, LIMITS.historyN);
  const history = (historyRows || []).map((m) => ({ role: m.role, text: m.content }));

  return {
    language,
    consent_code: consentCode,
    problem,
    student: buildStudent(profile.skill_summary),
    anchors,
    habits,
    verdict,
    plan,
    current_code: clampCode(body.code),
    lang: typeof body.lang === 'string' && body.lang.trim() ? clampStr(body.lang.trim(), LIMITS.lang) : null,
    contract,
    history,
    message: clampStr(String(body.message || '').trim(), LIMITS.message),
    offered: { anchors: anchors.map((a) => a.slug), habits: habits.map((h) => h.key) },
    offered_titles_not_allowed: offeredTitlesNotAllowed,
    session: { id: session.id, turn_count: Number(session.turn_count) || 0, max_rung: Number(session.max_rung) || 0 }
  };
}

module.exports = { buildChatContext, resolvePlan, inferPlan, buildVerdict, buildProblem, buildStudent, toDomainHabit, excerptOf, clampCode, PLAN_CHIPS, PLAN_LABELS, PLAN_INFER, LIMITS };
