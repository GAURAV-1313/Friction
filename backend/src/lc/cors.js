'use strict';
// Same origin rule as backend/src/app.js, but a rejected origin gets 403, never a 500.
function normalizeOrigin(value) { if (!value) return null; try { return new URL(value).origin; } catch (_) { return null; } }

function buildAllowlist(cfg) {
  const defaults = ['http://localhost:3000', 'http://localhost:4000', 'http://localhost:4100'];
  const web = normalizeOrigin(cfg.webAppUrl);
  return Array.from(new Set([...defaults, ...(cfg.corsOrigins || []), ...(web ? [web] : [])]));
}

function isAllowedOrigin(origin, allowlist) {
  if (!origin) return true;
  if (allowlist.includes(origin)) return true;
  if (origin.startsWith('chrome-extension://')) return true;
  return false;
}

function lcCorsOptions(allowlist) {
  return {
    origin(origin, callback) { callback(null, isAllowedOrigin(origin, allowlist)); },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Anchor-Version']
  };
}

function rejectDisallowedOrigin(allowlist) {
  return function (req, res, next) {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, allowlist)) return res.status(403).json({ error: 'origin_not_allowed' });
    return next();
  };
}

module.exports = { buildAllowlist, isAllowedOrigin, lcCorsOptions, rejectDisallowedOrigin };
