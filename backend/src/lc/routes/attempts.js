'use strict';
const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const attemptService = require('../services/attemptService');

// POST /api/lc/attempts  (60/min, 2 MB; code stored only with consent)
function makeRouter(deps) {
  const { pool, config, seed, limiters } = deps;
  const router = express.Router();
  const json = express.json({ limit: '2mb' });
  router.post('/attempts', limiters.attempts, json, asyncHandler(async (req, res) => {
    res.json(await attemptService.recordAttempt(pool, req.auth.user_id, req.body, { seed, config, now: new Date() }));
  }));
  return router;
}

module.exports = { makeRouter };
