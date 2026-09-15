export const meta = {
  name: 'anchor-productize-plan',
  description: 'Turn the calibrated Recall tutor design into an efficient, deterministic, production-ready build plan shaped as a product',
  phases: [
    { title: 'Plan', detail: 'three planners: determinism, ops/cost, product' },
    { title: 'Judge', detail: 'three judges score the plans' },
    { title: 'Synthesize', detail: 'one build plan' },
    { title: 'Verify', detail: 'adversarial check of load-bearing claims' },
  ],
}

// args: { docs: {design, habits, calibration, analyzer, repo} }  absolute paths the agents must Read
const D = (args && args.docs) || {}
if (!D.design || !D.habits || !D.calibration) throw new Error('pass args.docs with design, habits, calibration paths')

const READ = `READ THESE FILES FIRST (Read tool; read-only, never modify anything):
1. Product design: ${D.design}
2. Habit-intelligence design: ${D.habits}
3. Calibration report from a real LeetCode account (a few hundred solved problems): ${D.calibration}
4. Reference implementation of the rule layer that produced the calibration (pure Node, no DB): ${D.analyzer}
5. The Friction repo (existing product that must NOT be modified; the tutor reuses its auth/db/Gemini infra): ${D.repo} — skim backend/src/app.js, backend/src/db/pool.js, backend/src/middleware/auth.js, backend/src/services/llm.js, extension/manifest.json only.
Also available: ${D.seed} (30 structural sub-patterns, 535 verified problems) and ${D.catalog} (full LeetCode catalogue, 4047 problems, 175 tags incl. fine-grained algorithm tags).`

const CONTEXT = `PRODUCT: "Recall", a Chrome extension tutor for leetcode.com that builds a model of a student's level and habits from their real submission history and gives Hinglish/English hints anchored to problems they already solved. Separate extension directory + separate backend module under the existing Friction repo; nothing in the existing Friction extension, routes, web app or tables may be modified. Test cohort: students with hundreds to thousands of solved problems. No Gemini key is needed for offline calibration (Claude agents label), but the production hint path uses gemini-2.5-flash with thinkingBudget:0.

WHAT THE CALIBRATION CHANGED (must be reflected in any plan):
- Runtime percentile is NOT a brute-force signal; the flat 0.3x fragile-AC discount keyed on it is dead. Only "AC minutes after a TLE with near-identical code" survives, plus a later code-based approach check.
- Habits go stale: the Kadane weak spot crossed every threshold but came from the student's first two months. Recency weighting and auto-demotion on a clean streak are mandatory, and the baseline must be a recent window, not lifetime.
- A live habit (C++ signed-integer overflow, 13% of all failures, mostly in the last 3 months) was invisible to the original taxonomy; verdict buckets must be extensible and language-aware.
- LeetCode's similarQuestions links cross sub-patterns often (44 cases on one account) and those crossings are misleading analogies; they are a candidate generator only. Seed sub-pattern match or a shared fine-grained LeetCode tag gates anchors.
- LeetCode now has 175 tags including fine-grained algorithm tags (dijkstra, 0-1-knapsack, dp-on-trees, ...) covering ~30% of DP/graph problems; the 535-problem seed covers ~45%; together ~55-60%.
- The rule layer already exists as pure, DB-free JavaScript (analyze.js) and produced correct results on real data; it should be ported, not rewritten.
- The labeling precision per verdict bucket is in section 4 of the calibration report; buckets below a precision floor must not auto-trust.

THE OWNER'S ASK, verbatim intent: "plan out how to make this pipeline efficient and prod ready and deterministic, so as to shape this as a product."`

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    angle: { type: 'string' },
    one_liner: { type: 'string' },
    pipeline: { type: 'string', description: 'the end-to-end production pipeline as numbered stages, each stage tagged deterministic|llm|external, with where it runs (extension / api / batch) and its inputs and outputs' },
    determinism: { type: 'string', description: 'exactly which computations are pure functions of stored data, how LLM outputs are constrained (schema, temperature, caching, replay), what is versioned, how a result can be reproduced from the event log' },
    efficiency: { type: 'string', description: 'request budgets per student action, caching layers, batch cadence, LLM tokens and cost per active student per month, DB indexes, cold-start handling' },
    prod_readiness: { type: 'string', description: 'tests (incl. using the real export as fixtures), migrations, observability, kill switches, privacy/consent/deletion, LeetCode-drift detection, deployment topology, rollout plan' },
    product_shape: { type: 'string', description: 'what the student sees and does: first run, the map, anchors, hints, habits; what is cut from v1; success metrics' },
    build_order: { type: 'array', items: { type: 'object', properties: { milestone: { type: 'string' }, deliverable: { type: 'string' }, acceptance: { type: 'string' }, days: { type: 'number' } }, required: ['milestone', 'deliverable', 'acceptance'] } },
    risks: { type: 'array', items: { type: 'string' } },
    key_claims: { type: 'array', items: { type: 'string' } },
  },
  required: ['angle', 'one_liner', 'pipeline', 'determinism', 'efficiency', 'prod_readiness', 'product_shape', 'build_order', 'risks', 'key_claims'],
}
const JUDGE_SCHEMA = { type: 'object', properties: { scores: { type: 'array', items: { type: 'object', properties: { angle: { type: 'string' }, score: { type: 'number' }, strengths: { type: 'array', items: { type: 'string' } }, weaknesses: { type: 'array', items: { type: 'string' } } }, required: ['angle', 'score'] } }, winner: { type: 'string' }, ideas_to_graft: { type: 'array', items: { type: 'string' } } }, required: ['scores', 'winner', 'ideas_to_graft'] }
const SYNTH_SCHEMA = { ...PLAN_SCHEMA, properties: { ...PLAN_SCHEMA.properties, cut_from_v1: { type: 'array', items: { type: 'string' } }, claims_to_verify: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, why_it_matters: { type: 'string' } }, required: ['claim', 'why_it_matters'] } } }, required: [...PLAN_SCHEMA.required.filter(k => k !== 'angle' && k !== 'key_claims'), 'cut_from_v1', 'claims_to_verify'] }
const VERDICT_SCHEMA = { type: 'object', properties: { claim: { type: 'string' }, refuted: { type: 'boolean' }, reasoning: { type: 'string' }, correction: { type: 'string' } }, required: ['claim', 'refuted', 'reasoning'] }

