#!/usr/bin/env node
'use strict';
/**
 * Recall pilot report for one student (read-only).
 *   railway run --service anchor -- node src/lc/scripts/pilot_report.js --user <user_id|email> [--days 14] [--last 20] [--out <file.md>] [--verify-deleted]
 *
 * Prints markdown to stdout (and writes it with --out). Never prints code, prompts, or tokens: no query selects a
 * code column, fenced blocks in student messages are redacted, and issue_report payloads print only their text field.
 * SQL lives in the small `queries.*` functions; `render(rows, opts)` is pure so tests feed it canned rows without a DB.
 * Exit codes: 0 ok, 1 failure, 2 usage / unknown user, 5 --verify-deleted found rows.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const LC_USER_TABLES = ['lc_client_events', 'lc_chat_messages', 'lc_chat_sessions', 'lc_habits', 'lc_skill_events', 'lc_submissions', 'lc_solved', 'lc_consents', 'lc_profiles'];
const RUNGS = [1, 2, 3, 4];
const DRIFT_MIN_RATIO = 0.8;
const DRIFT_MIN_SUBMITS = 5;
const DAY_MS = 86400000;
const USAGE = 'usage: node src/lc/scripts/pilot_report.js --user <user_id|email> [--days 14] [--last 20] [--out <file.md>] [--verify-deleted]';

// ---------------- small local helpers (kept local on purpose: this script must stay standalone) ----------------
const parseJson = (v, d = null) => { if (v === null || v === undefined) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return d; } };
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d;
}
const dayKey = (d) => d.toISOString().slice(0, 10);
const dateOnlyKey = (v) => { if (typeof v === 'string') return v.slice(0, 10); const d = toDate(v); if (!d) return '–'; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const iso = (v) => { const d = toDate(v); return d ? d.toISOString().replace(/\.\d{3}Z$/, 'Z') : '–'; };
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function percentile(values, p) {
  const s = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
const mean = (values) => { const s = (values || []).filter((v) => Number.isFinite(v)); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const inc = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; return obj; };
const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const ratio = (a, b) => (b ? (a / b).toFixed(2) : '–');
const fmtMs = (v) => (v === null || v === undefined ? '–' : String(Math.round(v)));
const fmtN = (v) => (v === null || v === undefined ? '–' : String(Number.isInteger(v) ? v : Number(v.toFixed(1))));
const oneLine = (s) => String(s === null || s === undefined ? '' : s).replace(/\s*\r?\n\s*/g, ' ').trim();
const cell = (v) => (v === null || v === undefined || v === '' ? '–' : oneLine(v).replace(/\|/g, '\\|'));
function mdTable(headers, rows) {
  const lines = [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) lines.push(`| ${r.map(cell).join(' | ')} |`);
  return lines.join('\n');
}
const pairs = (obj, keys) => (keys || Object.keys(obj)).map((k) => `${k} ${obj[k] || 0}`).join(' · ');
const sortedEntries = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
function maskEmail(e) { if (!e || typeof e !== 'string' || !e.includes('@')) return '–'; const [l, d] = e.split('@'); return `${l.slice(0, 1)}***@${d}`; }
// Student-typed text may contain pasted code: drop fenced blocks (closed or dangling) and cap the length.
function redactCode(text, max = 1200) {
  let s = String(text === null || text === undefined ? '' : text).replace(/```[\s\S]*?```/g, '[code omitted]').replace(/```[\s\S]*$/, '[code omitted]');
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}
const quote = (label, text) => String(text).split(/\r?\n/).map((l, i) => `> ${i === 0 ? `**${label}:** ` : ''}${l}`).join('\n');

// ---------------- row accessors (defensive: JSON columns may arrive parsed or as strings) ----------------
const rungOf = (m) => { const r = num(m.rung !== null && m.rung !== undefined ? m.rung : (parseJson(m.contract, null) || {}).rung); return RUNGS.includes(r) ? r : null; };
const listOf = (v) => { const a = parseJson(v, null); return Array.isArray(a) ? a : []; };
const usageOf = (m) => parseJson(m.usage_json, null) || {};
const guardOf = (m) => parseJson(m.guard_json, null) || {};
function latencyOf(m) {
  const u = usageOf(m);
  const v = num(u.latency_ms !== undefined ? u.latency_ms : (u.latencyMs !== undefined ? u.latencyMs : (guardOf(m).latency_ms !== undefined ? guardOf(m).latency_ms : m.latency_ms)));
  return v !== null && v >= 0 ? v : null;
}
function tokensOf(m) {
  const u = usageOf(m);
  const input = num(u.input_tokens !== undefined ? u.input_tokens : u.prompt_tokens);
  const output = num(u.output_tokens !== undefined ? u.output_tokens : u.completion_tokens);
  let total = num(u.total_tokens);
  if (total === null && (input !== null || output !== null)) total = (input || 0) + (output || 0);
  return { input, output, total };
}
const isCited = (a) => Boolean(a && (a.used === true || a.used === 1 || a.cited === true));
const habitKeyOf = (h) => (h && (h.key || h.habit_key)) || (h && h.id !== undefined && h.id !== null ? `id:${h.id}` : '?');
const violationRule = (v) => (typeof v === 'string' ? v : (v && (v.rule || v.code || v.name || v.type)) || 'unknown');
const bucketOfSub = (s) => s.verdict_bucket || (num(s.status_code) === 10 ? 'ac' : 'unknown');

// ---------------- stats (pure) ----------------
function hintsPerDay(msgs) {
  const days = new Map();
  for (const m of msgs) {
    const d = toDate(m.created_at); if (!d) continue;
    const k = dayKey(d);
    if (!days.has(k)) days.set(k, { day: k, hints: 0, by_rung: { 1: 0, 2: 0, 3: 0, 4: 0 }, degraded: 0, feedback: 0 });
    const row = days.get(k); row.hints += 1;
    const r = rungOf(m); if (r) row.by_rung[r] += 1;
    if (m.degraded) row.degraded += 1;
    if (m.feedback_thumb) row.feedback += 1;
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
function hintsPerRung(msgs) {
  const out = { total: msgs.length, unknown: 0, degraded: 0, by_rung: { 1: 0, 2: 0, 3: 0, 4: 0 } };
  for (const m of msgs) { const r = rungOf(m); if (r) out.by_rung[r] += 1; else out.unknown += 1; if (m.degraded) out.degraded += 1; }
  return out;
}
function feedbackStats(msgs) {
  const out = { total: msgs.length, with_feedback: 0, thumbs: { up: 0, down: 0 }, reasons: { helped: 0, too_much: 0, too_little: 0, wrong: 0 }, notes: 0, share: 0 };
  for (const m of msgs) {
    if (!m.feedback_thumb) continue;
    out.with_feedback += 1; inc(out.thumbs, m.feedback_thumb);
    if (m.feedback_reason) inc(out.reasons, m.feedback_reason);
    if (m.feedback_note) out.notes += 1;
  }
  out.share = out.total ? out.with_feedback / out.total : 0;
  return out;
}
function anchorStats(msgs) {
  const out = { hints: msgs.length, hints_with_anchors: 0, offered: 0, cited: 0, by_slug: [] };
  const by = new Map();
  for (const m of msgs) {
    const list = listOf(m.anchors); if (!list.length) continue;
    out.hints_with_anchors += 1;
    for (const a of list) {
      const slug = (a && a.slug) || '?';
      if (!by.has(slug)) by.set(slug, { slug, title: (a && a.title) || '', offered: 0, cited: 0 });
      const row = by.get(slug); row.offered += 1; out.offered += 1;
      if (!row.title && a && a.title) row.title = a.title;
      if (isCited(a)) { row.cited += 1; out.cited += 1; }
    }
  }
  out.by_slug = [...by.values()].sort((a, b) => b.offered - a.offered || (a.slug < b.slug ? -1 : 1));
  return out;
}
function habitStats(msgs, habitRows) {
  const rows = habitRows || [];
  const keyById = new Map(rows.map((h) => [String(h.id), h.habit_key || h.key]));
  const shown = new Map(); let hintsWith = 0; let shownTotal = 0;
  for (const m of msgs) {
    const list = listOf(m.habits); if (!list.length) continue;
    hintsWith += 1;
    for (const h of list) {
      let key = habitKeyOf(h);
      if (key.startsWith('id:') && keyById.has(key.slice(3))) key = keyById.get(key.slice(3));
      shown.set(key, (shown.get(key) || 0) + 1); shownTotal += 1;
    }
  }
  const states = { auto: 0, confirmed: 0, dismissed: 0, stale: 0 }; const reactions = { confirmed: 0, dismissed: 0, none: 0 }; let live = 0;
  const per = rows.map((h) => {
    inc(states, h.state || 'auto'); inc(reactions, h.reaction || 'none'); if (h.live) live += 1;
    const key = h.habit_key || h.key;
    return { key, tier: h.tier || '–', live: Boolean(h.live), state: h.state || 'auto', reaction: h.reaction || null, shown: shown.get(key) || 0 };
  });
  for (const [key, n] of shown) if (!per.some((p) => p.key === key)) per.push({ key, tier: '–', live: null, state: '–', reaction: null, shown: n });
  per.sort((a, b) => b.shown - a.shown || (a.key < b.key ? -1 : 1));
  return { hints: msgs.length, hints_with_habits: hintsWith, shown_total: shownTotal, rows: rows.length, live, states, reactions, per_habit: per };
}
function verdictStats(subs) {
  const out = { total: subs.length, by_via: { interceptor: 0, manual: 0, sync: 0 }, by_bucket: {}, accepted: 0, with_details: 0 };
  for (const s of subs) {
    inc(out.by_via, s.captured_via || 'sync'); inc(out.by_bucket, bucketOfSub(s));
    if (num(s.status_code) === 10) out.accepted += 1;
    if (s.has_details) out.with_details += 1;
  }
  return out;
}
function driftStats(events, now) {
  const days = new Map(); const last24 = { submit: 0, verdict: 0 }; const nowMs = now.getTime();
  for (const e of events) {
    const kind = e.type === 'submit_seen' ? 'submit' : (e.type === 'verdict_seen' ? 'verdict' : null); if (!kind) continue;
    const d = toDate(e.created_at); if (!d) continue;
    const k = dayKey(d);
    if (!days.has(k)) days.set(k, { day: k, submit: 0, verdict: 0 });
    days.get(k)[kind] += 1;
    if (d.getTime() <= nowMs && nowMs - d.getTime() <= DAY_MS) last24[kind] += 1;
  }
  const finish = (r) => ({ ...r, ratio: r.submit ? r.verdict / r.submit : null, flagged: r.submit >= DRIFT_MIN_SUBMITS && r.verdict / r.submit < DRIFT_MIN_RATIO });
  return { per_day: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(finish), last_24h: finish(last24) };
}
function syncStats(skillEvents, clientEvents) {
  const out = { runs: 0, by_phase: {}, kinds: {}, last_run_at: null, client: {}, errors: 0 };
  for (const e of skillEvents) {
    inc(out.kinds, e.kind || '?');
    if (e.kind !== 'sync') continue;
    out.runs += 1;
    const p = parseJson(e.payload, null) || {}; inc(out.by_phase, p.phase || 'unspecified');
    const d = toDate(e.created_at); if (d && (!out.last_run_at || d > out.last_run_at)) out.last_run_at = d;
  }
  for (const e of clientEvents) {
    const t = String(e.type || ''); if (!t.startsWith('sync_')) continue;
    inc(out.client, t); if (/error|fail/.test(t)) out.errors += 1;
  }
  return out;
}
function providerStats(msgs) {
  const by = new Map();
  for (const m of msgs) {
    const key = `${m.provider || 'none'}|${m.model || '–'}`;
    if (!by.has(key)) by.set(key, { provider: m.provider || 'none', model: m.model || '–', hints: 0, degraded: 0, latencies: [], tokens_in: 0, tokens_out: 0, tokens_total: 0, with_usage: 0 });
    const r = by.get(key); r.hints += 1; if (m.degraded) r.degraded += 1;
    const l = latencyOf(m); if (l !== null) r.latencies.push(l);
    const t = tokensOf(m); if (t.total !== null) { r.with_usage += 1; r.tokens_in += t.input || 0; r.tokens_out += t.output || 0; r.tokens_total += t.total; }
  }
  return [...by.values()].map((r) => ({ ...r, p50: percentile(r.latencies, 50), p95: percentile(r.latencies, 95), mean: mean(r.latencies), mean_tokens: r.with_usage ? r.tokens_total / r.with_usage : null })).sort((a, b) => b.hints - a.hints || (a.provider < b.provider ? -1 : 1));
}
function guardStats(msgs) {
  const out = { hints: msgs.length, with_violations: 0, total: 0, by_rule: {}, by_action: {} };
  for (const m of msgs) {
    const g = guardOf(m); const v = Array.isArray(g.violations) ? g.violations : [];
    if (v.length) out.with_violations += 1;
    out.total += v.length;
    for (const x of v) inc(out.by_rule, violationRule(x));
    if (g.action) inc(out.by_action, g.action);
  }
  return out;
}
function eventCounts(events) {
  const out = { by_type: {}, token_expired: 0, hint_timeout: 0, banner_shown: 0, banners: {} };
  for (const e of events) {
    const t = e.type || '?'; inc(out.by_type, t);
    if (t === 'token_expired') out.token_expired += 1;
    else if (t === 'hint_timeout') out.hint_timeout += 1;
    else if (t === 'banner_shown') { out.banner_shown += 1; const p = parseJson(e.payload, null) || {}; inc(out.banners, p.banner || p.kind || p.name || 'unspecified'); }
  }
  return out;
}
// Only the free-text field of an issue report is ever printed; an attached code field is noted, never shown.
function issueReports(events) {
  return events.filter((e) => e.type === 'issue_report').map((e) => {
    const p = parseJson(e.payload, null);
    const obj = p && typeof p === 'object' ? p : {};
    const text = typeof p === 'string' ? p : (obj.text || obj.note || obj.message || '');
    return { created_at: toDate(e.created_at), ext_version: e.ext_version || null, text: oneLine(redactCode(String(text), 1000)), has_code: Boolean(obj.code) };
  });
}
function transcripts(rows) {
  const asst = rows.lastAssistantMessages || []; const users = rows.userMessages || [];
  const subs = [...(rows.transcriptSubmissions || []), ...(rows.submissions || [])];
  const out = asst.map((a) => {
    const at = toDate(a.created_at); const atMs = at ? at.getTime() : null;
    let student = null; let studentMs = -Infinity;
    for (const u of users) {
      if (u.session_id !== a.session_id) continue;
      const ut = toDate(u.created_at); const utMs = ut ? ut.getTime() : 0;
      if (atMs !== null && utMs > atMs) continue;
      if (utMs >= studentMs) { student = u; studentMs = utMs; }
    }
    let verdict = null; let verdictTs = -Infinity;
    for (const s of subs) {
      if (s.slug !== a.slug) continue;
      const ts = num(s.ts); if (ts === null) continue;
      if (atMs !== null && ts * 1000 > atMs) continue;
      if (ts >= verdictTs) { verdict = s; verdictTs = ts; }
    }
    const g = guardOf(a);
    return {
      id: a.id, slug: a.slug || '?', created_at: at, rung: rungOf(a), provider: a.provider || 'none', model: a.model || '–', latency_ms: latencyOf(a), degraded: Boolean(a.degraded),
      student_text: student ? redactCode(student.content) : null,
      reply: redactCodeless(a.content),
      anchors: listOf(a.anchors).map((x) => ({ slug: (x && x.slug) || '?', cited: isCited(x) })),
      habits: listOf(a.habits).map(habitKeyOf),
      verdict: verdict ? { bucket: bucketOfSub(verdict), status_msg: verdict.status_msg || null, captured_via: verdict.captured_via || null, age_s: atMs !== null ? Math.round(atMs / 1000 - verdictTs) : null } : null,
      feedback: a.feedback_thumb ? { thumb: a.feedback_thumb, reason: a.feedback_reason || null, note: a.feedback_note || null } : null,
      guard: { violations: Array.isArray(g.violations) ? g.violations.length : 0, action: g.action || null }
    };
  });
  return out.sort((x, y) => (x.created_at ? x.created_at.getTime() : 0) - (y.created_at ? y.created_at.getTime() : 0));
}
// Tutor replies are safe to print as-is (rung-4 skeletons are the tutor's, not the student's); only cap the length.
function redactCodeless(text, max = 1500) { const s = String(text === null || text === undefined ? '' : text); return s.length > max ? `${s.slice(0, max)}…` : s; }
function inferNow(rows) {
  let best = null;
  for (const list of [rows.assistantMessages, rows.clientEvents, rows.skillEvents, rows.submissions, rows.lastAssistantMessages]) {
    for (const r of list || []) { const d = toDate(r.created_at); if (d && (!best || d > best)) best = d; }
  }
  return best;
}

// ---------------- render (pure) ----------------
function render(rows, opts = {}) {
  const r = rows || {};
  const msgs = r.assistantMessages || [];
  const now = toDate(opts.now) || inferNow(r) || new Date(0);
  const days = num(opts.days) || 14;
  const since = toDate(opts.since) || new Date(now.getTime() - days * DAY_MS);
  const requested = num(opts.last);
  const user = r.user || {}; const profile = r.profile || null;
  const fb = feedbackStats(msgs); const perDay = hintsPerDay(msgs); const perRung = hintsPerRung(msgs);
  const an = anchorStats(msgs); const hb = habitStats(msgs, r.habits || []); const vd = verdictStats(r.submissions || []);
  const dr = driftStats(r.clientEvents || [], now); const sy = syncStats(r.skillEvents || [], r.clientEvents || []);
  const pv = providerStats(msgs); const gd = guardStats(msgs); const ev = eventCounts(r.clientEvents || []); const ir = issueReports(r.clientEvents || []);
  const tr = transcripts(r);
  const L = [];
  const section = (title) => { if (L[L.length - 1] !== '') L.push(''); L.push(title, ''); };

  L.push('# Recall pilot report', '');
  L.push(`- user: \`${user.user_id || '–'}\` (${maskEmail(user.email)})`);
  L.push(`- window: last ${days} days (since ${iso(since)}) · generated ${iso(now)}`);
  L.push(`- hints in window: ${msgs.length}`);

  L.push('', '## Profile', '');
  if (!profile) L.push('_no lc_profiles row_');
  else {
    L.push(mdTable(['field', 'value'], [
      ['leetcode_username', profile.leetcode_username || '–'], ['language', profile.language || '–'], ['consent_code', profile.consent_code ? 'yes' : 'no'],
      ['sync_status', profile.sync_status || '–'], ['last_synced_at', iso(profile.last_synced_at)], ['model_version', profile.model_version || '–'],
      ['hints_today', `${profile.hints_today || 0}${profile.hints_day ? ` (${dateOnlyKey(profile.hints_day)})` : ''}`], ['created_at', iso(profile.created_at)]
    ]));
  }

  L.push('', '## Hints per day', '');
  L.push(mdTable(['day', 'hints', 'r1', 'r2', 'r3', 'r4', 'degraded', 'with feedback'], [
    ...perDay.map((d) => [d.day, d.hints, d.by_rung[1], d.by_rung[2], d.by_rung[3], d.by_rung[4], d.degraded, d.feedback]),
    ['total', perRung.total, perRung.by_rung[1], perRung.by_rung[2], perRung.by_rung[3], perRung.by_rung[4], perRung.degraded, fb.with_feedback]
  ]));

  L.push('', '## Hints per rung', '');
  L.push(mdTable(['rung', 'hints', 'share'], [...RUNGS.map((k) => [k, perRung.by_rung[k], pct(perRung.by_rung[k], perRung.total)]), ['unknown', perRung.unknown, pct(perRung.unknown, perRung.total)]]));

  L.push('', '## Feedback', '');
  L.push(`- hints with feedback: ${fb.with_feedback} / ${fb.total} (${pct(fb.with_feedback, fb.total)})`);
  L.push(`- thumbs: ${pairs(fb.thumbs, ['up', 'down'])}`);
  L.push(`- reasons: ${pairs(fb.reasons, ['helped', 'too_much', 'too_little', 'wrong'])}`);
  L.push(`- notes: ${fb.notes}`);

  L.push('', '## Anchors', '');
  L.push(`- hints with anchors: ${an.hints_with_anchors} / ${an.hints}`);
  L.push(`- offered: ${an.offered} · cited: ${an.cited} (${pct(an.cited, an.offered)})`);
  if (an.by_slug.length) L.push('', mdTable(['slug', 'title', 'offered', 'cited'], an.by_slug.map((x) => [x.slug, x.title || '–', x.offered, x.cited])));

  L.push('', '## Habits', '');
  L.push(`- hints with habits: ${hb.hints_with_habits} / ${hb.hints} · habits shown: ${hb.shown_total}`);
  L.push(`- habit rows: ${hb.rows} · live: ${hb.live}`);
  L.push(`- states: ${pairs(hb.states, ['auto', 'confirmed', 'dismissed', 'stale'])}`);
  L.push(`- reactions: ${pairs(hb.reactions, ['confirmed', 'dismissed', 'none'])}`);
  if (hb.per_habit.length) L.push('', mdTable(['key', 'tier', 'live', 'state', 'reaction', 'shown in hints'], hb.per_habit.map((h) => [h.key, h.tier, h.live === null ? '–' : (h.live ? 'yes' : 'no'), h.state, h.reaction || '–', h.shown])));

  L.push('', '## Verdicts', '');
  L.push(`- submissions captured in window: ${vd.total} · accepted: ${vd.accepted} · with judge details: ${vd.with_details}`);
  L.push(`- captured_via: ${pairs(vd.by_via, ['interceptor', 'manual', 'sync'])}`);
  const buckets = sortedEntries(vd.by_bucket);
  if (buckets.length) L.push('', mdTable(['bucket', 'n'], buckets));

  L.push('', '## Drift (verdict_seen / submit_seen)', '');
  const d24 = dr.last_24h;
  L.push(`- last 24 h: submit_seen ${d24.submit} · verdict_seen ${d24.verdict} · ratio ${ratio(d24.verdict, d24.submit)}${d24.flagged ? ` · **FLAG: ratio below ${DRIFT_MIN_RATIO} with ≥${DRIFT_MIN_SUBMITS} submits**` : ' · ok'}`);
  if (dr.per_day.length) L.push('', mdTable(['day', 'submit_seen', 'verdict_seen', 'ratio', 'flag'], dr.per_day.map((d) => [d.day, d.submit, d.verdict, ratio(d.verdict, d.submit), d.flagged ? 'FLAG' : ''])));

  L.push('', '## Sync', '');
  L.push(`- sync runs (lc_skill_events kind=sync): ${sy.runs}${sy.last_run_at ? ` · last ${iso(sy.last_run_at)}` : ''}`);
  L.push(`- phases: ${Object.keys(sy.by_phase).length ? pairs(sy.by_phase) : 'none'}`);
  L.push(`- skill events by kind: ${Object.keys(sy.kinds).length ? pairs(sy.kinds) : 'none'}`);
  L.push(`- client sync events: ${Object.keys(sy.client).length ? pairs(sy.client) : 'none'} · errors: ${sy.errors}`);

  L.push('', '## Provider', '');
  const allLat = msgs.map(latencyOf).filter((v) => v !== null);
  L.push(`- all providers: p50 ${fmtMs(percentile(allLat, 50))} ms · p95 ${fmtMs(percentile(allLat, 95))} ms · hints with latency ${allLat.length} / ${msgs.length}`);
  if (pv.length) L.push('', mdTable(['provider', 'model', 'hints', 'degraded', 'p50 ms', 'p95 ms', 'mean ms', 'tokens in', 'tokens out', 'tokens total', 'mean tokens/hint'], pv.map((p) => [p.provider, p.model, p.hints, p.degraded, fmtMs(p.p50), fmtMs(p.p95), fmtMs(p.mean), p.tokens_in, p.tokens_out, p.tokens_total, fmtN(p.mean_tokens)])));

  L.push('', '## Guard', '');
  L.push(`- hints with violations: ${gd.with_violations} / ${gd.hints} · violations total: ${gd.total}`);
  L.push(`- by rule: ${Object.keys(gd.by_rule).length ? pairs(gd.by_rule) : 'none'}`);
  L.push(`- by action: ${Object.keys(gd.by_action).length ? pairs(gd.by_action) : 'none'}`);

  L.push('', '## Client events', '');
  L.push(`- token_expired: ${ev.token_expired} · hint_timeout: ${ev.hint_timeout} · banner_shown: ${ev.banner_shown}${Object.keys(ev.banners).length ? ` (${pairs(ev.banners)})` : ''}`);
  const types = sortedEntries(ev.by_type);
  if (types.length) L.push('', mdTable(['type', 'n'], types));

  L.push('', '## Issue reports', '');
  if (!ir.length) L.push('_none_');
  else for (const i of ir) L.push(`- ${iso(i.created_at)}${i.ext_version ? ` (ext ${i.ext_version})` : ''}: ${i.text || '(no text)'}${i.has_code ? ' _[code attached, not shown]_' : ''}`);

  L.push('', `## Last ${tr.length} transcripts${requested !== null && requested !== tr.length ? ` (${requested} requested)` : ''}`, '');
  if (!tr.length) L.push('_none_');
  tr.forEach((t, i) => {
    L.push(`### ${i + 1}. ${t.slug} · ${iso(t.created_at)} · rung ${t.rung === null ? '?' : t.rung} · ${t.provider}/${t.model} · ${t.latency_ms === null ? '– ms' : `${Math.round(t.latency_ms)} ms`}${t.degraded ? ' · degraded' : ''}`, '');
    const vparts = t.verdict ? [t.verdict.status_msg, t.verdict.captured_via, t.verdict.age_s === null ? null : `${t.verdict.age_s} s before`].filter(Boolean) : [];
    L.push(`- verdict: ${t.verdict ? `${t.verdict.bucket}${vparts.length ? ` (${vparts.join(', ')})` : ''}` : 'none'}`);
    L.push(`- anchors: ${t.anchors.length ? t.anchors.map((a) => `${a.slug}${a.cited ? ' (cited)' : ''}`).join(', ') : 'none'}`);
    L.push(`- habits: ${t.habits.length ? t.habits.join(', ') : 'none'}`);
    L.push(`- feedback: ${t.feedback ? `${t.feedback.thumb}${t.feedback.reason ? ` / ${t.feedback.reason}` : ''}${t.feedback.note ? ` — ${oneLine(redactCode(t.feedback.note, 300))}` : ''}` : 'none'}`);
    L.push(`- guard: ${t.guard.violations} violation${t.guard.violations === 1 ? '' : 's'}${t.guard.action ? `, ${t.guard.action}` : ''}`, '');
    L.push(quote('Student', t.student_text === null ? '(no student message found)' : t.student_text), '>', quote('Recall', t.reply), '');
  });

  if (r.rowCounts) {
    section('## Verify deleted');
    const entries = Object.entries(r.rowCounts).map(([t, n]) => [t, num(n) || 0]);
    const remaining = entries.reduce((a, [, n]) => a + n, 0);
    L.push(mdTable(['table', 'rows'], entries), '', `- result: ${remaining === 0 ? 'ALL ZERO' : `NOT EMPTY (${remaining} rows remain)`}`);
  }
  L.push('');
  return L.join('\n');
}

