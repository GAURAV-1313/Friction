'use strict';
/**
 * chatService: one hint per call. Validate → profile → contest lock → session → ctx → daily cap →
 * LLM (guarded, one retry) or template → persist both rows in one transaction.
 * Never logs or persists body.code, prompts, or replies.
 *
 * Parallel modules (promptBuilder, guard, fallback, llm) are required lazily so tests can jest.mock them.
 */
const repo = require('../db/repo');
const { withTransaction } = require('../../db/transaction');
const { HttpError } = require('../middleware/errors');
const { isSlug, isPlainObject, clampStr } = require('../middleware/validate');
const { decideRung } = require('../domain/policy');
const { buildChatContext } = require('./contextBuilder');

const MESSAGE_MAX = 2000;
const NOTE_MAX = 500;
const FEEDBACK_THUMBS = new Set(['up', 'down']);
const FEEDBACK_REASONS = new Set(['helped', 'too_much', 'too_little', 'wrong']);

const bad = (field) => new HttpError(400, 'bad_request', { field });

function validateChatBody(body) {
  if (!isPlainObject(body)) throw bad('body');
  if (!isSlug(body.title_slug)) throw bad('title_slug');
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > MESSAGE_MAX) throw bad('message');
  if (body.requested_rung !== undefined && body.requested_rung !== null && !(Number.isInteger(body.requested_rung) && body.requested_rung >= 1 && body.requested_rung <= 4)) throw bad('requested_rung');
  for (const k of ['plan', 'code', 'lang']) if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') throw bad(k);
}

function isLlmError(err) {
  if (!err) return false;
  try { const { LlmError } = require('./llm'); if (LlmError && err instanceof LlmError) return true; } catch (_) { /* provider module absent: fall through */ }
  return err.name === 'LlmError';
}

function replyText(g) {
  if (!g) return '';
  if (typeof g.reply === 'string') return g.reply;
  if (g.reply && typeof g.reply.reply === 'string') return g.reply.reply;
  return '';
}

function sumUsage(a, b) {
  if (!a && !b) return null;
  const n = (x, k) => Number((x && x[k]) || 0);
  return {
    input_tokens: n(a, 'input_tokens') + n(b, 'input_tokens'),
    output_tokens: n(a, 'output_tokens') + n(b, 'output_tokens'),
    total_tokens: n(a, 'total_tokens') + n(b, 'total_tokens'),
    calls: (a ? 1 : 0) + (b ? 1 : 0)
  };
}

/**
 * produceReply(llm, config, ctx) -> { text, anchors_used, habits_used, usage, provider, model, degraded, latency_ms, guard }
 * guard = { action: 'accept'|'accept_flagged'|'fallback', retried, violations[], reason? }
 */
