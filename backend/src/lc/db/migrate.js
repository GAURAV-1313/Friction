#!/usr/bin/env node
'use strict';
/**
 * Apply db/012_lc_init.sql (or roll it back) against the configured DB.
 *   node src/lc/db/migrate.js [--dry-run] [--down --confirm DROP_LC_TABLES]
 * Preflight: users.user_id collation must match the header pragma in the SQL file.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDbPool } = require('../../db/pool');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const UP = path.join(ROOT, 'db', '012_lc_init.sql');
const DOWN = path.join(ROOT, 'db', '012_lc_init.down.sql');
const NAME = '012_lc_init';
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const down = args.includes('--down');

function splitStatements(sql) {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const pool = getDbPool();
  const sql = fs.readFileSync(down ? DOWN : UP, 'utf8');
  const expect = (fs.readFileSync(UP, 'utf8').match(/lc:expect-users-collation\s+(\S+)/) || [])[1];
  const [[ver]] = await pool.query('SELECT @@version AS v, @@collation_database AS c');
  // Authoritative: information_schema reports the effective collation even when SHOW CREATE TABLE prints none.
  const [[col]] = await pool.query("SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id'");
  const colColl = (col && col.c) || ver.c;
  console.log(`server ${ver.v}; db default ${ver.c}; users.user_id collation ${colColl}; expected ${expect}`);
  if (expect && colColl !== expect) { console.error(`ABORT: users.user_id collation ${colColl} != ${expect}. Edit the COLLATE clauses in db/012_lc_init.sql to match, then rerun.`); process.exit(2); }
  const statements = splitStatements(sql);
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  if (down) {
    if (!args.includes('--confirm') || args[args.indexOf('--confirm') + 1] !== 'DROP_LC_TABLES') { console.error('refusing: --down needs --confirm DROP_LC_TABLES'); process.exit(3); }
  } else {
    try {
      const [applied] = await pool.query('SELECT checksum FROM lc_schema_migrations WHERE name = ?', [NAME]);
      if (applied.length && applied[0].checksum === checksum) { console.log('already applied with the same checksum; nothing to do'); process.exit(0); }
      if (applied.length) { console.error('ABORT: migration already applied with a different checksum; write a new migration instead'); process.exit(4); }
    } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
  }
  console.log(`${dry ? 'DRY RUN: would apply' : 'applying'} ${statements.length} statements from ${path.basename(down ? DOWN : UP)}`);
  if (dry) { statements.forEach((s, i) => console.log(`  ${i + 1}. ${s.split('\n')[0].slice(0, 90)}`)); process.exit(0); }
  for (const s of statements) await pool.query(s);
  if (!down) await pool.query('INSERT INTO lc_schema_migrations (name, checksum, applied_by, server_version) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), applied_at = CURRENT_TIMESTAMP', [NAME, checksum, process.env.USER || 'unknown', ver.v]);
  console.log('done');
  process.exit(0);
}

main().catch((err) => { console.error('migration failed:', err.message); process.exit(1); });
