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
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 10000),
    enableKeepAlive: true,
    keepAliveInitialDelay: Number(process.env.DB_KEEPALIVE_MS || 0)
  });

  return pool;
}

function getDbPool() {
  if (!pool) {
    return initDbPool();
  }
  return pool;
}

module.exports = { initDbPool, getDbPool };