// ---------------- SQL (parameterised; no code/prompt columns are ever selected) ----------------
const MSG_COLS = 'm.id, m.session_id, s.slug, m.rung, m.anchors, m.habits, m.contract, m.usage_json, m.guard_json, m.provider, m.model, m.degraded, m.feedback_thumb, m.feedback_reason, m.feedback_note, m.feedback_at, m.created_at';
const queries = {
  async resolveUser(db, userOrEmail) {
    const key = String(userOrEmail || '').trim(); if (!key) return null;
    const sql = key.includes('@') ? 'SELECT user_id, email, name FROM users WHERE email = ? LIMIT 1' : 'SELECT user_id, email, name FROM users WHERE user_id = ? LIMIT 1';
    const [rows] = await db.query(sql, [key]);
    return rows[0] || null;
  },
  async profile(db, userId) {
    const [rows] = await db.query('SELECT user_id, leetcode_username, language, consent_code, consent_at, sync_status, last_synced_at, model_version, hints_day, hints_today, created_at, updated_at FROM lc_profiles WHERE user_id = ?', [userId]);
    return rows[0] || null;
  },
  async assistantMessages(db, userId, since) {
    const [rows] = await db.query(`SELECT ${MSG_COLS} FROM lc_chat_messages m LEFT JOIN lc_chat_sessions s ON s.id = m.session_id WHERE m.user_id = ? AND m.role = 'assistant' AND m.created_at >= ? ORDER BY m.created_at, m.id`, [userId, since]);
    return rows;
  },
  async lastAssistantMessages(db, userId, n) {
    if (!(n > 0)) return [];
    const [rows] = await db.query(`SELECT ${MSG_COLS}, m.content FROM lc_chat_messages m LEFT JOIN lc_chat_sessions s ON s.id = m.session_id WHERE m.user_id = ? AND m.role = 'assistant' ORDER BY m.created_at DESC, m.id DESC LIMIT ?`, [userId, Number(n)]);
    return rows;
  },
  async userMessagesForSessions(db, userId, sessionIds) {
    if (!sessionIds.length) return [];
    const [rows] = await db.query("SELECT id, session_id, content, created_at FROM lc_chat_messages WHERE user_id = ? AND role = 'user' AND session_id IN (?) ORDER BY created_at, id", [userId, sessionIds]);
    return rows;
  },
  async habits(db, userId) {
    const [rows] = await db.query('SELECT id, habit_key, category, subpattern, bucket, tier, live, state, reaction, reaction_at, first_seen_at, last_seen_at FROM lc_habits WHERE user_id = ? ORDER BY habit_key', [userId]);
    return rows;
  },
  async submissions(db, userId, since) {
    const [rows] = await db.query('SELECT lc_submission_id, slug, status_code, status_msg, verdict_bucket, lang, ts, has_details, captured_via, created_at FROM lc_submissions WHERE user_id = ? AND created_at >= ? ORDER BY ts, lc_submission_id', [userId, since]);
    return rows;
  },
  async submissionsForSlugs(db, userId, slugs) {
    if (!slugs.length) return [];
    const [rows] = await db.query('SELECT lc_submission_id, slug, status_code, status_msg, verdict_bucket, ts, captured_via FROM lc_submissions WHERE user_id = ? AND slug IN (?) ORDER BY ts, lc_submission_id', [userId, slugs]);
    return rows;
  },
  async clientEvents(db, userId, since) {
    const [rows] = await db.query('SELECT id, type, payload, ext_version, created_at FROM lc_client_events WHERE user_id = ? AND created_at >= ? ORDER BY created_at, id', [userId, since]);
    return rows;
  },
  async skillEvents(db, userId, since) {
    const [rows] = await db.query('SELECT id, kind, payload, model_version, created_at FROM lc_skill_events WHERE user_id = ? AND created_at >= ? ORDER BY created_at, id', [userId, since]);
    return rows;
  },
  // Table names come from the fixed list above, never from input.
  async rowCounts(db, userId) {
    const out = {};
    for (const t of LC_USER_TABLES) { const [rows] = await db.query(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [userId]); out[t] = Number(rows[0] && rows[0].n) || 0; }
    return out;
  }
};

