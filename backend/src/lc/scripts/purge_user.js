#!/usr/bin/env node
'use strict';
/**
 * Delete every Recall (lc_) row for one user. The users row and the shared lc_problems cache are untouched.
 *   railway run --service anchor -- node src/lc/scripts/purge_user.js --user <user_id|email> --confirm PURGE
 *   railway run --service anchor -- node src/lc/scripts/purge_user.js --user <user_id|email> --dry-run     (counts only)
 *
 * Refuses without `--confirm PURGE` (before touching the DB). Deletes in one transaction via repo.purgeUser, so the
 * table order is the same as the DELETE /api/lc/me route by construction; prints per-table counts before, deleted,
 * and after (all must be 0). Exit codes: 0 ok, 1 failure, 2 usage / unknown user, 3 refused, 5 rows remain.
 */
require('dotenv').config();
const { getDbPool } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const repo = require('../db/repo');

// Mirrors the order in repo.purgeUser; used for the before/after counts and checked against its result at runtime.
const LC_USER_TABLES = ['lc_client_events', 'lc_chat_messages', 'lc_chat_sessions', 'lc_habits', 'lc_skill_events', 'lc_submissions', 'lc_solved', 'lc_consents', 'lc_profiles'];
const USAGE = 'usage: node src/lc/scripts/purge_user.js --user <user_id|email> (--confirm PURGE | --dry-run)';

function parseArgs(argv) {
  const out = { user: null, confirm: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') out.user = argv[++i];
    else if (a === '--confirm') out.confirm = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

async function resolveUser(db, userOrEmail) {
  const key = String(userOrEmail || '').trim(); if (!key) return null;
  const sql = key.includes('@') ? 'SELECT user_id, email FROM users WHERE email = ? LIMIT 1' : 'SELECT user_id, email FROM users WHERE user_id = ? LIMIT 1';
  const [rows] = await db.query(sql, [key]);
  return rows[0] || null;
}

// Table names come from the fixed list (plus whatever repo.purgeUser reported), never from input.
async function countRows(db, userId, tables) {
  const out = {};
  for (const t of tables) { const [rows] = await db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [userId]); out[t] = Number(rows[0] && rows[0].n) || 0; }
  return out;
}

function printCounts(title, counts) {
  console.log(title);
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(18)} ${n}`);
}
const sum = (counts) => Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.user) { console.error(USAGE); return 2; }
  if (!args.dryRun && args.confirm !== 'PURGE') { console.error('purge_user: refusing — pass `--confirm PURGE` to delete, or `--dry-run` to count only'); return 3; }

  const pool = getDbPool();
  try {
    const user = await resolveUser(pool, args.user);
    if (!user) { console.error('purge_user: no users row matches the given --user'); return 2; }
    console.log(`purge_user: user_id ${user.user_id}`);

    const before = await countRows(pool, user.user_id, LC_USER_TABLES);
    printCounts('rows before:', before);
    if (args.dryRun) { console.log(`purge_user: dry run, nothing deleted (${sum(before)} rows would be deleted)`); return 0; }

    const deleted = await withTransaction(pool, (conn) => repo.purgeUser(conn, user.user_id));
    printCounts('rows deleted:', deleted);

    const reported = Object.keys(deleted);
    const missing = LC_USER_TABLES.filter((t) => !reported.includes(t));
    const extra = reported.filter((t) => !LC_USER_TABLES.includes(t));
    if (missing.length || extra.length) console.warn(`purge_user: table list differs from repo.purgeUser (missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'}) — update LC_USER_TABLES in this script`);

    const after = await countRows(pool, user.user_id, [...new Set([...LC_USER_TABLES, ...reported])]);
    printCounts('rows after:', after);
    const remaining = sum(after);
    console.log(remaining === 0 ? 'purge_user: OK, 0 rows remain in every lc_ table (users row and lc_problems cache untouched)' : `purge_user: ${remaining} rows remain`);
    return remaining === 0 ? 0 : 5;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error('purge_user failed:', err.message); process.exit(1); });
}

module.exports = { parseArgs, resolveUser, countRows, main, LC_USER_TABLES };
