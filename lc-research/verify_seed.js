#!/usr/bin/env node
'use strict';
/**
 * Verify a drafted sub-pattern seed against LeetCode (public GraphQL, no login, 1 req/s).
 *   node verify_seed.js seed_draft.json subpatterns.json
 * For every slug: confirms it exists, records frontend id / difficulty / tags / paid flag,
 * marks verified:false for slugs that do not resolve, and flags members whose tags carry
 * neither a DP nor a graph tag (likely a wrong slug or a mis-filed problem).
 */
const fs = require('fs');
const [,, IN, OUT] = process.argv;
if (!IN || !OUT) { console.error('usage: node verify_seed.js seed_draft.json subpatterns.json'); process.exit(1); }
const draft = JSON.parse(fs.readFileSync(IN, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const Q = `query q($s: String!) { question(titleSlug: $s) { questionId questionFrontendId title titleSlug difficulty isPaidOnly topicTags { slug } similarQuestions } }`;
const DP = new Set(['dynamic-programming', 'memoization', 'bitmask', 'game-theory', 'knapsack-problem', 'complete-knapsack']);
const GR = new Set(['graph', 'breadth-first-search', 'depth-first-search', 'topological-sort', 'shortest-path', 'union-find', 'minimum-spanning-tree', 'strongly-connected-component', 'biconnected-component', 'eulerian-circuit', 'tree']);
const cache = new Map();
async function lookup(slug) {
  if (cache.has(slug)) return cache.get(slug);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(1000);
    const res = await fetch('https://leetcode.com/graphql/', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, referer: 'https://leetcode.com/' }, body: JSON.stringify({ query: Q, variables: { s: slug }, operationName: 'q' }) });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500 || /^\s*</.test(text)) { console.warn(`  ${slug}: HTTP ${res.status}, backing off`); await sleep(5000 * attempt); continue; }
    let json; try { json = JSON.parse(text); } catch (_) { json = null; }
    const q = json && json.data ? json.data.question : null;
    const rec = q ? { verified: true, questionId: q.questionId, frontendId: q.questionFrontendId, title: q.title, difficulty: String(q.difficulty).toLowerCase(), paid: !!q.isPaidOnly, tags: (q.topicTags || []).map((t) => t.slug), similar: (() => { try { return JSON.parse(q.similarQuestions || '[]').map((x) => x.titleSlug); } catch (_) { return []; } })() } : { verified: false };
    cache.set(slug, rec);
    return rec;
  }
  cache.set(slug, { verified: false, error: 'rate-limited' });
  return cache.get(slug);
}
(async () => {
  const subpatterns = draft.subpatterns || draft.merged?.subpatterns || [];
  const total = subpatterns.reduce((n, s) => n + s.problems.length, 0);
  console.log(`${subpatterns.length} sub-patterns, ${total} memberships (${new Set(subpatterns.flatMap((s) => s.problems.map((p) => p.slug))).size} distinct slugs) - about ${Math.round(total / 60)} min`);
  let i = 0, bad = 0, offFamily = 0;
  const out = { version: 'v0', generated_at: new Date().toISOString(), source: IN, subpatterns: [] };
  for (const sp of subpatterns) {
    const fam = sp.family || (sp.id.startsWith('dp.') ? 'dp' : 'graph');
    const problems = [];
    for (const p of sp.problems) {
      i++;
      const slug = String(p.slug).trim().toLowerCase();
      const r = await lookup(slug);
      process.stdout.write(`\r  ${i}/${total} ${slug.padEnd(60)} ${r.verified ? 'ok ' : 'MISSING'}   `);
      if (!r.verified) { bad++; problems.push({ slug, primary: !!p.primary, confidence: p.confidence || 'medium', why: p.why || '', verified: false }); continue; }
      const famTags = fam === 'dp' ? DP : GR;
      const off = !r.tags.some((t) => famTags.has(t));
      if (off) offFamily++;
      problems.push({ slug, primary: !!p.primary, confidence: p.confidence || 'medium', why: p.why || '', verified: true, frontendId: r.frontendId, title: r.title, difficulty: r.difficulty, paid: r.paid, tags: r.tags, similar: r.similar, off_family_tags: off });
    }
    out.subpatterns.push({ id: sp.id, family: fam, label: sp.label || sp.id, canonical: (sp.canonical || []).map((s) => String(s).toLowerCase()), problems });
  }
  process.stdout.write('\n');
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const ok = total - bad;
  console.log(`verified ${ok}/${total}; ${bad} slugs do not exist on LeetCode; ${offFamily} verified members carry no ${'DP/graph'} tag (review those). Wrote ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