async function collect(db, userId, { since, last, verifyDeleted } = {}) {
  const [profile, assistantMessages, habits, submissions, clientEvents, skillEvents, lastAssistantMessages] = await Promise.all([
    queries.profile(db, userId), queries.assistantMessages(db, userId, since), queries.habits(db, userId), queries.submissions(db, userId, since),
    queries.clientEvents(db, userId, since), queries.skillEvents(db, userId, since), queries.lastAssistantMessages(db, userId, last)
  ]);
  const sessionIds = [...new Set(lastAssistantMessages.map((m) => m.session_id).filter(Boolean))];
  const slugs = [...new Set(lastAssistantMessages.map((m) => m.slug).filter(Boolean))];
  const [userMessages, transcriptSubmissions] = await Promise.all([queries.userMessagesForSessions(db, userId, sessionIds), queries.submissionsForSlugs(db, userId, slugs)]);
  const rowCounts = verifyDeleted ? await queries.rowCounts(db, userId) : null;
  return { profile, assistantMessages, habits, submissions, clientEvents, skillEvents, lastAssistantMessages, userMessages, transcriptSubmissions, rowCounts };
}

// ---------------- CLI ----------------
function parseArgs(argv) {
  const out = { user: null, days: 14, last: 20, out: null, verifyDeleted: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') out.user = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--last') out.last = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--verify-deleted') out.verifyDeleted = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(out.days) || out.days < 1) out.days = 14;
  if (!Number.isInteger(out.last) || out.last < 0) out.last = 20;
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.user) { console.error(USAGE); return 2; }
  const { getDbPool } = require('../../db/pool');
  const pool = getDbPool();
  try {
    const user = await queries.resolveUser(pool, args.user);
    if (!user) { console.error('pilot_report: no users row matches the given --user'); return 2; }
    const now = new Date();
    const since = new Date(now.getTime() - args.days * DAY_MS);
    const rows = await collect(pool, user.user_id, { since, last: args.last, verifyDeleted: args.verifyDeleted });
    rows.user = user;
    const md = render(rows, { now, since, days: args.days, last: args.last });
    process.stdout.write(md);
    if (args.out) {
      const outPath = path.resolve(args.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, md);
      console.error(`pilot_report: wrote ${outPath}`);
    }
    if (rows.rowCounts) {
      const remaining = Object.values(rows.rowCounts).reduce((a, b) => a + b, 0);
      console.error(remaining === 0 ? 'pilot_report: verify-deleted OK (0 rows in every lc_ table)' : `pilot_report: verify-deleted FAILED (${remaining} rows remain)`);
      return remaining === 0 ? 0 : 5;
    }
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error('pilot_report failed:', err.message); process.exit(1); });
}

module.exports = {
  queries, collect, render, parseArgs, main, LC_USER_TABLES,
  stats: { hintsPerDay, hintsPerRung, feedbackStats, anchorStats, habitStats, verdictStats, driftStats, syncStats, providerStats, guardStats, eventCounts, issueReports, transcripts },
  helpers: { percentile, redactCode, toDate, parseJson }
};