const angles = [
  { key: 'determinism', brief: 'DETERMINISM & CORRECTNESS FIRST: every number a student sees must be reproducible from the event log by a pure function with a version stamp. Minimise LLM surface: LLM only words things, never decides trust, anchors, rungs, or mastery. Specify schemas, temperature, caching keyed on content hashes, replay tooling, golden-file tests built from the real export.' },
  { key: 'ops-cost', brief: 'OPERATIONS & COST FIRST: a solo developer runs this for a cohort of a few hundred students on Render + Aiven + Gemini. Specify request budgets, batch cadence, cost per student per month with arithmetic, caching (problem cache, catalogue snapshot shipped with the backend, seed as a data file), indexes, cold-start and rate-limit handling, kill switches, drift alarms, the deployment topology decision (separate Render workspace vs one added route), and a rollout plan with a single pilot user as the canary.' },
  { key: 'product', brief: 'PRODUCT SHAPE FIRST: what a student experiences in the first five minutes and the first week, what the side panel shows, how a habit is surfaced without being presumptuous, what is deliberately cut from v1, how success is measured (AC on the next problem of the same pattern without hints), and how the Hinglish voice stays consistent. Still respect determinism and the no-modify constraint.' },
]

phase('Plan')
log('Three planners reading the design docs, the calibration report, and the reference rule layer')
const plans = (await parallel(angles.map(a => () => agent(
  READ + '\n\n' + CONTEXT + '\n\nYOUR ANGLE: ' + a.brief + '\n\nProduce a complete production plan. Be concrete: name files under extension-leetcode/ and backend/src/lc/, tables, env flags, cadences, budgets, and tests. Ground every claim in the docs you read; cite the calibration numbers where they change a decision. End with 5-7 key_claims a skeptic could try to refute. Return raw structured data only.',
  { label: 'plan:' + a.key, phase: 'Plan', schema: PLAN_SCHEMA }
)))).filter(Boolean)
log('Plans: ' + plans.map(p => p.angle).join(' | '))

