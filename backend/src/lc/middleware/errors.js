'use strict';
class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra || null; }
}
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...(err.extra || {}) });
  console.error(JSON.stringify({ evt: 'lc.error', path: req.path, msg: err && err.message ? err.message : String(err) }));
  return res.status(500).json({ error: 'internal_error' });
}

module.exports = { HttpError, asyncHandler, errorHandler };
