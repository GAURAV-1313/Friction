#!/usr/bin/env node
'use strict';
/**
 * build-dev.js: copies extension-leetcode/ (minus dev/) to extension-leetcode/dev/build/ and adjusts it for
 * the offline fixture:
 *   manifest.json  content_scripts[].matches += http://localhost:4173/*
 *                  host_permissions        += http://localhost:4173/*, http://localhost:4100/*
 *   config.js      const ENV = 'local'
 * Load dev/build/ unpacked on chrome://extensions. No dependencies (fs, path only).
 *
 *   node extension-leetcode/dev/build-dev.js [--out <dir>] [--fixture http://localhost:4173] [--api http://localhost:4100]
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function flag(name, def) { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; }
const OUT = path.resolve(flag('out', path.join(__dirname, 'build')));
const FIXTURE_ORIGIN = flag('fixture', 'http://localhost:4173').replace(/\/+$/, '');
const API_ORIGIN = flag('api', 'http://localhost:4100').replace(/\/+$/, '');
const FIXTURE_MATCH = `${FIXTURE_ORIGIN}/*`;
const API_MATCH = `${API_ORIGIN}/*`;
const EXCLUDE_TOP = new Set(['dev', 'node_modules', '.git']);

if (OUT === SRC || SRC.startsWith(OUT + path.sep)) { console.error('refusing to build into the source tree'); process.exit(2); }
if (!fs.existsSync(path.join(SRC, 'manifest.json'))) { console.error(`no manifest.json in ${SRC}`); process.exit(2); }

// fs.cpSync refuses a destination inside the source tree, so copy by hand.
function copyTree(srcDir, dstDir, depth) {
  fs.mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (depth === 0 && EXCLUDE_TOP.has(entry.name)) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(dstDir, entry.name);
    if (entry.isDirectory()) count += copyTree(from, to, depth + 1);
    else if (entry.isFile()) { fs.copyFileSync(from, to); count++; }
  }
  return count;
}

function addUnique(list, ...values) {
  const out = Array.isArray(list) ? list.slice() : [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const copied = copyTree(SRC, OUT, 0);

  // manifest.json
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = addUnique(manifest.host_permissions, FIXTURE_MATCH, API_MATCH);
  for (const cs of manifest.content_scripts || []) cs.matches = addUnique(cs.matches, FIXTURE_MATCH);
  manifest.name = `${manifest.name} (dev)`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // config.js ENV
  const configPath = path.join(OUT, 'config.js');
  const config = fs.readFileSync(configPath, 'utf8');
  const re = /^const ENV = '([^']*)';/m;
  const m = re.exec(config);
  if (!m) { console.error('config.js: could not find `const ENV = \'...\';`'); process.exit(2); }
  let next = config.replace(re, "const ENV = 'local';");
  // point the local API at --api when it differs from the default
  next = next.replace(/(local:\s*\{\s*API_BASE:\s*')[^']*(')/, `$1${API_ORIGIN}$2`);
  fs.writeFileSync(configPath, next);

  // summary
  console.log(`[build-dev] ${copied} files -> ${OUT}`);
  console.log(`[build-dev] manifest: name "${manifest.name}", version ${manifest.version}`);
  console.log(`[build-dev] host_permissions: ${manifest.host_permissions.join(', ')}`);
  for (const cs of manifest.content_scripts || []) console.log(`[build-dev] content_scripts (${cs.world || 'ISOLATED'}): ${cs.matches.join(', ')} -> ${cs.js.join(', ')}`);
  console.log(`[build-dev] config.js ENV: '${m[1]}' -> 'local' (API_BASE ${API_ORIGIN})`);
  console.log('[build-dev] load unpacked: chrome://extensions -> Developer mode -> Load unpacked -> ' + OUT);
}

main();
