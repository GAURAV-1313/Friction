'use strict';
const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const profileService = require('../services/profileService');

// GET /api/lc/profile, PUT /api/lc/profile, POST /api/lc/consent
function makeRouter(deps) {
  const { pool, config, limiters } = deps;
  const router = express.Router();
  const json = express.json({ limit: '256kb' });
  router.get('/profile', limiters.general, asyncHandler(async (req, res) => {
    res.json(await profileService.getProfile(pool, req.auth.user_id, { config }));
  }));
  router.put('/profile', limiters.general, json, asyncHandler(async (req, res) => {
    res.json(await profileService.putProfile(pool, req.auth.user_id, req.body, { config, now: new Date() }));
  }));
  router.post('/consent', limiters.general, json, asyncHandler(async (req, res) => {
    res.json(await profileService.recordConsent(pool, req.auth.user_id, req.body, { config }));
  }));
  return router;
}

module.exports = { makeRouter };