async function produceReply(llm, config, ctx) {
  const { templatedReply } = require('../domain/fallback');
  const fallback = (reason, extra = {}) => {
    const t = templatedReply(ctx) || {};
    return {
      text: typeof t.reply === 'string' ? t.reply : '',
      anchors_used: Array.isArray(t.anchors_used) ? t.anchors_used : [],
      habits_used: Array.isArray(t.habits_used) ? t.habits_used : [],
      usage: extra.usage || null, provider: 'template', model: null, degraded: true, latency_ms: extra.latency_ms || 0,
      guard: { action: 'fallback', retried: !!extra.retried, violations: extra.violations || [], reason }
    };
  };
  if (config && config.killLlm) return fallback('kill_switch');
  if (!llm || typeof llm.generate !== 'function') return fallback('no_llm');

  const { buildPrompt } = require('../domain/promptBuilder');
  const { guardReply } = require('../domain/guard');
  const prompt = buildPrompt(ctx);
  const errCode = (err) => (isLlmError(err) ? `llm_${err.code || 'error'}` : 'llm_unexpected');
  const logErr = (err, pass) => console.error(JSON.stringify({ evt: 'lc.llm.error', pass, code: err && err.code, name: err && err.name, msg: err && err.message ? String(err.message).slice(0, 200) : String(err) }));

  let r1;
  try { r1 = await llm.generate(prompt); } catch (err) { logErr(err, 1); return fallback(errCode(err)); }
  const g1 = guardReply(r1.parsed, ctx, { pass: 1 });
  const base = { provider: r1.provider || llm.provider || (config && config.provider) || null, model: r1.model || llm.model || null };
  if (g1.action === 'fallback') return fallback('guard', { violations: g1.violations || [], usage: sumUsage(r1.usage, null), latency_ms: r1.latency_ms || 0 });
  if (g1.action !== 'retry') {
    const text = replyText(g1);
    if (!text.trim()) return fallback('empty_reply', { violations: g1.violations || [], usage: sumUsage(r1.usage, null), latency_ms: r1.latency_ms || 0 });
    return { text, anchors_used: g1.anchors_used || [], habits_used: g1.habits_used || [], usage: sumUsage(r1.usage, null), ...base, degraded: false, latency_ms: r1.latency_ms || 0, guard: { action: 'accept', retried: false, violations: g1.violations || [] } };
  }

  // One re-ask with the violation list, then accept-and-flag. Violations may be strings or {rule, detail}.
  const describe = (v) => (typeof v === 'string' ? v : (v && (v.detail || v.rule)) || JSON.stringify(v));
  const instructions = g1.retry_instructions || (g1.violations || []).map(describe).join('; ');
  const revised = { system: prompt.system, history: prompt.history, user: `${prompt.user}\n\nREVISION REQUIRED: ${instructions}` };
  let r2;
  try { r2 = await llm.generate(revised); } catch (err) { logErr(err, 2); return fallback(errCode(err), { retried: true, violations: g1.violations || [], usage: sumUsage(r1.usage, null), latency_ms: r1.latency_ms || 0 }); }
  const g2 = guardReply(r2.parsed, ctx, { pass: 2 });
  const usage = sumUsage(r1.usage, r2.usage);
  const latency = (r1.latency_ms || 0) + (r2.latency_ms || 0);
  const violations = [...(g1.violations || []), ...(g2.violations || [])];
  if (g2.action === 'fallback') return fallback('guard', { retried: true, violations, usage, latency_ms: latency });
  const text = replyText(g2);
  if (!text.trim()) return fallback('empty_reply', { retried: true, violations, usage, latency_ms: latency });
  return {
    text, anchors_used: g2.anchors_used || [], habits_used: g2.habits_used || [], usage, ...base, degraded: false, latency_ms: latency,
    // The real guard returns action 'accept' on pass 2 and marks retry-class violations with action 'flag'.
    guard: { action: (g2.action !== 'accept' || (g2.violations || []).some((v) => v && v.action === 'flag')) ? 'accept_flagged' : 'accept', retried: true, violations, pass2_violations: g2.violations || [] }
  };
}

/**
 * handleChat(pool, llm, config, userId, body, { seed, now }) ->
 *   { message_id, reply, rung, anchors:[{slug,title,why}], habits_shown:[{id,key,statement}], allowed_rung_next, unlock_reason, degraded, provider }
 */
