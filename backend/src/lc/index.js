'use strict';
require('dotenv').config();
const { createLcApp } = require('./app');
const { loadConfig } = require('./config');
const { waitForDb } = require('../db/pool');

const config = loadConfig(process.env);
if (!process.env.JWT_SECRET) console.warn(JSON.stringify({ evt: 'lc.boot.warn', msg: 'JWT_SECRET is not set; every request will be 401' }));
const app = createLcApp({ config });
const server = app.listen(config.port, () => {
  console.log(JSON.stringify({ evt: 'lc.boot', msg: `anchor listening on ${config.port}`, provider: config.provider, kill: { llm: config.killLlm, sync: config.killSync } }));
  waitForDb().catch(() => {});
});
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
