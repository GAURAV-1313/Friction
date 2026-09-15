'use strict';
const express = require('express');
const pkg = require('../../../package.json');

function makeHealthRouter({ pool, config, llmProvider }) {
  const router = express.Router();
  let probe = { db: 'unknown', at: 0 };
  async function probeDb() {
    if (Date.now() - probe.at < 30000) return probe.db;
    try { await pool.query('SELECT 1'); probe = { db: 'ok', at: Date.now() }; } catch (_) { probe = { db: 'error', at: Date.now() }; }
    return probe.db;
  }
  router.get('/health', (req, res) => {
    probeDb().catch(() => {});
    res.json({
      status: 'ok', service: 'recall', version: `${pkg.version}+${config.commitSha || 'dev'}`, uptime_s: Math.round(process.uptime()),
      provider: llmProvider || config.provider, kill: { llm: config.killLlm, sync: config.killSync },
      min_extension_version: config.minExtensionVersion, db: probe.db, migration: '012_lc_init'
    });
  });
  router.get('/health/ready', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); } catch (_) { res.status(500).json({ error: 'db_unavailable' }); }
  });
  return router;
}

module.exports = { makeHealthRouter };
