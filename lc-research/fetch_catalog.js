#!/usr/bin/env node
'use strict';
// Public, anonymous: the whole LeetCode problem catalogue with fine-grained tags. ~36 requests at 1/s.
//   node fetch_catalog.js catalog.json
const fs = require('fs');
const OUT = process.argv[2] || 'catalog.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const Q = `query problemsetQuestionListV2($limit: Int, $skip: Int, $categorySlug: String) { problemsetQuestionListV2(limit: $limit, skip: $skip, categorySlug: $categorySlug) { questions { id titleSlug title questionFrontendId paidOnly difficulty acRate topicTags { name slug } } totalLength hasMore } }`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const rows = []; let skip = 0, total = null;
  for (;;) {
    await sleep(1000);
    const res = await fetch('https://leetcode.com/graphql/', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, referer: 'https://leetcode.com/problemset/' }, body: JSON.stringify({ query: Q, variables: { limit: 100, skip, categorySlug: 'all-code-essentials' }, operationName: 'problemsetQuestionListV2' }) });
    const text = await res.text();
    if (res.status === 429 || /^\s*</.test(text)) { console.warn(`HTTP ${res.status}, backing off`); await sleep(10000); continue; }
    const page = JSON.parse(text).data.problemsetQuestionListV2;
    total = page.totalLength;
    for (const q of page.questions) rows.push({ slug: q.titleSlug, title: q.title, frontendId: q.questionFrontendId, difficulty: String(q.difficulty).toLowerCase(), paid: !!q.paidOnly, acRate: q.acRate, tags: (q.topicTags || []).map((t) => t.slug) });
    process.stdout.write(`\r${rows.length}/${total}   `);
    if (!page.hasMore || !page.questions.length) break;
    skip += page.questions.length;
  }
  const tagCounts = {}; const tagNames = {};
  for (const r of rows) for (const t of r.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  fs.writeFileSync(OUT, JSON.stringify({ fetched_at: new Date().toISOString(), total: rows.length, tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([slug, count]) => ({ slug, count })), problems: rows }, null, 1));
  console.log(`\nwrote ${OUT}: ${rows.length} problems, ${Object.keys(tagCounts).length} distinct tags`);
})().catch((e) => { console.error(e); process.exit(1); });
