# Recall backend (`backend/src/lc/`)

Separate Express app for the LeetCode tutor. Imports Friction's `db/pool.js`, `db/transaction.js`, `middleware/auth.js`
unchanged; never calls Friction's `createApp()`. Entrypoint: `node src/lc/index.js` (Railway). Tests: `npx jest tests/lc`.

Module contracts (all pure unless noted):

| module | exports |
|---|---|
| `domain/constants.js` | tag sets, `STATUS_BY_DISPLAY`, `BUCKET_TIERS`, `WINDOW_S`, `RECENT_N`, `ANCHOR_MIN_SCORE`, `MODEL_VERSION`, `WORD_CAPS`, `MAX_RUNG`, `DIFFICULTY_RANK` |
| `domain/seed.js` | `loadSeed()` → `{membership, subLabel, subFamily, canonical, catalogBySlug, subpatternsOf(slug), primarySub(slug), problemFromCatalog(slug), familiesOf(tags)}`; `familiesOf`, `normDiff` |
| `domain/buckets.js` | `statusOf(sub)`, `isEdgeShaped(tc)`, `bucketOf(sub, det)`, `tierOf(bucket)`, `detailsOf(det)` |
| `domain/attempts.js` | `buildAttempts(submissions, problemsBySlug, seed, {codeLookup})` → attempt[] (`slug,title,difficulty,tags,families,subpatterns,primary,n_submissions,first_ts,first_ac_ts,first_ac_id,attempts_to_ac,solved,fails_before_ac,fail_buckets,time_to_ac_s,fragile_flags,sequence[]`); `similarity`, `normalizeSubmission` |
| `domain/aggregate.js` | `aggregate(items)`, `baselines(solvedAttempts)` → `{lifetime_mean, recent_mean, recent_n, by_difficulty}`, `difficultyMatchedBaseline(items, base)`, `mean`, `median`, `r2` |
| `domain/skill.js` | `skillSummary(solvedAttempts, asOf)` → `{version, band, solved, counts, dp, graph, strengths, gaps, tag_levels, cold_start}`; `levelOf`, `familyLevel` |
| `domain/anchors.js` | `scoreAnchors({target:{slug,tags,difficulty}, solvedAttempts, asOf, seed, minScore, limit})` → `{anchors:[{slug,title,difficulty,score,why,subpattern,fine_tag,solved_on,attempts_to_ac,first_ac_submission_id}], omitted_reason}` |
| `domain/habits.js` | `computeHabits({attempts, asOf, seed})` → habit[] (`key,category,subpattern,bucket,tier,live,counts,evidence,statement_template`); `renderStatement(habit, lang, seed)`; `selectRelevantHabits(habits, targetSubIds, problem, {states})` ≤2 |
| `domain/policy.js` | `decideRung({requestedRung, planStated, submissionsHere, turns, lastFailAgeS, lastFailBucket, isContest, maxRungGlobal})` → contract `{locked, rung, max_rung, floor, diagnostic_focus, code_allowed, must_end_with_question, unlock_reason, allowed_rung_next}` |
| `domain/promptBuilder.js` | `buildPrompt(ctx)` → `{system, history, user}` (ctx shape below) |
| `domain/guard.js` | `guardReply(parsed, ctx)` → `{reply, anchors_used, habits_used, violations[], action: 'accept'|'retry'|'fallback', retry_instructions?}` |
| `domain/fallback.js` | `templatedReply(ctx)` → reply object (schema-valid) |
| `services/llm/index.js` | `createLlmClient(config, deps)` → `{provider, model, generate({system, history, user}) → {parsed, usage:{input_tokens,output_tokens,total_tokens}, provider, model, latency_ms, raw_text}}`; throws `LlmError{code}` |
| `services/llm/schema.js` | `REPLY_JSON_SCHEMA`, `GEMINI_RESPONSE_SCHEMA`, `validateReply(obj)` |
| `db/repo.js` | `profiles, consents, problems, solved, submissions, habits, sessions, messages, events, purgeUser, uuid, sha256` (every fn takes `db` first) |
| `services/*.js` | take `(pool, ...)`; use `withTransaction(pool, fn)` for multi-statement writes |
| `routes/*.js` | `makeRouter(deps)` → `express.Router()`; `deps = {pool, llm, config, seed, limiters}`; mounted under `/api/lc` behind `requireAuth` + pilot allowlist + `versionGate` (426 `update_required` when the `X-Recall-Version` header is below `LC_MIN_EXTENSION_VERSION`; no header → pass) |

Chat context (`ctx`) as built by `services/contextBuilder.js` and consumed by promptBuilder/guard (same shape as `tests/lc/fixtures/ctx.js`):
`{ language, consent_code, problem:{title, frontend_id, difficulty, family, tags, statement, constraints, leetcode_hints}, student:{band, solved, counts, dp, graph, strengths:string[] ('tag (n)')},
  anchors:[{slug, title, difficulty, why, solved_on, attempts_to_ac, code_excerpt|null}], habits:[{id, key, tier, statement}], verdict:{status, bucket, tier, lastTestcase, expected, got, error, passed}|null,
  plan:string|null, current_code:string|null, lang:string|null, contract:{rung, max_rung, diagnostic_focus, code_allowed, must_end_with_question}, history:[{role, text}], message:string,
  offered:{anchors:slug[], habits:key[]}, offered_titles_not_allowed:string[] (solved titles that were not offered; the guard rewrites them to "a classic problem") }`

Wire names the extension must use (backend is authoritative):
- `PUT /api/lc/problems/:slug` body: `statement_excerpt` / `constraints_text` (camelCase `statementExcerpt` / `constraintsText` also accepted); constraints keep one line per constraint.
- `POST /api/lc/chat` `plan`: chip keys `no_idea | have_plan_fails | too_slow | wrong_on_edge` (display labels are mapped too) or free text; `no_idea` states no plan.
- `GET /api/lc/anchors/:slug` `omitted_reason`: `null | 'no_eligible' | 'below_threshold'`.
- `POST /api/lc/client-events` `type` vocabulary read by `scripts/pilot_report.js`: `submit_seen`, `verdict_seen` (drift ratio), `sync_start`, `sync_done`, `sync_error`, `sync_paused` (sync stats), `token_expired`, `hint_timeout`, `banner_shown` (`payload.banner`), `issue_report` (`payload.text`), plus `queue_drop`, `main_not_ready`, `submit_timeout`, `capture_disabled`, `schema_drift`.
- `lc_skill_events` kind `sync` payload carries `phase` (`'finalize'`).
