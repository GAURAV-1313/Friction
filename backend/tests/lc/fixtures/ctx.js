'use strict';
// Synthetic chat contexts for promptBuilder / guard / fallback tests. Nothing here comes from a real student:
// the problem, anchors, habits, verdict, history and code are all invented for the tests.

const ANCHOR_CODE = [
  'class Solution {',
  'public:',
  '    // synthetic fixture: not real student code',
  '    int courier(int n, vector<vector<int>>& roads, int src, int dst) {',
  '        vector<vector<pair<int,int>>> adj(n);',
  '        for (auto& r : roads) {',
  '            adj[r[0]].push_back({r[1], r[2]});',
  '            adj[r[1]].push_back({r[0], r[2]});',
  '        }',
  '        vector<long long> best(n, LLONG_MAX);',
  '        priority_queue<pair<long long,int>, vector<pair<long long,int>>, greater<>> pq;',
  '        best[src] = 0;',
  '        pq.push({0, src});',
  '        while (!pq.empty()) {',
  '            auto [d, u] = pq.top(); pq.pop();',
  '            if (d > best[u]) continue;',
  '            for (auto [v, w] : adj[u]) {',
  '                if (best[u] + w < best[v]) {',
  '                    best[v] = best[u] + w;',
  '                    pq.push({best[v], v});',
  '                }',
  '            }',
  '        }',
  '        return best[dst] == LLONG_MAX ? -1 : (int)best[dst];',
  '    }',
  '};',
  ...Array.from({ length: 19 }, (_, i) => `// filler line ${i + 1} to exceed the 40-line excerpt cap`)
].join('\n');

const CURRENT_CODE = [
  'class Solution {',
  'public:',
  '    // synthetic fixture: greedy attempt that is wrong on purpose',
  '    int cheapest(int n, vector<vector<int>>& roads, int src, int dst) {',
  '        vector<int> cost(n, INT_MAX);',
  '        cost[src] = 0;',
  '        for (auto& r : roads) {',
  '            if (cost[r[0]] != INT_MAX) cost[r[1]] = min(cost[r[1]], cost[r[0]] + r[2]);',
  '        }',
  '        return cost[dst] == INT_MAX ? -1 : cost[dst];',
  '    }',
  '};',
  ...Array.from({ length: 150 }, (_, i) => `// padding line ${i + 1} so the file passes the 150-line cap`)
].join('\n');

const PROBLEM = {
  title: 'Cheapest Route Through Toll Roads',
  frontend_id: '9901',
  difficulty: 'Medium',
  family: 'graph',
  tags: ['graph', 'shortest-path', 'dijkstra', 'heap-priority-queue'],
  statement: 'You are given n towns numbered 0 to n-1 and a list of toll roads roads[i] = [a, b, toll] connecting town a and town b in both directions for the given toll. Return the smallest total toll to travel from town src to town dst, or -1 if no route exists.',
  constraints: ['1 <= n <= 10^4', '0 <= roads.length <= 10^5', '1 <= toll <= 10^6', 'src != dst'],
  leetcode_hints: [
    'Think of every town as a node and every toll road as a weighted edge between two nodes.',
    'Always expand the town with the smallest known total toll first, then update its neighbours.'
  ]
};

const DP_PROBLEM = {
  title: 'Largest Tile Sum On A Grid',
  frontend_id: '9902',
  difficulty: 'Medium',
  family: 'dp',
  tags: ['array', 'dynamic-programming', 'matrix'],
  statement: 'Given an m x n grid of tile values, start at the top-left tile and move only right or down. Return the largest possible sum of tile values along a path to the bottom-right tile.',
  constraints: ['1 <= m, n <= 200', '-1000 <= grid[i][j] <= 1000'],
  leetcode_hints: ['The best path into a tile can only arrive from the tile above it or the tile to its left.']
};

