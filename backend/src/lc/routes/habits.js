'use strict';
const express = require('express');
const { asyncHandler, HttpError } = require('../middleware/errors');
const { toInt, isPlainObject } = require('../middleware/validate');
const repo = require('../db/repo');

const REACTIONS = new Set(['confirmed', 'dismissed']);

// POST /api/lc/habits/:id/feedback  { reaction: confirmed|dismissed }
function makeRouter(deps) {
  const { pool, limiters } = deps;
  const router = express.Router();
  const json = express.json({ limit: '256kb' });
  router.post('/habits/:id/feedback', limiters.general, json, asyncHandler(async (req, res) => {
    const userId = req.auth.user_id;
    const id = toInt(req.params.id);
    if (id === null || id < 1) throw new HttpError(400, 'invalid_habit_id');
    const reaction = isPlainObject(req.body) ? req.body.reaction : undefined;
    if (!REACTIONS.has(reaction)) throw new HttpError(400, 'invalid_reaction');
    const habit = await repo.habits.getById(pool, userId, id);
    if (!habit) throw new HttpError(404, 'habit_not_found');
    const updated = await repo.habits.setReaction(pool, userId, id, reaction);
    if (!updated) throw new HttpError(404, 'habit_not_found');
    await repo.events.skill(pool, userId, 'habit_feedback', { habit_id: id, key: habit.habit_key, reaction, tier: habit.tier, live: !!Number(habit.live), previous_state: habit.state }, null);
    res.json({ ok: true, id, key: habit.habit_key, reaction, state: reaction });
  }));
  return router;
}

module.exports = { makeRouter };
