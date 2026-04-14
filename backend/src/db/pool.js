const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

let pool;

function initDbPool() {
  if (pool) return pool;

  dotenv.config();

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 10,
    charset: 'utf8mb4_unicode_ci',
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 30000),
    enableKeepAlive: true,
    keepAliveInitialDelay: Number(process.env.DB_KEEPALIVE_MS || 10000)
  });

  return pool;
}

async function waitForDb(maxRetries = 10, intervalMs = 3000) {
  const p = initDbPool();
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const conn = await p.getConnection();
      await conn.ping();
      conn.release();
      // eslint-disable-next-line no-console
      console.log('DB connected');
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`DB not ready (attempt ${i}/${maxRetries}): ${err.code || err.message}`);
      if (i < maxRetries) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }
  // eslint-disable-next-line no-console
  console.error('DB failed to connect after all retries — continuing anyway');
}

function getDbPool() {
  if (!pool) {
    return initDbPool();
  }
  return pool;
}

module.exports = { initDbPool, getDbPool, waitForDb };
