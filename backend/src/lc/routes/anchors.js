'use strict';
const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const anchorService = require('../services/anchorService');

// GET /api/lc/anchors/:slug
function makeRouter(deps) {
  const { pool, config, seed, limiters } = deps;
  const router = express.Router();
  router.get('/anchors/:slug', limiters.general, asyncHandler(async (req, res) => {
    res.json(await anchorService.getAnchorsForSlug(pool, req.auth.user_id, req.params.slug, { seed, config, now: Math.floor(Date.now() / 1000) }));
  }));
  return router;
}

module.exports = { makeRouter };
