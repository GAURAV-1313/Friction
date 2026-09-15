#!/usr/bin/env node
'use strict';
/**
 * Concurrency smoke test against a running Recall deployment (plan check 5: Aiven connections under load).
 *   node src/lc/scripts/load_smoke.js --url https://<railway-domain> --token <jwt> [--concurrency 30] [--seconds 60] [--path /api/lc/me] [--timeout-ms 15000] [--no-db-probe]
 *   (--url / --token also read LC_SMOKE_URL / LC_SMOKE_TOKEN from the environment)
 *
 * Hits GET <url><path> with `concurrency` workers for `seconds` and prints the request count, error counts by
 * status, network/timeout errors and p50/p95/p99 latency. When DB_* env is present (e.g. under `railway run`) it
 * also samples `Threads_connected` against `max_connections` every 2 s during the run and prints the peak.
 * Exit 1 if any 5xx was seen, 2 if no request got a 2xx (all timeouts / network errors / 401s). The token is never printed.
 */
require('dotenv').config();

const USAGE = 'usage: node src/lc/scripts/load_smoke.js --url <base> --token <jwt> [--concurrency 30] [--seconds 60] [--path /api/lc/me] [--timeout-ms 15000] [--no-db-probe]';
const PROBE_INTERVAL_MS = 2000;

function parseArgs(argv, env = process.env) {
  const out = { url: env.LC_SMOKE_URL || null, token: env.LC_SMOKE_TOKEN || null, concurrency: 30, seconds: 60, path: '/api/lc/me', timeoutMs: 15000, dbProbe: Boolean(env.DB_HOST), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--path') out.path = argv[++i];
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--no-db-probe') out.dbProbe = false;
    else if (a === '--db-probe') out.dbProbe = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = 30;
  if (!Number.isFinite(out.seconds) || out.seconds <= 0) out.seconds = 60;
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) out.timeoutMs = 15000;
  if (typeof out.path !== 'string' || !out.path) out.path = '/api/lc/me';
  return out;
}

function percentile(values, p) {
  const s = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

function targetUrl(base, p) { return `${String(base).replace(/\/+$/, '')}${p.startsWith('/') ? p : `/${p}`}`; }

function summarize(samples, elapsedMs) {
  const latencies = samples.map((s) => s.ms);
  const errorsByStatus = {}; let ok = 0; let network = 0; let timeouts = 0; let fiveXx = 0;
  for (const s of samples) {
    if (s.err) { if (s.err === 'timeout') timeouts += 1; else network += 1; continue; }
    if (s.status >= 200 && s.status < 300) ok += 1; else errorsByStatus[s.status] = (errorsByStatus[s.status] || 0) + 1;
    if (s.status >= 500) fiveXx += 1;
  }
  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    requests: samples.length, ok, errors_by_status: errorsByStatus, network_errors: network, timeouts, five_xx: fiveXx,
    p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99),
    max: latencies.length ? Math.max(...latencies) : null, mean: latencies.length ? sum / latencies.length : null,
    rps: elapsedMs > 0 ? samples.length / (elapsedMs / 1000) : null
  };
}

// Runs `concurrency` sequential loops until the deadline. Each sample = full round trip including the body read.
async function runLoad({ url, path: p, token, concurrency, seconds, timeoutMs, fetchImpl = globalThis.fetch, now = () => performance.now() }) {
  const target = targetUrl(url, p);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'anchor-load-smoke/1' };
  const samples = []; const start = now(); const deadline = start + seconds * 1000;
  async function worker() {
    while (now() < deadline) {
      const t0 = now(); let status = null; let err = null;
      try {
        const res = await fetchImpl(target, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
        status = res.status;
        await res.arrayBuffer();
      } catch (e) {
        err = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network';
      }
      samples.push({ ms: now() - t0, status, err });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { target, samples, elapsed_ms: now() - start };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function probeDb(pool, { until, intervalMs = PROBE_INTERVAL_MS, now = () => performance.now() }) {
  const out = { max_connections: null, peak_threads_connected: null, samples: 0, error: null };
  try {
    const [v] = await pool.query("SHOW VARIABLES LIKE 'max_connections'");
    out.max_connections = v.length ? Number(v[0].Value) : null;
    while (now() < until) {
      const [s] = await pool.query("SHOW GLOBAL STATUS LIKE 'Threads_connected'");
      const n = s.length ? Number(s[0].Value) : null;
      if (Number.isFinite(n)) { out.samples += 1; out.peak_threads_connected = out.peak_threads_connected === null ? n : Math.max(out.peak_threads_connected, n); }
      await sleep(intervalMs);
    }
  } catch (e) { out.error = e.code || e.message; }
  return out;
}

const fmt = (v) => (v === null || v === undefined ? '–' : String(Math.round(v)));

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.url || !args.token) { console.error(USAGE); return 2; }
  const target = targetUrl(args.url, args.path);
  console.log(`load_smoke: GET ${target} · concurrency ${args.concurrency} · ${args.seconds} s · timeout ${args.timeoutMs} ms · db probe ${args.dbProbe ? 'on' : 'off'}`);

  let pool = null;
  if (args.dbProbe) {
    try { pool = require('../../db/pool').getDbPool(); } catch (e) { console.error(`load_smoke: db probe disabled (${e.message})`); }
  }
  const deadline = performance.now() + args.seconds * 1000;
  const probeP = pool ? probeDb(pool, { until: deadline }) : Promise.resolve(null);
  const run = await runLoad({ url: args.url, path: args.path, token: args.token, concurrency: args.concurrency, seconds: args.seconds, timeoutMs: args.timeoutMs });
  const probe = await probeP;
  if (pool) await pool.end().catch(() => {});

  const s = summarize(run.samples, run.elapsed_ms);
  console.log(`requests: ${s.requests} · ok (2xx): ${s.ok} · rps: ${s.rps === null ? '–' : s.rps.toFixed(1)} · elapsed ${fmt(run.elapsed_ms)} ms`);
  const statuses = Object.entries(s.errors_by_status).sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log(`errors by status: ${statuses.length ? statuses.map(([k, n]) => `${k}: ${n}`).join(', ') : 'none'}`);
  console.log(`network errors: ${s.network_errors} · timeouts: ${s.timeouts}`);
  console.log(`latency ms: p50 ${fmt(s.p50)} · p95 ${fmt(s.p95)} · p99 ${fmt(s.p99)} · max ${fmt(s.max)} · mean ${fmt(s.mean)}`);
  if (probe) {
    console.log(probe.error
      ? `db: probe failed (${probe.error})`
      : `db: max_connections ${probe.max_connections === null ? '–' : probe.max_connections} · peak Threads_connected ${probe.peak_threads_connected === null ? '–' : probe.peak_threads_connected} (${probe.samples} samples)`);
  }
  const verdict = s.five_xx ? 'FAIL (5xx seen)' : (s.ok === 0 ? 'FAIL (no successful response)' : 'PASS');
  console.log(`RESULT: ${verdict}`);
  const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
  console.log(`SUMMARY ${JSON.stringify({ target, concurrency: args.concurrency, seconds: args.seconds, ...s, p50: r1(s.p50), p95: r1(s.p95), p99: r1(s.p99), max: r1(s.max), mean: r1(s.mean), rps: r1(s.rps), db: probe })}`);
  return s.five_xx ? 1 : (s.ok === 0 ? 2 : 0);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error('load_smoke failed:', err.message); process.exit(1); });
}

module.exports = { parseArgs, percentile, summarize, runLoad, probeDb, targetUrl, main };
