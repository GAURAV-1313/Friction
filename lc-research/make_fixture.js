#!/usr/bin/env node
'use strict';
// Synthetic export in the exact extract.js format, with a planted habit:
// the student fails interval-DP problems on base-case-shaped tests but solves knapsack first try.
const fs = require('fs'); const path = require('path');
const OUT = process.argv[2] || path.join(__dirname, 'fixture-export');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(path.join(OUT, 'details'), { recursive: true }); fs.mkdirSync(path.join(OUT, 'problems'), { recursive: true });
let seedRand = 7; const rand = () => (seedRand = (seedRand * 9301 + 49297) % 233280) / 233280;
const P = {
  'dp.interval': [['burst-balloons', 'hard'], ['minimum-cost-to-merge-stones', 'hard'], ['strange-printer', 'hard'], ['palindrome-partitioning-ii', 'hard'], ['longest-palindromic-subsequence', 'medium']],
  'dp.knapsack_01': [['partition-equal-subset-sum', 'medium'], ['target-sum', 'medium'], ['last-stone-weight-ii', 'medium'], ['ones-and-zeroes', 'medium'], ['tallest-billboard', 'hard']],
  'dp.knapsack_unbounded': [['coin-change', 'medium'], ['coin-change-ii', 'medium'], ['perfect-squares', 'medium'], ['combination-sum-iv', 'medium']],
  'graph.topological_sort': [['course-schedule', 'medium'], ['course-schedule-ii', 'medium'], ['alien-dictionary', 'hard'], ['parallel-courses', 'medium']],
  'graph.dijkstra': [['network-delay-time', 'medium'], ['path-with-minimum-effort', 'medium'], ['swim-in-rising-water', 'hard'], ['cheapest-flights-within-k-stops', 'medium']],
  other: [['two-sum', 'easy'], ['valid-parentheses', 'easy'], ['merge-intervals', 'medium'], ['group-anagrams', 'medium'], ['lru-cache', 'medium'], ['trapping-rain-water', 'hard'], ['product-of-array-except-self', 'medium'], ['kth-largest-element-in-an-array', 'medium'], ['top-k-frequent-elements', 'medium'], ['longest-substring-without-repeating-characters', 'medium'], ['3sum', 'medium'], ['container-with-most-water', 'medium']]
};
const TAGS = { 'dp.interval': ['array', 'dynamic-programming'], 'dp.knapsack_01': ['array', 'dynamic-programming', 'knapsack-problem'], 'dp.knapsack_unbounded': ['array', 'dynamic-programming', 'complete-knapsack'], 'graph.topological_sort': ['graph', 'topological-sort', 'depth-first-search'], 'graph.dijkstra': ['graph', 'shortest-path', 'heap-priority-queue'], other: ['array', 'hash-table'] };
const solved = [], subs = []; let id = 100000, ts = 1700000000, fid = 1;
const seedFile = { version: 'fixture', subpatterns: [] };
for (const [sp, list] of Object.entries(P)) {
  if (sp !== 'other') seedFile.subpatterns.push({ id: sp, family: sp.split('.')[0], label: sp, canonical: [list[0][0]], problems: list.map(([slug]) => ({ slug, primary: true, confidence: 'high' })) });
  for (const [slug, diff] of list) {
    solved.push({ titleSlug: slug, title: slug, questionFrontendId: String(fid++), paidOnly: false, difficulty: diff.toUpperCase(), status: 'SOLVED', topicTags: TAGS[sp] });
    fs.writeFileSync(path.join(OUT, 'problems', `${slug}.json`), JSON.stringify({ questionId: String(fid), questionFrontendId: String(fid), title: slug, titleSlug: slug, difficulty: diff, isPaidOnly: false, topicTags: TAGS[sp], similarQuestions: list.filter(([s]) => s !== slug).slice(0, 1).map(([s]) => s), hints: [], content: `<p>Statement for ${slug}.</p>` }));
    ts += 86400 * 2;
    const nFails = sp === 'dp.interval' ? 2 + Math.floor(rand() * 2) : sp === 'graph.dijkstra' ? (rand() < 0.5 ? 1 : 0) : (rand() < 0.15 ? 1 : 0);
    for (let i = 0; i < nFails; i++) {
      const sid = id++; const baseCase = sp === 'dp.interval' ? rand() < 0.85 : rand() < 0.3; const tle = sp === 'graph.dijkstra' && rand() < 0.6;
      const statusCode = tle ? 14 : 11; ts += 600;
      subs.push({ id: sid, titleSlug: slug, title: slug, statusCode, statusDisplay: tle ? 'Time Limit Exceeded' : 'Wrong Answer', lang: 'python3', langName: 'Python3', runtime: 'N/A', memory: 'N/A', timestamp: ts, isPending: 'Not Pending', code: `class Solution:\n    def solve(self, a):\n        # attempt ${i + 1}\n        return a[0]\n`, source: 'rest' });
      fs.writeFileSync(path.join(OUT, 'details', `${sid}.json`), JSON.stringify({ id: sid, statusCode, runtimePercentile: null, code: `class Solution:\n    def solve(self, a):\n        # attempt ${i + 1}\n        return a[0]\n`, timestamp: ts, lang: { name: 'python3' }, question: { titleSlug: slug }, lastTestcase: tle ? '[1,2,3,...,100000]' : baseCase ? '[]' : '[3,1,5,8]', expectedOutput: '0', codeOutput: '1', runtimeError: '', compileError: '', totalCorrect: 3, totalTestcases: 70 }));
    }
    const sid = id++; ts += 900;
    subs.push({ id: sid, titleSlug: slug, title: slug, statusCode: 10, statusDisplay: 'Accepted', lang: 'python3', langName: 'Python3', runtime: '50 ms', memory: '16 MB', timestamp: ts, isPending: 'Not Pending', code: `class Solution:\n    def solve(self, a):\n        dp = {}\n        return 0\n`, source: 'rest' });
    fs.writeFileSync(path.join(OUT, 'details', `${sid}.json`), JSON.stringify({ id: sid, statusCode: 10, runtimePercentile: 5 + rand() * 90, code: 'class Solution: pass', timestamp: ts, lang: { name: 'python3' }, question: { titleSlug: slug }, lastTestcase: '', expectedOutput: '', codeOutput: '', runtimeError: '', compileError: '', totalCorrect: 70, totalTestcases: 70 }));
  }
}
fs.writeFileSync(path.join(OUT, 'solved.json'), JSON.stringify(solved)); fs.writeFileSync(path.join(OUT, 'attempted.json'), '[]');
fs.writeFileSync(path.join(OUT, 'submissions.json'), JSON.stringify(subs)); fs.writeFileSync(path.join(OUT, 'whoami.json'), JSON.stringify({ username: 'fixture' }));
fs.writeFileSync(path.join(OUT, 'profile.json'), '{}'); fs.writeFileSync(path.join(OUT, 'fixture-seed.json'), JSON.stringify(seedFile, null, 1));
console.log(`fixture: ${solved.length} problems, ${subs.length} submissions -> ${OUT}`);
