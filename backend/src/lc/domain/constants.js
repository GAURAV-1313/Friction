'use strict';
// Tag vocabularies (LeetCode slugs). Fine-grained tags were observed live on 2026-09-11.
const DP_TAGS = new Set(['dynamic-programming', 'memoization', 'bitmask', 'game-theory', 'knapsack-problem', 'complete-knapsack', 'dp-on-trees', 'longest-increasing-subsequence', 'longest-common-subsequence', '0-1-knapsack', 'multiple-knapsack', 'mixed-knapsack', 'minimax-algorithm', 'zero-sum-game', 'impartial-game', 'sprague-grundy-theorem', 'combinatorics']);
const GRAPH_TAGS = new Set(['graph', 'breadth-first-search', 'depth-first-search', 'topological-sort', 'shortest-path', 'union-find', 'minimum-spanning-tree', 'strongly-connected-component', 'biconnected-component', 'eulerian-circuit', 'dijkstra', 'directed-acyclic-graph', 'bipartite-graph', 'graph-coloring', 'kosarajus-algorithm', 'tarjans-scc-algorithm', 'bellman-ford-algorithm', 'floyd-warshall-algorithm', 'prims-algorithm', 'kruskals-algorithm', 'boruvkas-algorithm', '0-1-bfs', 'bidirectional-search', 'a-search', 'heuristic-search', 'eulerian-path', 'eulerian-graph', 'semi-eulerian-graph', 'hamiltonian-path', 'articulation-point', 'bridge-graph', 'matching-graph', 'maximum-matching', 'flow-network', 'maximum-flow', 'k-shortest-path', 'lowest-common-ancestor', 'binary-lifting']);
// Structural algorithm tags: sharing one of these is an anchor-eligibility rule on its own.
const FINE_ALGO = new Set(['knapsack-problem', 'complete-knapsack', '0-1-knapsack', 'multiple-knapsack', 'mixed-knapsack', 'dp-on-trees', 'longest-increasing-subsequence', 'longest-common-subsequence', 'minimax-algorithm', 'zero-sum-game', 'bitmask', 'game-theory', 'memoization', 'dijkstra', 'topological-sort', 'directed-acyclic-graph', 'union-find', 'bipartite-graph', 'graph-coloring', 'kosarajus-algorithm', 'tarjans-scc-algorithm', 'strongly-connected-component', 'bellman-ford-algorithm', 'floyd-warshall-algorithm', 'shortest-path', 'minimum-spanning-tree', 'prims-algorithm', 'kruskals-algorithm', '0-1-bfs', 'bidirectional-search', 'eulerian-path', 'eulerian-circuit', 'hamiltonian-path', 'articulation-point', 'bridge-graph', 'biconnected-component']);
// Umbrella tags never count as "specific" overlap.
const UMBRELLA = new Set(['array', 'string', 'hash-table', 'math', 'sorting', 'dynamic-programming', 'graph', 'depth-first-search', 'breadth-first-search', 'matrix', 'tree', 'binary-tree', 'greedy', 'simulation', 'two-pointers', 'memoization']);

const STATUS_BY_DISPLAY = { 'Accepted': 10, 'Wrong Answer': 11, 'Memory Limit Exceeded': 12, 'Output Limit Exceeded': 13, 'Time Limit Exceeded': 14, 'Runtime Error': 15, 'Internal Error': 16, 'Compile Error': 20, 'Unknown Error': 21 };

const BASE_CASE_SHAPED = new Set(['wa_edge_empty', 're_null_memo']);
const TRANSITION_SHAPED = new Set(['wa_logic', 'wa_bounds_overflow', 'wa_modulo', 're_index']);
const OVERFLOW_SHAPED = new Set(['re_overflow', 'wa_bounds_overflow', 'wa_modulo']);

// Precision tiers measured on 86 double-rated real failures (calibration report, 2026-09-11).
const BUCKET_TIERS = { re_overflow: 'high', re_null_memo: 'high', tle: 'high', wa_logic: 'medium', wa_modulo: 'medium', wa_edge_empty: 'medium', re_index: 'medium', mle_state: 'low' };

const WINDOW_S = 180 * 86400;      // "live" habit window
const RECENT_N = 100;              // trailing-window baseline
const ANCHOR_MIN_SCORE = 3;        // below this, offer no anchor
const MODEL_VERSION = 'lc-model-v1';
const WORD_CAPS = { 1: 90, 2: 160, 3: 200, 4: 260 };
const MAX_RUNG = 4;
const DIFFICULTY_RANK = { easy: 0, medium: 1, hard: 2 };
const FAMILY_LABEL = { dp: 'dynamic programming', graph: 'graphs' };

module.exports = { DP_TAGS, GRAPH_TAGS, FINE_ALGO, UMBRELLA, STATUS_BY_DISPLAY, BASE_CASE_SHAPED, TRANSITION_SHAPED, OVERFLOW_SHAPED, BUCKET_TIERS, WINDOW_S, RECENT_N, ANCHOR_MIN_SCORE, MODEL_VERSION, WORD_CAPS, MAX_RUNG, DIFFICULTY_RANK, FAMILY_LABEL };
