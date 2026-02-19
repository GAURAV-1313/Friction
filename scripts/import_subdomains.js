#!/usr/bin/env node
/**
 * Import LeetCode tags into subdomains for a given domain.
 *
 * Usage:
 *   DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=... \
 *   DSA_DOMAIN_ID=... node scripts/import_subdomains.js
 *
 * Input:
 *   data/leetcode_tags.json
 */

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const {
  DB_HOST,
  DB_PORT = "3306",
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DSA_DOMAIN_ID
} = process.env;

if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME || !DSA_DOMAIN_ID) {
  console.error(
    "Missing env. Required: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DSA_DOMAIN_ID"
  );
  process.exit(1);
}

const inputPath = path.join(process.cwd(), "data", "leetcode_tags.json");
if (!fs.existsSync(inputPath)) {
  console.error("Missing data/leetcode_tags.json. Run scripts/leetcode_tags.js first.");
  process.exit(1);
}

const tags = JSON.parse(fs.readFileSync(inputPath, "utf-8"));

async function main() {
  const pool = await mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 5
  });

  let inserted = 0;
  for (const tag of tags) {
    if (!tag?.name || !tag?.slug) continue;
    const count = Number(tag.count) || 0;
    const sql = `
      INSERT INTO subdomains (subdomain_id, domain_id, name, slug, count_source)
      VALUES (UUID(), ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE count_source = VALUES(count_source), name = VALUES(name)
    `;
    await pool.execute(sql, [DSA_DOMAIN_ID, tag.name, tag.slug, count]);
    inserted += 1;
  }

  await pool.end();
  console.log(`Imported ${inserted} subdomains into domain ${DSA_DOMAIN_ID}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