phase('Judge')
const lenses = [
  'DETERMINISM & REPRODUCIBILITY: could a second engineer recompute every shown number from the event log and get the same answer? Is the LLM boxed in tightly enough?',
  'BUILDABILITY & COST: could one developer ship this in the stated milestones, and does the cost arithmetic for a few hundred students hold?',
  'STUDENT VALUE & HONESTY: does the product tell the truth about what it knows (stale habits, weak buckets, no anchor), and would a student keep using it?',
]
const judgements = (await parallel(lenses.map((lens, i) => () => agent(
  CONTEXT + '\n\nYou are judge #' + (i + 1) + '. Score each plan 1-10 through this lens: ' + lens + '\nName a winner and the best ideas to graft from the others. Be specific.\n\nPLANS:\n' + JSON.stringify(plans, null, 1),
  { label: 'judge:' + (i + 1), phase: 'Judge', schema: JUDGE_SCHEMA }
)))).filter(Boolean)
const totals = {}
for (const j of judgements) for (const s of j.scores) totals[s.angle] = (totals[s.angle] || 0) + s.score
const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1])
log('Judge totals: ' + ranked.map(([k, v]) => k + '=' + v).join(', '))

phase('Synthesize')
const synth = await agent(
  READ + '\n\n' + CONTEXT + '\n\nYou are the synthesizer. Judge totals: ' + JSON.stringify(totals) + '. Produce ONE final production plan starting from the winner and grafting the judges\' flagged ideas. It must be concrete enough to start building tomorrow: pipeline stages with determinism tags, file-level layout, the exact pure functions to port from analyze.js and their test fixtures from the real export, LLM contracts, budgets with arithmetic, tests, observability, rollout, and a milestone list with acceptance criteria. List what is cut from v1. End with 5-7 claims_to_verify.\n\nJUDGEMENTS:\n' + JSON.stringify(judgements, null, 1) + '\n\nPLANS:\n' + JSON.stringify(plans, null, 1),
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, effort: 'high' }
)

phase('Verify')
const claims = (synth && synth.claims_to_verify ? synth.claims_to_verify : []).slice(0, 6)
const vlenses = [
  { name: 'technical', prompt: 'TECHNICAL lens. Check against the repo files, the reference analyzer, Chrome MV3 / Gemini SDK / Render / Aiven facts (use WebSearch/WebFetch via ToolSearch "select:WebSearch,WebFetch" if it settles something).' },
  { name: 'ops', prompt: 'OPERATIONS & COST lens. Redo the arithmetic; look for hidden per-turn costs, rate-limit exposure, and single points of failure.' },
]
const verdicts = await pipeline(
  claims,
  c => parallel(vlenses.map(l => () => agent(
    READ + '\n\nYou are a skeptic. ' + l.prompt + '\n\nTry hard to REFUTE this claim: "' + c.claim + '"\nWhy it matters: ' + c.why_it_matters + '\nIf uncertain, default to refuted=true and say what would settle it. If mostly right but needs a fix, set refuted=false and put the fix in `correction`. Read-only.',
    { label: 'verify:' + l.name, phase: 'Verify', schema: VERDICT_SCHEMA }
  ))).then(vs => { const valid = vs.filter(Boolean); return { claim: c.claim, refuted: valid.filter(v => v.refuted).length >= 2 || (valid.length === 1 && valid[0].refuted), votes: valid.map((v, i) => ({ lens: vlenses[i] ? vlenses[i].name : '?', refuted: v.refuted, reasoning: v.reasoning, correction: v.correction || '' })) } })
)
log('Verify: ' + verdicts.filter(Boolean).filter(v => v.refuted).length + ' of ' + verdicts.filter(Boolean).length + ' refuted')
return { plans, judgements, totals, synth, verdicts: verdicts.filter(Boolean) }
