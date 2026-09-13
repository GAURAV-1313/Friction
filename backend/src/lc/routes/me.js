'use strict';
const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const profileService = require('../services/profileService');

// GET /api/lc/me, DELETE /api/lc/me
function makeRouter(deps) {
  const { pool, config, seed, limiters } = deps;
  const router = express.Router();
  router.get('/me', limiters.general, asyncHandler(async (req, res) => {
    res.json(await profileService.getMe(pool, req.auth.user_id, { seed, config, auth: req.auth, now: new Date() }));
  }));
  router.delete('/me', limiters.general, asyncHandler(async (req, res) => {
    res.json(await profileService.deleteMe(pool, req.auth.user_id));
  }));
  return router;
}

module.exports = { makeRouter };
