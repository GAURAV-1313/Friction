'use strict';
/**
 * Chat routes (mounted under /api/lc behind requireAuth + pilot allowlist).
 *   POST /chat                        (chat limiter, json 256kb) -> chatService.handleChat
 *   GET  /chat/:slug/history          -> { session|null, messages }
 *   POST /chat/messages/:id/feedback  { thumb, reason?, note? } -> { ok } | 404 message_not_found
 */
const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const chatService = require('../services/chatService');

const passthrough = (req, res, next) => next();

function makeRouter(deps = {}) {
  const { pool, llm, config, seed, limiters } = deps;
  const chatLimiter = (limiters && limiters.chat) || passthrough;
  const generalLimiter = (limiters && limiters.general) || passthrough;
  const router = express.Router();

  router.post('/chat', chatLimiter, express.json({ limit: '256kb' }), asyncHandler(async (req, res) => {
    const out = await chatService.handleChat(pool, llm, config, req.auth.user_id, req.body, { seed });
    res.json(out);
  }));

  router.get('/chat/:slug/history', generalLimiter, asyncHandler(async (req, res) => {
    res.json(await chatService.getChatHistory(pool, req.auth.user_id, req.params.slug));
  }));

  router.post('/chat/messages/:id/feedback', generalLimiter, express.json({ limit: '16kb' }), asyncHandler(async (req, res) => {
    res.json(await chatService.setMessageFeedback(pool, req.auth.user_id, req.params.id, req.body));
  }));

  return router;
}

module.exports = { makeRouter };
