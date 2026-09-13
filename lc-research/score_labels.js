#!/usr/bin/env node
'use strict';
// node score_labels.js labels.json  -> per-bucket precision of the rule-based verdict buckets
const fs = require('fs');
const labels = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const EXPECT = {
  wa_edge_empty: ['base_case', 'edge_input_handling'], re_null_memo: ['base_case', 'edge_input_handling', 'state_definition'],
  wa_logic: ['transition_recurrence', 'state_definition', 'answer_extraction_combine', 'wrong_technique'],
  wa_bounds_overflow: ['overflow_or_modulo', 'index_bounds_off_by_one'], wa_modulo: ['overflow_or_modulo'], re_overflow: ['overflow_or_modulo'],
  tle: ['complexity_algorithmic', 'complexity_constant_factor', 'wrong_technique'], re_recursion: ['base_case', 'complexity_algorithmic', 'state_definition'],
  re_index: ['index_bounds_off_by_one', 'edge_input_handling'], ce: ['language_or_syntax'], mle_state: ['state_definition', 'complexity_algorithmic'],
};
const BASE = new Set(['base_case', 'edge_input_handling']); const TRANS = new Set(['transition_recurrence', 'state_definition', 'answer_extraction_combine', 'wrong_technique']);
const by = {};
for (const l of labels) { (by[l.bucket] = by[l.bucket] || []).push(l); }
const rows = [];
for (const [b, xs] of Object.entries(by)) {
  const exp = EXPECT[b] || [];
  const hit = xs.filter((x) => exp.includes(x.final_locus)).length;
  const agree = xs.filter((x) => x.agreement).length;
  const loci = {}; for (const x of xs) loci[x.final_locus] = (loci[x.final_locus] || 0) + 1;
  rows.push({ bucket: b, n: xs.length, precision: xs.length ? Math.round(100 * hit / xs.length) / 100 : null, rater_agreement: xs.length ? Math.round(100 * agree / xs.length) / 100 : null, loci });
}
// the design's specific claim: base-case-shaped vs transition-shaped
const baseShaped = labels.filter((l) => ['wa_edge_empty', 're_null_memo'].includes(l.bucket));
const transShaped = labels.filter((l) => ['wa_logic', 'wa_bounds_overflow', 'wa_modulo', 're_index'].includes(l.bucket));
const split = {
  base_shaped_n: baseShaped.length, base_shaped_truly_base: baseShaped.filter((l) => BASE.has(l.final_locus)).length,
  transition_shaped_n: transShaped.length, transition_shaped_truly_transition: transShaped.filter((l) => TRANS.has(l.final_locus)).length,
};
const tech = {}; for (const l of labels) for (const v of l.votes) tech[v.technique] = (tech[v.technique] || 0) + 1;
console.log('| bucket | n | precision | rater agreement | actual loci |'); console.log('|---|---|---|---|---|');
for (const r of rows.sort((a, b) => b.n - a.n)) console.log(`| ${r.bucket} | ${r.n} | ${r.precision} | ${r.rater_agreement} | ${Object.entries(r.loci).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
console.log('\nbase-case-shaped buckets that were truly base-case/edge:', `${split.base_shaped_truly_base}/${split.base_shaped_n}`);
console.log('transition-shaped buckets that were truly transition/state/combine/technique:', `${split.transition_shaped_truly_transition}/${split.transition_shaped_n}`);
console.log('technique of first attempts (all votes):', tech);
fs.writeFileSync(process.argv[3] || 'label_scores.json', JSON.stringify({ rows, split, tech }, null, 1));
