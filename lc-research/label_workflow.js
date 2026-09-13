export const meta = {
  name: 'lc-bug-locus-labeling',
  description: 'Label where the bug really was in each sampled failed LeetCode submission, two independent raters per item plus a tie-breaker, to measure the precision of the rule-based verdict buckets',
  phases: [
    { title: 'Label', detail: 'two independent raters per failed submission' },
    { title: 'Tie-break', detail: 'third rater only where the two disagree' },
  ],
}

// args: { items: [{file, bucket, submission_id, slug}], raters?: 2 }
const items = (args && args.items) || []
if (!items.length) throw new Error('pass args.items from analysis/labeling_index.json')

const LOCI = ['base_case', 'state_definition', 'transition_recurrence', 'answer_extraction_combine', 'index_bounds_off_by_one', 'visited_marking_or_revisit', 'wrong_technique', 'complexity_algorithmic', 'complexity_constant_factor', 'overflow_or_modulo', 'edge_input_handling', 'language_or_syntax', 'io_or_output_format', 'other', 'cannot_tell']
const TECH = ['dp_memo', 'dp_tabulation', 'greedy', 'brute_force', 'recursion_no_memo', 'bfs', 'dfs', 'dijkstra', 'union_find', 'topological_sort', 'binary_search', 'two_pointers_or_sliding_window', 'math', 'other', 'cannot_tell']

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    submission_id: { type: 'string' },
    bug_locus: { type: 'string', enum: LOCI },
    secondary_locus: { type: 'string', enum: LOCI.concat(['none']) },
    technique_first_attempt: { type: 'string', enum: TECH },
    fix_summary: { type: 'string', description: 'what actually changed between this attempt and the next one, in one or two sentences' },
    bucket_agrees: { type: 'boolean', description: 'does the rule-based bucket name the real class of failure?' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string', description: 'the specific line(s) or judge output that decided it' },
  },
  required: ['submission_id', 'bug_locus', 'technique_first_attempt', 'fix_summary', 'bucket_agrees', 'confidence', 'evidence'],
}

const GUIDE = `You are labelling ONE failed LeetCode submission to find out WHERE the bug actually was. Read the JSON file named below (Read tool). It contains: the problem statement excerpt, tags, the rule-based guess ("bucket"), the judge output (failing test case, expected vs actual output, error text), the submitted code, and when available the NEXT attempt's code and verdict. Read-only: do not modify any file.

Decide bug_locus from the CODE and the FIX, not from the shape of the failing input:
- base_case: the recursion/table initial values or the smallest-input handling were wrong or missing (e.g. dp[0], empty interval, n<=1), and the fix touched exactly that.
- state_definition: the DP state / what dist[] or visited[] means was wrong or missing a dimension.
- transition_recurrence: the state was right but the way it is computed from smaller states / neighbours was wrong.
- answer_extraction_combine: subproblems were right, the final aggregation / which cell to return was wrong.
- index_bounds_off_by_one: loop bounds, i-1 vs i, inclusive/exclusive, array size.
- visited_marking_or_revisit: graph traversal marks visited too late / never, or revisits nodes.
- wrong_technique: the whole approach was the wrong paradigm (greedy where DP needed, brute force, plain recursion without memo where memo needed) and the fix switched approach.
- complexity_algorithmic: correct answer but too slow because the algorithm class is wrong (TLE fixed by a different algorithm).
- complexity_constant_factor: same algorithm, fixed by removing redundant work (memo added to same recursion, list.pop(0), string concat, deep copies).
- overflow_or_modulo: integer overflow, missing or misplaced modulo.
- edge_input_handling: a special input (empty, single element, all equal, negative) handled wrongly while the core algorithm was right.
- language_or_syntax: compile error, wrong API, language semantics (integer division, mutable default).
- io_or_output_format: wrong output type/format.
- other / cannot_tell: use cannot_tell when the next attempt is missing and the code does not make it clear.

technique_first_attempt is the paradigm this submission used. bucket_agrees is true only if the rule-based bucket names the same CLASS of failure you found (wa_edge_empty and re_null_memo claim base_case/edge_input; wa_logic claims transition/state/combine/wrong_technique; tle claims complexity; re_index claims index_bounds; re_recursion claims missing base case or algorithmic depth; wa_bounds_overflow/wa_modulo claim overflow_or_modulo; ce claims language_or_syntax). Return raw structured data only.`

phase('Label')
const N = Number((args && args.raters) || 2)
log('Labelling ' + items.length + ' failed submissions with ' + N + ' raters each')
const labelled = await pipeline(
  items,
  it => parallel(Array.from({ length: N }, (_, r) => () => agent(
    GUIDE + '\n\nRater #' + (r + 1) + '. File to read: ' + it.file + '\nRule-based bucket guess: ' + it.bucket + '\nsubmission_id: ' + it.submission_id + '\nProblem slug: ' + it.slug,
    { label: 'label:' + it.bucket + ':' + it.submission_id + ':r' + (r + 1), phase: 'Label', schema: LABEL_SCHEMA }
  ))).then(vs => ({ item: it, votes: vs.filter(Boolean) })),
  async (res, it) => {
    const loci = res.votes.map(v => v.bug_locus)
    const agree = loci.length >= 2 && loci.every(l => l === loci[0])
    if (agree || loci.length < 2) return { ...res, final: res.votes[0] ? res.votes[0].bug_locus : null, agreement: agree, tiebreak: false }
    const tb = await agent(
      GUIDE + '\n\nYou are the TIE-BREAKER. Two raters disagreed: ' + loci.join(' vs ') + '. Their evidence: ' + res.votes.map(v => '[' + v.bug_locus + '] ' + v.evidence).join(' || ') + '\nFile to read: ' + it.file + '\nRule-based bucket guess: ' + it.bucket + '\nsubmission_id: ' + it.submission_id,
      { label: 'tiebreak:' + it.bucket + ':' + it.submission_id, phase: 'Tie-break', schema: LABEL_SCHEMA }
    )
    const all = tb ? res.votes.concat([tb]) : res.votes
    const counts = {}
    for (const v of all) counts[v.bug_locus] = (counts[v.bug_locus] || 0) + 1
    const final = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    return { ...res, votes: all, final, agreement: false, tiebreak: true }
  }
)
const clean = labelled.filter(Boolean)
log('Labelled ' + clean.length + '/' + items.length + '; tie-breaks: ' + clean.filter(x => x.tiebreak).length)
return clean.map(x => ({ submission_id: x.item.submission_id, bucket: x.item.bucket, slug: x.item.slug, final_locus: x.final, agreement: x.agreement, tiebreak: x.tiebreak, votes: x.votes.map(v => ({ locus: v.bug_locus, secondary: v.secondary_locus || 'none', technique: v.technique_first_attempt, bucket_agrees: v.bucket_agrees, confidence: v.confidence, fix: v.fix_summary, evidence: v.evidence })) }))
