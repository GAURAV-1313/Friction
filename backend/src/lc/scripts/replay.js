#!/usr/bin/env node
'use strict';
// Determinism replay for the Recall domain layer.
//
//   node src/lc/scripts/replay.js [--fixture] [--twice] [--seed N] [--now TS] [--input file.json] [--json]
//
// Runs buildAttempts -> skillSummary -> computeHabits -> scoreAnchors (three target slugs) over the synthetic
// fixture (default, or --fixture) or over a JSON export (--input), and prints the sha256 of the sorted-key JSON
// of each output. With --twice the whole pipeline runs twice from scratch and the process exits 1 if any hash
// differs. No Date.now() anywhere: the "now" comes from the fixture (FIXTURE_NOW), --now, or the input file.
//
// --input JSON shape: { now: <unix s>, targets?: [slug], submissions: [DB-shaped rows], problems?: { slug: {title, difficulty, tags} } }
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildAttempts } = require('../domain/attempts');
const { skillSummary } = require('../domain/skill');
const { computeHabits } = require('../domain/habits');
const { scoreAnchors } = require('../domain/anchors');
const { loadSeed } = require('../domain/seed');
const { MODEL_VERSION } = require('../domain/constants');

const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'tests', 'lc', 'fixtures', 'buildFixture.js');

function parseArgs(argv) {
  const args = { fixture: false, twice: false, json: false, seed: undefined, now: undefined, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = true;
    else if (a === '--twice') args.twice = true;
    else if (a === '--json') args.json = true;
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--now') args.now = Number(argv[++i]);
    else if (a === '--input') args.input = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// JSON with recursively sorted object keys, so hashes do not depend on insertion order.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value instanceof Map) return stableStringify(Object.fromEntries(value));
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function loadSource(args) {
  if (args.input) {
    const j = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'));
    if (!Array.isArray(j.submissions)) throw new Error('--input file needs a "submissions" array');
    const now = args.now ?? j.now;
    if (!Number.isFinite(now)) throw new Error('--input file needs "now" (unix seconds) or pass --now');
    const byId = new Map(j.submissions.filter((s) => s.code !== undefined).map((s) => [Number(s.lc_submission_id ?? s.id), s.code]));
    return {
      label: `input:${path.basename(args.input)}`,
      now,
      submissions: j.submissions,
      problemsBySlug: new Map(Object.entries(j.problems || {})),
      targets: j.targets || require(FIXTURE_PATH).TARGET_SLUGS,
      seedObj: loadSeed(),
      codeLookup: (id) => byId.get(Number(id)) || null
    };
  }
  const { buildFixture, codeLookupFor, TARGET_SLUGS } = require(FIXTURE_PATH);
  const fx = buildFixture({ seed: args.seed, now: args.now });
  return { label: `fixture:seed=${fx.seed}`, now: fx.now, submissions: fx.submissions, problemsBySlug: fx.problemsBySlug, targets: TARGET_SLUGS, seedObj: fx.seedObj, codeLookup: codeLookupFor(fx.submissions) };
}

function runOnce(args) {
  const src = loadSource(args); // rebuilt from scratch on every run so --twice exercises the whole pipeline
  const attempts = buildAttempts(src.submissions, src.problemsBySlug, src.seedObj, { codeLookup: src.codeLookup });
  const skill = skillSummary(attempts, src.now);
  const habits = computeHabits({ attempts, asOf: src.now, seed: src.seedObj });
  const anchors = {};
  for (const slug of src.targets) {
    const p = src.problemsBySlug.get(slug) || src.seedObj.problemFromCatalog(slug) || { tags: [], difficulty: null };
    anchors[slug] = scoreAnchors({ target: { slug, tags: p.tags || [], difficulty: p.difficulty }, solvedAttempts: attempts, asOf: src.now, seed: src.seedObj });
  }
  const outputs = { attempts, skill, habits, anchors };
  const hashes = {};
  for (const [k, v] of Object.entries(outputs)) hashes[k] = sha256(stableStringify(v));
  hashes.all = sha256(Object.keys(hashes).sort().map((k) => `${k}=${hashes[k]}`).join('\n'));
  return { label: src.label, now: src.now, model_version: MODEL_VERSION, seed_version: src.seedObj.version, sizes: { submissions: src.submissions.length, attempts: attempts.length, habits: habits.length, anchors: Object.fromEntries(Object.entries(anchors).map(([s, r]) => [s, r.anchors.length])) }, hashes, outputs };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const first = runOnce(args);
  const report = { source: first.label, now: first.now, model_version: first.model_version, seed_version: first.seed_version, sizes: first.sizes, hashes: first.hashes };
  let ok = true;
  if (args.twice) {
    const second = runOnce(args);
    report.second = second.hashes;
    report.diff = Object.keys(first.hashes).filter((k) => first.hashes[k] !== second.hashes[k]);
    ok = report.diff.length === 0;
  }
  if (args.json) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log(`replay ${report.source} now=${report.now} model=${report.model_version} seed=${report.seed_version}`);
    console.log(`  submissions=${report.sizes.submissions} attempts=${report.sizes.attempts} habits=${report.sizes.habits} anchors=${JSON.stringify(report.sizes.anchors)}`);
    for (const k of ['attempts', 'skill', 'habits', 'anchors', 'all']) console.log(`  ${k.padEnd(9)} ${report.hashes[k]}`);
    if (args.twice) console.log(ok ? '  twice: identical (deterministic)' : `  twice: DIFFERENT in ${report.diff.join(', ')}`);
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`replay: ${e.message}`); process.exit(2); }
}

module.exports = { stableStringify, sha256, runOnce, parseArgs };
