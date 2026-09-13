'use strict';
// The tutor's structured reply. Shared by both providers, the guard, and the tests.
const REPLY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'the hint shown to the student' },
    rung: { type: 'integer', description: 'the rung actually used, 1-4' },
    anchors_used: { type: 'array', items: { type: 'string' }, description: 'slugs of offered anchors cited in the reply' },
    habits_used: { type: 'array', items: { type: 'string' }, description: 'keys of offered habits used to sharpen the reply' },
    asks_question: { type: 'boolean' },
    self_check: { type: 'string', description: 'one line: what you believe the next step or bug is' }
  },
  required: ['reply', 'rung', 'anchors_used', 'habits_used', 'asks_question', 'self_check'],
  additionalProperties: false
};

// Gemini's responseSchema (OpenAPI subset: no additionalProperties).
const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' }, rung: { type: 'integer' }, anchors_used: { type: 'array', items: { type: 'string' } },
    habits_used: { type: 'array', items: { type: 'string' } }, asks_question: { type: 'boolean' }, self_check: { type: 'string' }
  },
  required: ['reply', 'rung', 'anchors_used', 'habits_used', 'asks_question', 'self_check']
};

function validateReply(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['not_an_object'] };
  if (typeof obj.reply !== 'string' || !obj.reply.trim()) errors.push('reply');
  if (typeof obj.reply === 'string' && obj.reply.length > 4000) errors.push('reply_too_long');
  if (!Number.isInteger(obj.rung) || obj.rung < 1 || obj.rung > 4) errors.push('rung');
  for (const k of ['anchors_used', 'habits_used']) if (!Array.isArray(obj[k]) || obj[k].some((x) => typeof x !== 'string')) errors.push(k);
  if (typeof obj.asks_question !== 'boolean') errors.push('asks_question');
  if (typeof obj.self_check !== 'string') errors.push('self_check');
  return { ok: errors.length === 0, errors };
}

module.exports = { REPLY_JSON_SCHEMA, GEMINI_RESPONSE_SCHEMA, validateReply };
