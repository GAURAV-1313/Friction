'use strict';
const rl = require('express-rate-limit');
const rateLimit = typeof rl === 'function' ? rl : (rl.rateLimit || rl.default);
const ipKey = rl.ipKeyGenerator || ((ip) => ip || 'unknown');

function make(limit, code, windowMs = 60 * 1000) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => (req.auth && req.auth.user_id ? `u:${req.auth.user_id}` : `ip:${ipKey(req.ip)}`),
    validate: { keyGeneratorIpFallback: false },
    message: { error: code }
  });
}

// Fresh instances per app; never Friction's limiter objects.
function makeLimiters() {
  return {
    general: make(120, 'rate_limited'),
    chat: make(20, 'chat_rate_limited'),
    // The panel posts one chunk per LeetCode page (1 req/s during the sweep), i.e. up to ~60/min.
    sync: make(120, 'sync_rate_limited'),
    attempts: make(60, 'attempts_rate_limited'),
    events: make(30, 'events_rate_limited'),
    problems: make(60, 'problems_rate_limited')
  };
}

module.exports = { makeLimiters };
