'use strict';
const express = require('express');
const { asyncHandler, HttpError } = require('../middleware/errors');
const { clampStr, isPlainObject } = require('../middleware/validate');
const repo = require('../db/repo');

const TYPE_RE = /^[A-Za-z0-9_.:-]{1,48}$/;
const PAYLOAD_MAX_BYTES = 4096;

// POST /api/lc/client-events  { type, ext_version?, payload? }  -> 202 (30/min). Stored, never logged.
function makeRouter(deps) {
  const { pool, limiters } = deps;
  const router = express.Router();
  const json = express.json({ limit: '256kb' });
  router.post('/client-events', limiters.events, json, asyncHandler(async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    if (!TYPE_RE.test(type)) throw new HttpError(400, 'invalid_type');
    const payload = body.payload === undefined || body.payload === null ? null : body.payload;
    if (payload !== null && !isPlainObject(payload)) throw new HttpError(400, 'invalid_payload');
    if (payload !== null && Buffer.byteLength(JSON.stringify(payload), 'utf8') > PAYLOAD_MAX_BYTES) throw new HttpError(400, 'payload_too_large', { max_bytes: PAYLOAD_MAX_BYTES });
    const extVersion = typeof body.ext_version === 'string' && body.ext_version.trim() ? clampStr(body.ext_version.trim(), 20) : null;
    await repo.events.client(pool, req.auth.user_id, type, payload, extVersion);
    res.status(202).json({ accepted: true });
  }));
  return router;
}

module.exports = { makeRouter };
