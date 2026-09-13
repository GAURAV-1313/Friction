'use strict';
const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const syncService = require('../services/syncService');

// POST /api/lc/sync  { sync_id, phase: solved|submissions|finalize, ... }  (30/min, 2 MB)
function makeRouter(deps) {
  const { pool, config, seed, limiters } = deps;
  const router = express.Router();
  const json = express.json({ limit: '2mb' });
  router.post('/sync', limiters.sync, json, asyncHandler(async (req, res) => {
    res.json(await syncService.ingestSync(pool, req.auth.user_id, req.body, { seed, config, now: new Date() }));
  }));
  return router;
}

module.exports = { makeRouter };
