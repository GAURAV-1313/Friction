'use strict';
const express = require('express');
const cors = require('cors');
const { getDbPool } = require('../db/pool');
const { loadConfig } = require('./config');
const { buildAllowlist, lcCorsOptions, rejectDisallowedOrigin } = require('./cors');
const { errorHandler } = require('./middleware/errors');
const { makeLimiters } = require('./middleware/limiters');
const { loadSeed } = require('./domain/seed');
const { mountLcRoutes } = require('./routes');

function requestLogger(req, res, next) {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path === '/health') return;
    console.log(JSON.stringify({ evt: 'lc.req', m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t0, u: req.auth && req.auth.user_id ? req.auth.user_id.slice(0, 8) : undefined }));
  });
  next();
}

// Never calls Friction's createApp(): that would start the snapshot cron.
function createLcApp({ pool, llm, config, seed } = {}) {
  const cfg = config || loadConfig(process.env);
  const db = pool || getDbPool();
  let llmClient = llm;
  if (!llmClient) { try { llmClient = require('./services/llm').createLlmClient(cfg); } catch (err) { console.warn(JSON.stringify({ evt: 'lc.llm.unavailable', msg: err.message })); llmClient = null; } }
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const allowlist = buildAllowlist(cfg);
  app.use(cors(lcCorsOptions(allowlist)));
  app.use(rejectDisallowedOrigin(allowlist));
  app.use(requestLogger);
  app.get('/', (req, res) => res.json({ status: 'ok', service: 'recall' }));
  mountLcRoutes(app, { pool: db, llm: llmClient, config: cfg, seed: seed || loadSeed(), limiters: makeLimiters() });
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}

module.exports = { createLcApp };