const ANCHORS = [
  { slug: 'minimum-cost-courier-route', title: 'Minimum Cost Courier Route', difficulty: 'medium', why: 'same idea: best-first search with a priority queue', solved_on: '2026-04-08', attempts_to_ac: 1, code_excerpt: ANCHOR_CODE },
  { slug: 'water-flow-through-pipes', title: 'Water Flow Through Pipes', difficulty: 'medium', why: 'same idea: expand the cheapest frontier node', solved_on: '2026-03-12', attempts_to_ac: 2, code_excerpt: ANCHOR_CODE },
  { slug: 'count-paths-in-a-weighted-maze', title: 'Count Paths In A Weighted Maze', difficulty: 'hard', why: 'shared fine tag: shortest-path', solved_on: '2026-01-30', attempts_to_ac: 3, code_excerpt: null },
  { slug: 'fourth-anchor-never-offered', title: 'Fourth Anchor Never Offered', difficulty: 'easy', why: 'over the limit of three', solved_on: '2025-12-01', attempts_to_ac: 1, code_excerpt: null }
];

const HABITS = [
  { id: 11, key: 'overflow', tier: 'high', statement: '5 of your 40 failed submissions were integer overflow or missing-modulo errors, 3 of them in the last 6 months.' },
  { id: 12, key: 'bucket:graph.bestfirst:wa_logic', tier: 'medium', statement: 'On best-first search problems, 4 of your 6 failures were a wrong answer on a normal case.' },
  { id: 13, key: 'gap:graph.bestfirst', tier: 'medium', statement: 'best-first search: 6 solved at 2.5 attempts on average versus your usual 1.4.' }
];

const VERDICT = {
  status: 'Wrong Answer',
  bucket: 'wa_logic',
  tier: 'medium',
  lastTestcase: '4\n[[0,1,5],[1,2,3],[0,2,9]]\n0\n2',
  expected: '8',
  got: '9',
  error: '',
  passed: '12/40'
};

const HISTORY = [
  { role: 'assistant', text: 'assistant turn 0 (should be dropped: history must start with the student)' },
  { role: 'user', text: 'user turn 1' },
  { role: 'assistant', text: 'assistant turn 2' },
  { role: 'user', text: 'user turn 3' },
  { role: 'assistant', text: 'assistant turn 4' },
  { role: 'user', text: 'user turn 5' },
  { role: 'assistant', text: 'assistant turn 6' },
  { role: 'user', text: 'user turn 7' },
  { role: 'assistant', text: 'assistant turn 8' },
  { role: 'user', text: 'user turn 9' },
  { role: 'assistant', text: 'assistant turn 10' },
  { role: 'user', text: 'user turn 11' },
  { role: 'assistant', text: 'assistant turn 12' }
];

const STUDENT = {
  band: 'intermediate',
  solved: 210,
  counts: { easy: 80, medium: 110, hard: 20 },
  dp: { level: 'developing', solved: 18, sample: ['Largest Tile Sum On A Grid'] },
  graph: { level: 'strong', solved: 41, sample: ['Minimum Cost Courier Route', 'Water Flow Through Pipes'] },
  strengths: ['binary-search (30)', 'two-pointers (22)']
};

function contractFor(rung) {
  return {
    rung,
    max_rung: rung,
    diagnostic_focus: rung >= 3 ? 'wa_logic' : null,
    code_allowed: rung === 4 ? 'blanked_pseudocode' : 'none',
    must_end_with_question: true
  };
}

/**
 * makeCtx({ rung, language, ...overrides }) -> a full synthetic ctx at that rung.
 * Anchors are the first three fixtures, habits the first two, verdict + code present from rung 3 upward.
 */
function makeCtx(overrides = {}) {
  const rung = overrides.rung || (overrides.contract && overrides.contract.rung) || 3;
  const base = {
    language: 'english',
    consent_code: true,
    problem: PROBLEM,
    student: STUDENT,
    anchors: ANCHORS.slice(0, 3),
    habits: HABITS.slice(0, 2),
    verdict: rung >= 3 ? VERDICT : null,
    plan: rung >= 2 ? 'Relax every road once in input order and keep the smallest cost per town.' : null,
    current_code: rung >= 3 ? CURRENT_CODE : null,
    lang: rung >= 3 ? 'cpp' : null,
    contract: contractFor(rung),
    history: HISTORY,
    message: 'My greedy pass gives 9 on the third test but the judge wants 8. What am I missing?'
  };
  const { rung: _r, contract, ...rest } = overrides;
  return { ...base, ...rest, contract: { ...base.contract, ...(contract || {}) } };
}

module.exports = { makeCtx, contractFor, PROBLEM, DP_PROBLEM, ANCHORS, HABITS, VERDICT, HISTORY, STUDENT, ANCHOR_CODE, CURRENT_CODE };
