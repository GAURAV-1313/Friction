'use strict';
const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const problemService = require('../services/problemService');

// PUT /api/lc/problems/:slug  (60/min, 2 MB; HTML stripped and clamped server-side)
function makeRouter(deps) {
  const { pool, seed, limiters } = deps;
  const router = express.Router();
  const json = express.json({ limit: '2mb' });
  router.put('/problems/:slug', limiters.problems, json, asyncHandler(async (req, res) => {
    res.json(await problemService.upsertProblem(pool, req.auth.user_id, req.params.slug, req.body, { seed }));
  }));
  return router;
}

module.exports = { makeRouter };