async function handleChat(pool, llm, config, userId, body, opts = {}) {
  validateChatBody(body);
  const slug = body.title_slug;
  const now = Number.isFinite(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
  const seed = opts.seed || require('../domain/seed').loadSeed();

  const profile = await repo.profiles.get(pool, userId);
  if (!profile || !profile.skill_summary) throw new HttpError(409, 'not_synced');
  if (decideRung({ isContest: !!body.is_contest }).locked) throw new HttpError(403, 'contest_mode');

  const session = await repo.sessions.getOrCreate(pool, userId, slug);
  const ctx = await buildChatContext(pool, { userId, slug, body, profile, session, seed, config, now });

  const cap = config && Number.isFinite(config.dailyHintCap) ? config.dailyHintCap : 60;
  const allowed = await repo.profiles.incrementHintsAtomic(pool, userId, cap);
  if (!allowed) throw new HttpError(429, 'daily_cap', { cap });

  const out = await produceReply(llm, config, ctx);
  const rung = ctx.contract.rung;
  const offeredAnchors = new Set(ctx.offered.anchors);
  const offeredHabits = new Set(ctx.offered.habits);
  const anchorsUsed = (out.anchors_used || []).filter((s) => offeredAnchors.has(s));
  const habitsUsed = (out.habits_used || []).filter((k) => offeredHabits.has(k));

  // Persisted anchors carry no code excerpt; the user row carries only the message text.
  const anchorsRow = ctx.anchors.map((a) => ({ slug: a.slug, title: a.title, why: a.why, solved_on: a.solved_on, cited: anchorsUsed.includes(a.slug) }));
  const habitsRow = ctx.habits.map((h) => ({ id: h.id, key: h.key, tier: h.tier, statement: h.statement, used: habitsUsed.includes(h.key) }));
  const sessionUpdate = { turn_count: ctx.session.turn_count + 1, max_rung: Math.max(ctx.session.max_rung, rung) };
  // Branch 1 is today's explicit-plan path, untouched. Branch 2 persists an INFERRED plan exactly once,
  // so a later thin message ("and then?") cannot re-lock rung 2 under the student mid-conversation.
  const storedPlan = (session && session.plan_text) || null;
  if (body.plan !== undefined || (ctx.plan && !storedPlan)) sessionUpdate.plan_text = ctx.plan;
  // Logging only (no schema change): plan_source is the only way to tell whether plan inference is
  // being gamed; rung4_path says the request came from the written-diagnosis gate, the panel's only source of 4.
  const planSource = !ctx.plan ? null : ((body.plan !== undefined && body.plan !== null) ? 'chip' : (storedPlan ? 'session' : 'inferred'));
  const rung4Path = body.requested_rung === 4 ? 'gate_form' : null;

  const messageId = await withTransaction(pool, async (conn) => {
    await repo.messages.insert(conn, { session_id: ctx.session.id, user_id: userId, role: 'user', content: ctx.message, contract: ctx.contract });
    const id = await repo.messages.insert(conn, {
      session_id: ctx.session.id, user_id: userId, role: 'assistant', content: out.text, rung,
      anchors: anchorsRow, habits: habitsRow, contract: ctx.contract, usage: out.usage ? { ...out.usage, latency_ms: out.latency_ms || 0 } : null, guard: out.guard,
      provider: out.provider, model: out.model, degraded: out.degraded
    });
    await repo.sessions.update(conn, ctx.session.id, sessionUpdate);
    return id;
  });

  console.log(JSON.stringify({ evt: 'lc.chat', u: String(userId).slice(0, 8), slug, rung, plan_source: planSource, rung4_path: rung4Path, provider: out.provider, degraded: out.degraded, retried: out.guard.retried, violations: out.guard.violations.length, ms: out.latency_ms }));

  return {
    message_id: messageId,
    reply: out.text,
    rung,
    anchors: ctx.anchors.map((a) => ({ slug: a.slug, title: a.title, why: a.why })),
    habits_shown: ctx.habits.map((h) => ({ id: h.id, key: h.key, statement: h.statement })),
    allowed_rung_next: ctx.contract.allowed_rung_next,
    unlock_reason: ctx.contract.unlock_reason,
    degraded: out.degraded,
    provider: out.provider
  };
}

// Read-only session lookup (repo only exposes getOrCreate; history must not create sessions).
async function findSession(db, userId, slug) {
  const [rows] = await db.query('SELECT id, slug, plan_text, turn_count, max_rung FROM lc_chat_sessions WHERE user_id = ? AND slug = ?', [userId, slug]);
  return rows && rows.length ? rows[0] : null;
}

/** getChatHistory(pool, userId, slug) -> { session: {id, turn_count, plan_text, max_rung}|null, messages[] } */
async function getChatHistory(pool, userId, slug) {
  if (!isSlug(slug)) throw bad('slug');
  const s = await findSession(pool, userId, slug);
  if (!s) return { session: null, messages: [] };
  const messages = await repo.messages.listForSession(pool, s.id, 50);
  return { session: { id: s.id, turn_count: Number(s.turn_count) || 0, plan_text: s.plan_text || null, max_rung: Number(s.max_rung) || 0 }, messages };
}

/** setMessageFeedback(pool, userId, id, { thumb, reason?, note? }) -> { ok: true } | 404 message_not_found */
async function setMessageFeedback(pool, userId, id, body) {
  if (typeof id !== 'string' || !id || id.length > 36) throw bad('id');
  if (!isPlainObject(body)) throw bad('body');
  if (!FEEDBACK_THUMBS.has(body.thumb)) throw bad('thumb');
  if (body.reason !== undefined && body.reason !== null && !FEEDBACK_REASONS.has(body.reason)) throw bad('reason');
  if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > NOTE_MAX)) throw bad('note');
  const ok = await repo.messages.setFeedback(pool, userId, id, { thumb: body.thumb, reason: body.reason || null, note: body.note ? clampStr(body.note, NOTE_MAX) : null });
  if (!ok) throw new HttpError(404, 'message_not_found');
  return { ok: true };
}

module.exports = { handleChat, getChatHistory, setMessageFeedback, produceReply, validateChatBody };
