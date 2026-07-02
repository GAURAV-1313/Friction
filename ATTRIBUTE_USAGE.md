# FRICTION — Complete Attribute Usage Guide

**Source:** Aiven Cloud (mysql-30da7675-gs1197418-6800.e.aivencloud.com)
**Dumped:** 2026-06-25 17:14:49
**Server Version:** MySQL 8.0.45
**Database:** defaultdb

---

## TABLE: `users`

| Column | Type | Constraints |
|--------|------|-------------|
| `user_id` | `char(36)` | PRIMARY KEY |
| `email` | `varchar(255)` | NOT NULL, UNIQUE |
| `name` | `varchar(255)` | NOT NULL |
| `google_sub` | `varchar(255)` | NOT NULL, UNIQUE |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |

### INSERT
- **`backend/src/routes/auth.js:132-135`** — `INSERT INTO users (user_id, email, name, google_sub) VALUES (?, ?, ?, ?)`
  - Called during Google OAuth login via `upsertUserFromGoogle()`
  - `user_id` is generated via `randomUUID()`
  - `google_sub` is the unique identity from Google OAuth

### UPDATE
- None. No explicit UPDATE statements anywhere in the codebase.

### SELECT/QUERY
- **`backend/src/routes/auth.js:126`** — `SELECT user_id FROM users WHERE google_sub = ?`
  - OAuth user lookup to check if user exists before insert
- **`backend/src/services/scheduler.js:11`** — `SELECT user_id FROM users`
  - Gets all user IDs for daily snapshot scheduling

### DELETE
- No explicit DELETE. `ON DELETE CASCADE` on child tables (`user_settings`, `buffer_moments`, `snapshots`, `candidate_findings`, `learning_records`) will cascade when a user is deleted from the DB directly.

### Business Logic
- `google_sub` is the unique identity from Google OAuth. If a user with the same `google_sub` exists, they are reused (line 126-128). A new `user_settings` row is created alongside the user on first login (line 137-140).
- `created_at` is purely informational; never read by application logic.

### NULL vs Populated
- All columns are NOT NULL. `google_sub` uniqueness ensures one user per Google account.

---

## TABLE: `user_settings`

| Column | Type | Constraints |
|--------|------|-------------|
| `user_id` | `char(36)` | PRIMARY KEY, FK → users(user_id) ON DELETE CASCADE |
| `output_language` | `enum('hinglish','english')` | NOT NULL DEFAULT 'hinglish' |
| `updated_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP |

### INSERT
- **`backend/src/routes/auth.js:137-140`** — `INSERT INTO user_settings (user_id, output_language) VALUES (?, ?) ON DUPLICATE KEY UPDATE output_language = output_language`
  - Created alongside user on first Google OAuth login
  - `output_language` is always set to `'hinglish'`

### UPDATE
- None. The `ON DUPLICATE KEY UPDATE` clause on INSERT is a no-op (sets to same value).

### SELECT/QUERY
- **`backend/src/services/snapshotRunner.js:34-38`** — `SELECT output_language FROM user_settings WHERE user_id = ? LIMIT 1`
  - Reads the user's preferred output language for LLM prompt generation
  - Falls back to `'hinglish'` if no row found

### DELETE
- `ON DELETE CASCADE` from `users` table.

### Business Logic
- `output_language` controls the language of LLM analysis output. In `llm.js:67`, the prompt includes `"Output language: English."` or `"Output language: Hinglish."` based on this value. This affects how findings and summaries are presented to the user.

### NULL vs Populated
- `output_language` is always populated (NOT NULL). No fallback edge case exists beyond the code-level default in `snapshotRunner.js:38`.

---

## TABLE: `prompts`

| Column | Type | Constraints |
|--------|------|-------------|
| `prompt_id` | `char(36)` | PRIMARY KEY |
| `name` | `varchar(255)` | NOT NULL |
| `body` | `text` | NOT NULL |
| `is_active` | `tinyint(1)` | NOT NULL DEFAULT 0 |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP |

### INSERT
- **`backend/src/routes/prompts.js:41-44`** — `INSERT INTO prompts (prompt_id, name, body, is_active) VALUES (UUID(), ?, ?, 1)`
  - Creates a new active prompt
  - `name` defaults to `'active'` if not provided

### UPDATE
- **`backend/src/routes/prompts.js:40`** — `UPDATE prompts SET is_active = 0 WHERE is_active = 1`
  - Deactivates the previous active prompt before inserting a new one
  - Enforces "only one active prompt at a time" at the application layer
- `updated_at` is auto-updated by MySQL `ON UPDATE CURRENT_TIMESTAMP`

### SELECT/QUERY
- **`backend/src/routes/prompts.js:10-11`** — `SELECT prompt_id, name, body, is_active, updated_at FROM prompts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1`
  - Gets the single active prompt
- **`backend/src/services/snapshotRunner.js:40-47`** — `SELECT body FROM prompts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1`
  - Reads the prompt body for LLM analysis
  - If no active prompt exists, snapshot processing returns `no_active_prompt`

### DELETE
- No DELETE statements. Old prompts are soft-deactivated via `is_active = 0`.

### Business Logic
- The `is_active` column implements a single-active-prompt pattern. When a new prompt is set, the old one is deactivated. The `body` column contains the full LLM system prompt that drives all finding analysis. If no active prompt exists, the entire snapshot pipeline halts.

### NULL vs Populated
- `name` and `body` are always NOT NULL. `is_active` is always 0 or 1.

---

## TABLE: `buffer_moments`

| Column | Type | Constraints |
|--------|------|-------------|
| `moment_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) ON DELETE CASCADE |
| `raw_text` | `mediumtext` | NOT NULL (upgraded from TEXT in migration 002) |
| `source_type` | `enum('highlight','bulk_paste')` | NOT NULL |
| `source_url` | `text` | NULL |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `status` | `enum('pending','processed')` | NOT NULL DEFAULT 'pending' |

### INSERT
- **`backend/src/routes/moments.js:46-49`** — `INSERT INTO buffer_moments (moment_id, user_id, raw_text, source_type, source_url, created_at, status) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), 'pending')`
  - User submits captured text via POST `/api/moments`
  - `moment_id` is `randomUUID()`
  - `status` is always `'pending'`
  - `source_url` can be NULL
  - `created_at` can be overridden by the client to maintain correct ordering when moments are captured out of order

### UPDATE
- **`backend/src/services/snapshotRunner.js:456-459`** — `UPDATE buffer_moments SET status = 'processed' WHERE user_id = ? AND moment_id IN (...)`
  - Marks moments as processed before deletion
  - This is a two-step soft state transition

### SELECT/QUERY
- **`backend/src/routes/moments.js:14-19`** — `SELECT moment_id, raw_text, source_type, source_url, created_at FROM buffer_moments WHERE user_id = ? ORDER BY created_at DESC`
  - Lists all moments for a user
- **`backend/src/services/snapshotRunner.js:20-24`** — `SELECT moment_id, raw_text, created_at FROM buffer_moments WHERE user_id = ? AND status = 'pending' ORDER BY created_at ASC`
  - Gets pending moments for snapshot processing, ordered oldest-first
- **`backend/src/services/scheduler.js:14-15`** — `SELECT COUNT(*) AS pending_count FROM buffer_moments WHERE user_id = ? AND status = 'pending'`
  - Checks if user has pending work before running scheduled snapshots

### DELETE
- **`backend/src/services/snapshotRunner.js:463-466`** — `DELETE FROM buffer_moments WHERE user_id = ? AND moment_id IN (...)`
  - Deletes processed moments after snapshot analysis

### Business Logic
- `status` is the core workflow state: `'pending'` → moments wait for snapshot processing → `'processed'` → moments are deleted. The two-step UPDATE then DELETE pattern in `markAndDeleteMoments()` ensures idempotency.
- `source_type` distinguishes between single-line highlights vs bulk pastes.
- `raw_text` is the core content that gets sent to the LLM for analysis. It is truncated to 5000 chars in `truncateMoment()` (`snapshotRunner.js:350-355`).

### NULL vs Populated
- `source_url` is NULL-able and typically NULL. It is read but not used in any business logic — it is only returned in the list endpoint.
- `status` is always populated.

---

## TABLE: `snapshots`

| Column | Type | Constraints |
|--------|------|-------------|
| `snapshot_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) ON DELETE CASCADE |
| `trigger_type` | `enum('manual','scheduled')` | NOT NULL |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `moment_count` | `int` | NOT NULL |

### INSERT
- **`backend/src/services/snapshotRunner.js:410-412`** — `INSERT INTO snapshots (snapshot_id, user_id, trigger_type, moment_count) VALUES (?, ?, ?, ?)`
  - Created inside `insertSnapshotAndFindings()` transaction
  - `snapshot_id` is `randomUUID()`
  - `trigger_type` is `'manual'` or `'scheduled'`

### UPDATE
- None.

### SELECT/QUERY
- **`backend/src/routes/findings.js:30`** — `LEFT JOIN snapshots s ON s.snapshot_id = f.snapshot_id`
  - Joins to get `s.created_at AS snapshot_created_at` for each finding
- No direct SELECT on snapshots table for filtering

### DELETE
- `ON DELETE CASCADE` from `candidate_findings` FK: `candidate_findings.snapshot_id REFERENCES snapshots.snapshot_id ON DELETE CASCADE`. When a snapshot is deleted, all its findings are cascade-deleted.

### Business Logic
- `trigger_type` distinguishes between user-initiated (`'manual'`) and cron-scheduled (`'scheduled'`) snapshots. This is purely metadata; no branching logic uses it.
- `moment_count` records how many moments were processed in this snapshot batch (batch size is capped at 30 via `MAX_BATCH_SIZE`).

### NULL vs Populated
- All columns are NOT NULL.

---

## TABLE: `snapshot_clusters` (no migration file)

| Column | Type | Constraints |
|--------|------|-------------|
| `cluster_id` | `char(36)` | PRIMARY KEY |
| `snapshot_id` | `char(36)` | NOT NULL, FK → snapshots(snapshot_id) |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) |
| `cluster_summary` | `text` | NULL |
| `moment_ids` | `json` | NOT NULL |
| `created_at` | `timestamp` | NULL DEFAULT CURRENT_TIMESTAMP |

### INSERT
- None found in any source file. This table has no migration file and no application code writes to it.

### UPDATE
- None.

### SELECT/QUERY
- None.

### DELETE
- None.

### Business Logic
- This table appears to be a planned/designed table for hierarchical/cluster-based snapshots but is **not yet implemented** in the application code. The clustering logic exists in `clustering.js` but operates on in-memory data structures, not this table.

### NULL vs Populated
- `cluster_summary` is NULL-able. `created_at` is NULL-able.

---

## TABLE: `domains`

| Column | Type | Constraints |
|--------|------|-------------|
| `domain_id` | `char(36)` | PRIMARY KEY |
| `name` | `varchar(255)` | NOT NULL, UNIQUE |
| `label` | `varchar(255)` | NOT NULL |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |

### INSERT
- **`db/006_add_domains_and_taxonomy.sql:47-51`** — `INSERT INTO domains (domain_id, name, label) VALUES (UUID(), 'misc', 'Misc'), (UUID(), 'dsa', 'Data Structures & Algorithms') ON DUPLICATE KEY UPDATE label = VALUES(label)`
  - Seed data for default domains

### UPDATE
- **`db/006_add_domains_and_taxonomy.sql:51`** — `ON DUPLICATE KEY UPDATE label = VALUES(label)`
  - Idempotent seed update

### SELECT/QUERY
- **`backend/src/services/subdomainResolver.js:60`** — `SELECT domain_id FROM domains WHERE name = ? LIMIT 1`
  - Resolves domain by name (case-insensitive via cache key)
- **`backend/src/services/subdomainResolver.js:66,72`** — `SELECT domain_id FROM domains WHERE name = 'misc' LIMIT 1`
  - Fallback to 'misc' domain when lookup fails
- **`backend/src/routes/findings.js:28`** — `LEFT JOIN domains d ON d.domain_id = f.domain_id`
  - Joins to return `d.name AS domain_name` and `d.label AS domain_label`

### DELETE
- `ON DELETE CASCADE` from `subdomains` FK. `ON DELETE SET NULL` from `candidate_findings` and `learning_records` FKs.

### Business Logic
- `name` is the lookup key (e.g., `'misc'`, `'dsa'`). `label` is a human-readable display name (e.g., `'Misc'`, `'Data Structures & Algorithms'`).
- Domain resolution uses an in-memory TTL cache (`TTLCache` in `subdomainResolver.js`). If a domain is not found, it falls back to `'misc'`.

### NULL vs Populated
- All columns are NOT NULL.

---

## TABLE: `subdomains`

| Column | Type | Constraints |
|--------|------|-------------|
| `subdomain_id` | `char(36)` | PRIMARY KEY |
| `domain_id` | `char(36)` | NOT NULL, FK → domains(domain_id) ON DELETE CASCADE |
| `name` | `varchar(255)` | NOT NULL |
| `slug` | `varchar(255)` | NOT NULL |
| `count_source` | `int` | NOT NULL DEFAULT 0 |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `embedding` | `json` | NULL |

### INSERT
- **`scripts/import_subdomains.js:56-61`** — `INSERT INTO subdomains (subdomain_id, domain_id, name, slug, count_source) VALUES (UUID(), ?, ?, ?, ?) ON DUPLICATE KEY UPDATE count_source = VALUES(count_source), name = VALUES(name)`
  - Bulk import of LeetCode tags
  - `subdomain_id` is UUID

### UPDATE
- **`scripts/import_subdomains.js:59`** — `ON DUPLICATE KEY UPDATE count_source = VALUES(count_source), name = VALUES(name)`
  - Updates count and name on duplicate slug+domain
- **`backend/src/services/subdomainResolver.js:88`** — `UPDATE subdomains SET embedding = ? WHERE subdomain_id = ?`
  - Stores generated embedding for a subdomain

### SELECT/QUERY
- **`backend/src/services/subdomainResolver.js:79-82`** — `SELECT subdomain_id, name FROM subdomains WHERE domain_id = ? AND embedding IS NULL LIMIT 50`
  - Finds subdomains needing embeddings
- **`backend/src/services/subdomainResolver.js:104-107`** — `SELECT subdomain_id, name, embedding FROM subdomains WHERE domain_id = ?`
  - Loads subdomains with embeddings for similarity matching

### DELETE
- `ON DELETE CASCADE` from `domains`. `ON DELETE SET NULL` from `candidate_findings` and `learning_records`.

### Business Logic
- `slug` is the unique key within a domain (unique constraint on `(domain_id, slug)`).
- `embedding` is used for vector similarity matching of topics to subdomains. In `resolveSubdomainId()` (`subdomainResolver.js:121-145`), the topic text is embedded and compared against all subdomain embeddings. A threshold of 0.82 (`SUBDOMAIN_SIM_THRESHOLD`) is required for a match. If no match exceeds the threshold, `subdomain_id` is returned as NULL.
- `count_source` tracks the number of problems associated with a tag (from LeetCode import). Not used in application logic.

### NULL vs Populated
- `embedding` is NULL until embeddings are generated (either via `ensureSubdomainEmbeddings()` or backfill scripts). When NULL, the subdomain is skipped in similarity matching.

---

## TABLE: `candidate_findings`

| Column | Type | Constraints |
|--------|------|-------------|
| `finding_id` | `char(36)` | PRIMARY KEY |
| `snapshot_id` | `char(36)` | NOT NULL, FK → snapshots(snapshot_id) ON DELETE CASCADE |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) ON DELETE CASCADE |
| `type` | `enum('gap','pattern','insight','confusion')` | NOT NULL |
| `topic` | `varchar(255)` | NOT NULL |
| `summary` | `text` | NOT NULL |
| `recall_anchor` | `text` | NULL |
| `confidence_ai` | `enum('high','medium','low')` | NOT NULL |
| `evidence_moment_ids` | `json` | NOT NULL |
| `state` | `enum('unreviewed','confirmed','deferred','rejected')` | NOT NULL DEFAULT 'unreviewed' |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `domain_id` | `char(36)` | NULL, FK → domains(domain_id) ON DELETE SET NULL |
| `subdomain_id` | `char(36)` | NULL, FK → subdomains(subdomain_id) ON DELETE SET NULL |
| `embedding` | `json` | NULL |
| `canonical_topic_id` | `char(36)` | NULL |

### INSERT
- **`backend/src/services/snapshotRunner.js:422-438`** — `INSERT INTO candidate_findings (finding_id, snapshot_id, user_id, type, topic, summary, recall_anchor, confidence_ai, evidence_moment_ids, state, domain_id, subdomain_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?, ?)`
  - Created during snapshot processing
  - `finding_id` is `randomUUID()`
  - `state` is always `'unreviewed'`
  - `recall_anchor` defaults to NULL
  - `domain_id` and `subdomain_id` are resolved via `resolveDomainAndSubdomain()`
  - `evidence_moment_ids` is JSON-serialized array

- **`backend/src/services/snapshotRunner.js:441-442`** — After INSERT, `embedAndStore()` is called to populate the `embedding` column

### UPDATE
- **`backend/src/services/snapshotRunner.js:441-442`** — `UPDATE candidate_findings SET embedding = ? WHERE finding_id = ?`
  - Stores embedding after finding creation

- **`backend/src/routes/findings.js:133-135`** — `UPDATE candidate_findings SET state = ? WHERE finding_id = ? AND user_id = ?`
  - State transitions: `'unreviewed'` → `'confirmed'`, `'deferred'`

- **`backend/src/routes/findings.js:139-141`** — When state becomes `'confirmed'`, `embedAndStore()` is called on the `candidate_findings` table (line 140) and `learning_records` table (line 141). **BUG:** line 141 references `createdRecordId` which is defined later at line 195 — this call at line 141 will pass `undefined` as the ID, likely causing the UPDATE to affect 0 rows or fail silently.

### SELECT/QUERY
- **`backend/src/routes/findings.js:25-38`** — `SELECT f.finding_id, f.snapshot_id, f.type, f.topic, f.summary, f.recall_anchor, f.confidence_ai, f.evidence_moment_ids, f.state, f.created_at, f.domain_id, f.subdomain_id, d.name AS domain_name, d.label AS domain_label, sd.name AS subdomain_name, s.created_at AS snapshot_created_at FROM candidate_findings f LEFT JOIN snapshots s ... LEFT JOIN domains d ... LEFT JOIN subdomains sd ... WHERE f.user_id = ? ${state ? 'AND f.state = ?' : ''} ORDER BY f.created_at DESC`
  - Lists findings with optional state filter

- **`backend/src/routes/findings.js:115-119`** — `SELECT finding_id, type, topic, summary, recall_anchor, state, domain_id, subdomain_id FROM candidate_findings WHERE finding_id = ? AND user_id = ? LIMIT 1`
  - Gets a single finding for decision handling

- **`backend/src/services/rag.js:31-33`** — `SELECT finding_id, topic, summary, recall_anchor, type, created_at, domain_id, subdomain_id, embedding FROM candidate_findings WHERE user_id = ? AND state = 'confirmed' AND embedding IS NOT NULL ORDER BY created_at DESC`
  - RAG retrieval for confirmed findings only

- **`backend/src/services/rag.js:115-117`** — Same query in `retrieveCombinedContext()`

- **`backend/src/routes/search.js:31-38`** — `SELECT finding_id as id, 'finding' as type, topic, summary, recall_anchor, type as item_type, created_at, state, confidence_ai, domain_id, subdomain_id, embedding FROM candidate_findings WHERE user_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC`
  - Search across all findings (not just confirmed) with embedding

- **`backend/src/routes/learningRecords.js:20`** — `LEFT JOIN candidate_findings cf ON cf.topic = lr.topic AND cf.state = 'confirmed' AND cf.user_id = lr.user_id`
  - Counts evidence findings per learning record

- **`backend/src/services/consolidation.js:9-17`** — `SELECT record_id, topic, summary, recall_anchor, type, occurrence_count, ignored_count, domain_id, subdomain_id, embedding, canonical_topic_id FROM learning_records WHERE user_id = ? AND record_id != ? AND domain_id = ? AND subdomain_id = ? AND embedding IS NOT NULL ORDER BY last_admitted_at DESC`
  - Finds consolidation candidates

### DELETE
- **`backend/src/routes/findings.js:63-65`** — `DELETE FROM candidate_findings WHERE finding_id = ? AND user_id = ? AND state = "confirmed"`
  - "Resolve" action: only confirmed findings can be resolved/deleted

- **`backend/src/routes/findings.js:86-89`** — `DELETE FROM candidate_findings WHERE finding_id = ? AND user_id = ? AND state IN ('unreviewed','deferred')`
  - Reject action: only unreviewed or deferred findings can be rejected

- **`ON DELETE CASCADE`** from `snapshots` table

### Business Logic
- `state` is the core workflow: `'unreviewed'` (default) → user can confirm, defer, or reject. `'confirmed'` → finding is merged into `learning_records`. `'deferred'` → temporarily skipped. `'rejected'` → discarded.

- `type` drives how findings are categorized: `'gap'` (learning gaps), `'pattern'` (recurring patterns), `'insight'` (new understanding), `'confusion'` (misunderstandings). The enum was modified from v1 (`'confusion','insight','fragile_understanding','pattern'`) to v2 (`'gap','pattern','insight'`) and back to v3 adding `'confusion'` again.

- `confidence_ai` is set by the LLM and used in reports to display confidence levels.

- `evidence_moment_ids` is a JSON array of moment IDs that support this finding. Used for traceability.

- `recall_anchor` is a short text hint for memory recall.

- When a finding is confirmed: (1) a new `learning_records` row is created or an existing one is updated (via `findBestTopicMatch` using Jaccard similarity), (2) `canonical_topic_id` is assigned if a canonical topic suggestion matches, (3) consolidation candidates are created if the new record is similar to existing records.

- `domain_id` and `subdomain_id` are resolved via embedding similarity (`SUBDOMAIN_SIM_THRESHOLD = 0.82`). If no subdomain match, `subdomain_id` is NULL but `domain_id` is always set (fallback to `'misc'`).

### NULL vs Populated
- `recall_anchor`: NULL when LLM doesn't generate one. Used in RAG context building and display.
- `domain_id`: NULL if domain resolution fails (rare, only if 'misc' domain doesn't exist).
- `subdomain_id`: NULL when no subdomain embedding matches the topic above threshold.
- `embedding`: NULL until generated. RAG and search queries explicitly filter `embedding IS NOT NULL`.
- `canonical_topic_id`: NULL until a canonical topic is suggested and assigned during confirmation.

---

## TABLE: `learning_records`

| Column | Type | Constraints |
|--------|------|-------------|
| `record_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) ON DELETE CASCADE |
| `type` | `enum('gap','pattern','insight','confusion')` | NOT NULL |
| `topic` | `varchar(255)` | NOT NULL |
| `summary` | `text` | NOT NULL |
| `recall_anchor` | `text` | NULL |
| `first_seen_at` | `timestamp` | NOT NULL |
| `last_admitted_at` | `timestamp` | NOT NULL |
| `occurrence_count` | `int` | NOT NULL |
| `ignored_count` | `int` | NOT NULL |
| `domain_id` | `char(36)` | NULL, FK → domains(domain_id) ON DELETE SET NULL |
| `subdomain_id` | `char(36)` | NULL, FK → subdomains(subdomain_id) ON DELETE SET NULL |
| `embedding` | `json` | NULL |
| `merged_at` | `timestamp` | NULL |
| `canonical_topic_id` | `char(36)` | NULL |
| `confidence_ai` | `enum('high','medium','low')` | NULL |

### INSERT
- **`backend/src/routes/findings.js:157-171`** — `INSERT INTO learning_records (record_id, user_id, type, topic, summary, recall_anchor, first_seen_at, last_admitted_at, occurrence_count, ignored_count, domain_id, subdomain_id, confidence_ai, canonical_topic_id) VALUES (UUID(), ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 0, ?, ?, ?, ?)`
  - Created when a finding is confirmed and no existing topic match is found
  - `record_id` is auto-generated via `UUID()`
  - `occurrence_count` starts at 1, `ignored_count` at 0
  - `first_seen_at` and `last_admitted_at` are both set to `CURRENT_TIMESTAMP`

### UPDATE
- **`backend/src/routes/findings.js:179-182`** — `UPDATE learning_records SET summary = ?, recall_anchor = ?, last_admitted_at = CURRENT_TIMESTAMP, occurrence_count = occurrence_count + 1 WHERE record_id = ?`
  - When a confirmed finding matches an existing record (via Jaccard similarity >= 0.8), the existing record is updated: summary appended, `last_admitted_at` refreshed, `occurrence_count` incremented

- **`backend/src/services/consolidation.js:92-97`** — `UPDATE learning_records SET topic = ?, summary = ?, occurrence_count = ?, last_admitted_at = CURRENT_TIMESTAMP, merged_at = CURRENT_TIMESTAMP WHERE record_id = ?`
  - During merge acceptance: source record's summary is appended to target, `occurrence_count` is summed, `last_admitted_at` is refreshed, `merged_at` is set

### SELECT/QUERY
- **`backend/src/routes/learningRecords.js:12-24`** — `SELECT lr.record_id, lr.type, lr.topic, lr.summary, lr.first_seen_at, lr.last_admitted_at, lr.occurrence_count, lr.ignored_count, lr.confidence_ai, lr.canonical_topic_id, lr.domain_id, lr.subdomain_id, lr.merged_at, ct.name as canonical_name, COUNT(cf.finding_id) as evidence_count FROM learning_records lr LEFT JOIN canonical_topics ct ON ct.topic_id = lr.canonical_topic_id LEFT JOIN candidate_findings cf ON cf.topic = lr.topic AND cf.state = 'confirmed' AND cf.user_id = lr.user_id WHERE lr.user_id = ? GROUP BY lr.record_id ORDER BY lr.last_admitted_at DESC`
  - Lists all learning records with canonical topic name and evidence count

- **`backend/src/routes/reports.js:14-21`** — `SELECT lr.*, ct.name as canonical_name, ct.topic_id as canonical_topic_id FROM learning_records lr LEFT JOIN canonical_topics ct ON ct.topic_id = lr.canonical_topic_id WHERE lr.user_id = ? ORDER BY lr.last_admitted_at DESC`
  - Report generation

- **`backend/src/routes/search.js:41-49`** — `SELECT record_id as id, 'record' as type, topic, summary, recall_anchor, type as item_type, first_seen_at, last_admitted_at, occurrence_count, ignored_count, domain_id, subdomain_id, embedding, canonical_topic_id FROM learning_records WHERE user_id = ? AND embedding IS NOT NULL ORDER BY last_admitted_at DESC`
  - Search query

- **`backend/src/routes/memory.js:25-31`** — `SELECT lr.*, ct.name as canonical_name FROM learning_records lr LEFT JOIN canonical_topics ct ON ct.topic_id = lr.canonical_topic_id WHERE lr.user_id = ? ORDER BY lr.last_admitted_at DESC`
  - Memory view

- **`backend/src/services/rag.js:73-75`** — `SELECT record_id, topic, summary, recall_anchor, type, first_seen_at, last_admitted_at, occurrence_count, domain_id, subdomain_id, embedding FROM learning_records WHERE user_id = ? AND embedding IS NOT NULL ORDER BY last_admitted_at DESC`
  - RAG retrieval

- **`backend/src/services/rag.js:120-122`** — Same in `retrieveCombinedContext()`

- **`backend/src/services/consolidation.js:10-17`** — `SELECT record_id, topic, summary, recall_anchor, type, occurrence_count, ignored_count, domain_id, subdomain_id, embedding, canonical_topic_id FROM learning_records WHERE user_id = ? AND record_id != ? AND domain_id = ? AND subdomain_id = ? AND embedding IS NOT NULL ORDER BY last_admitted_at DESC`
  - Consolidation candidate search

- **`backend/src/services/consolidation.js:76`** — `SELECT record_id, topic, summary, recall_anchor, occurrence_count, ignored_count, canonical_topic_id FROM learning_records WHERE record_id = ? AND user_id = ?`
  - Gets target record for merge

- **`backend/src/services/consolidation.js:130-136`** — `SELECT mc.*, lr_source.topic as source_topic, lr_target.topic as target_topic FROM merge_candidates mc JOIN learning_records lr_source ON lr_source.record_id = mc.source_record_id JOIN learning_records lr_target ON lr_target.record_id = mc.target_record_id WHERE mc.user_id = ? AND mc.status = 'pending' ORDER BY mc.created_at DESC`
  - Gets pending merges with topic info

- **`backend/src/routes/findings.js:144-148`** — `SELECT record_id, topic, domain_id, subdomain_id FROM learning_records WHERE user_id = ? AND type = ?`
  - Finds existing records of the same type for topic matching

- **`backend/src/routes/findings.js:191-193`** — `SELECT record_id FROM learning_records WHERE user_id = ? ORDER BY last_admitted_at DESC LIMIT 1`
  - Gets the most recently created record for consolidation candidate creation

### DELETE
- **`backend/src/services/consolidation.js:101`** — `DELETE FROM learning_records WHERE record_id = ?`
  - During merge acceptance, the source record is deleted (merged into target)

### Business Logic
- `type` mirrors `candidate_findings.type`: `'gap'`, `'pattern'`, `'insight'`, `'confusion'`.

- `occurrence_count` tracks how many times this topic has been encountered. Reports use `occurrence_count >= 2` for "high friction" gaps and `occurrence_count >= 3` for "repeated patterns."

- `ignored_count` tracks deferred occurrences. Reports flag records where `ignored_count > occurrence_count` as avoidance patterns.

- `first_seen_at` is set once at creation and never updated.

- `last_admitted_at` is refreshed every time the record is updated (new occurrence or merge). Used for sorting and recency analysis.

- `canonical_topic_id` links the record to a canonical topic. Used in reports, memory view, and search for grouping.

- `merged_at` is set when a record is merged into another during consolidation. After merge, the source record is deleted.

- `embedding` is used for RAG retrieval and consolidation candidate matching (cosine similarity >= 0.75 threshold).

### NULL vs Populated
- `recall_anchor`: NULL when not provided. Used in RAG context display.
- `domain_id` / `subdomain_id`: NULL if resolution fails. Used for filtering consolidation candidates.
- `embedding`: NULL until generated. RAG and search filter `embedding IS NOT NULL`.
- `canonical_topic_id`: NULL until assigned.
- `confidence_ai`: NULL when not explicitly set (though most findings from LLM do include it).
- `merged_at`: NULL until the record participates in a merge (as target).

---

## TABLE: `merge_candidates`

| Column | Type | Constraints |
|--------|------|-------------|
| `candidate_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) |
| `source_record_id` | `char(36)` | NOT NULL, FK → learning_records(record_id) |
| `target_record_id` | `char(36)` | NOT NULL, FK → learning_records(record_id) |
| `similarity` | `float` | NOT NULL |
| `status` | `enum('pending','accepted','rejected')` | NOT NULL DEFAULT 'pending' |
| `created_at` | `timestamp` | NULL DEFAULT CURRENT_TIMESTAMP |

### INSERT
- **`backend/src/services/consolidation.js:45-48`** — `INSERT INTO merge_candidates (candidate_id, user_id, source_record_id, target_record_id, similarity, status) VALUES (?, ?, ?, ?, ?, 'pending')`
  - Created during finding confirmation when consolidation candidates are found
  - `candidate_id` is `randomUUID()`
  - `similarity` is a float (0-1, rounded to 2 decimal places)

### UPDATE
- **`backend/src/services/consolidation.js:122-124`** — `UPDATE merge_candidates SET status = ? WHERE candidate_id = ? AND user_id = ?`
  - Sets status to `'rejected'` when user rejects a merge suggestion

- When a merge is **accepted**, the row is deleted (not updated)

### SELECT/QUERY
- **`backend/src/services/consolidation.js:36-39`** — `SELECT candidate_id FROM merge_candidates WHERE user_id = ? AND source_record_id = ? AND target_record_id = ? AND status = 'pending'`
  - Checks for existing pending merge before creating a new one (prevents duplicates)

- **`backend/src/services/consolidation.js:59-65`** — `SELECT mc.*, lr.topic as source_topic, lr.summary as source_summary, lr.occurrence_count as source_count, lr.canonical_topic_id as source_canonical_topic_id FROM merge_candidates mc JOIN learning_records lr ON lr.record_id = mc.source_record_id WHERE mc.candidate_id = ? AND mc.user_id = ? AND mc.status = 'pending'`
  - Gets merge candidate details for acceptance

- **`backend/src/services/consolidation.js:130-136`** — `SELECT mc.*, lr_source.topic as source_topic, lr_target.topic as target_topic FROM merge_candidates mc JOIN learning_records lr_source ... JOIN learning_records lr_target ... WHERE mc.user_id = ? AND mc.status = 'pending' ORDER BY mc.created_at DESC`
  - Lists pending merges

- **`backend/src/services/consolidation.js:143-145`** — `SELECT COUNT(*) as count FROM merge_candidates WHERE user_id = ? AND status = 'pending'`
  - Gets pending merge count

- **`backend/src/routes/reports.js:23-30`** — Same query as above, used in report generation

### DELETE
- **`backend/src/services/consolidation.js:105-107`** — `DELETE FROM merge_candidates WHERE candidate_id = ?`
  - Deleted after merge acceptance

### Business Logic
- `similarity` is computed via cosine similarity of embeddings (rounded to 2 decimal places). The threshold is `CONSOLIDATION_SIM_THRESHOLD = 0.75` (configurable via env).

- `status` drives the workflow: `'pending'` → user can accept or reject. `'accepted'` → row is deleted after merge. `'rejected'` → row is kept but marked.

- Duplicate prevention: before inserting, the code checks if a pending merge already exists for the same `(user_id, source_record_id, target_record_id)` tuple.

- During merge acceptance: source record's `topic` stays on target, `summary` is appended, `occurrence_count` is summed, `last_admitted_at` is refreshed, `merged_at` is set on target, and source record is deleted.

### NULL vs Populated
- All columns are NOT NULL except `created_at` which is NULL-able.

---

## TABLE: `canonical_topics`

| Column | Type | Constraints |
|--------|------|-------------|
| `topic_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) |
| `name` | `varchar(255)` | NOT NULL |
| `embedding` | `json` | NULL |
| `occurrence_count` | `int` | NOT NULL DEFAULT 0 |
| `created_at` | `timestamp` | NULL DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | `timestamp` | NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP |

### INSERT
- **`backend/src/services/canonicalTopics.js:71-73`** — `INSERT INTO canonical_topics (topic_id, user_id, name) VALUES (?, ?, ?)`
  - Created in `getOrCreateCanonicalTopic()` when no existing topic is found
  - `topic_id` is `randomUUID()`
  - `occurrence_count` starts at 0

- **`backend/src/services/canonicalTopics.js:151-154`** — `INSERT INTO canonical_topics (topic_id, user_id, name) VALUES (?, ?, ?)`
  - Created via `createCanonicalTopic()` (user-manual creation)

### UPDATE
- **`backend/src/services/canonicalTopics.js:126-128`** — `UPDATE canonical_topics SET occurrence_count = occurrence_count + 1, updated_at = CURRENT_TIMESTAMP WHERE topic_id = ?`
  - Incremented each time a learning record is linked to this canonical topic
  - `updated_at` is auto-updated by MySQL

### SELECT/QUERY
- **`backend/src/services/canonicalTopics.js:59-62`** — `SELECT topic_id, name, occurrence_count FROM canonical_topics WHERE user_id = ? AND name = ?`
  - Lookup in `getOrCreateCanonicalTopic()`

- **`backend/src/services/canonicalTopics.js:93-95`** — `SELECT topic_id, name, embedding, occurrence_count FROM canonical_topics WHERE user_id = ? AND embedding IS NOT NULL`
  - Suggests canonical topic via embedding similarity

- **`backend/src/services/canonicalTopics.js:138-140`** — `SELECT topic_id, name, occurrence_count, created_at, updated_at FROM canonical_topics WHERE user_id = ? ORDER BY occurrence_count DESC`
  - Lists all canonical topics for a user

- **`backend/src/routes/search.js:52-54`** — `SELECT topic_id, name FROM canonical_topics WHERE user_id = ?`
  - Loads canonical topics for matching in search results

- **`backend/src/routes/reports.js:33-39`** — `SELECT ct.*, COUNT(lr.record_id) as record_count FROM canonical_topics ct LEFT JOIN learning_records lr ON lr.canonical_topic_id = ct.topic_id AND lr.user_id = ? WHERE ct.user_id = ? GROUP BY ct.topic_id ORDER BY ct.occurrence_count DESC`
  - Report generation with record counts

- **`backend/src/routes/memory.js:13-21`** — `SELECT ct.topic_id, ct.name, ct.occurrence_count, ct.created_at, ct.updated_at, COUNT(lr.record_id) as record_count, COALESCE(SUM(lr.occurrence_count), 0) as total_occurrences FROM canonical_topics ct LEFT JOIN learning_records lr ON lr.canonical_topic_id = ct.topic_id AND lr.user_id = ? WHERE ct.user_id = ? GROUP BY ct.topic_id ORDER BY ct.occurrence_count DESC`
  - Memory view

### DELETE
- None.

### Business Logic
- `name` is unique per user (`uk_user_name (user_id, name)`). This prevents duplicate canonical topics with the same name for a user.

- `occurrence_count` is incremented whenever a learning record is linked to this canonical topic (via `updateTopicOccurrence()`).

- `embedding` is used for similarity-based topic suggestion. In `suggestCanonicalTopic()`, the raw topic text is embedded and compared against all canonical topic embeddings. A threshold of 0.8 (`CANONICAL_SIM_THRESHOLD`) is required.

- Canonical topics provide a layer of topic normalization: multiple variant topic names (e.g., "binary search", "binary_search", "BinarySearch") can be grouped under one canonical name.

### NULL vs Populated
- `embedding`: NULL until generated. Suggestion queries filter `embedding IS NOT NULL`.
- `created_at`: NULL-able.
- `occurrence_count`: Always >= 0 (NOT NULL DEFAULT 0).

---

## CROSS-TABLE RELATIONSHIPS AND DATA FLOW

### Primary Data Flow

```
1. User authenticates via Google OAuth
   → users + user_settings created

2. User captures text
   → buffer_moments inserted (status='pending')

3. Scheduled/manual trigger
   → snapshotRunner.js reads pending moments
   → fetches user_settings.output_language and prompts.body
   → calls LLM

4. LLM analysis
   → Findings mapped to candidate_findings (state='unreviewed')
   → snapshots inserted

5. User reviews
   → candidate_findings.state transitions:
     - confirm → learning_records created/updated
     - defer → finding stays deferred
     - reject → finding deleted
     - resolve → confirmed finding deleted

6. Consolidation
   → Similar learning_records get merge_candidates created
   → user accepts/rejects

7. Canonical topics
   → Topic suggestions link records to canonical_topics

8. Search/RAG
   → embedding columns on candidate_findings, learning_records,
     subdomains, canonical_topics enable vector similarity search
```

### Key Thresholds (Environment Variables)

| Variable | Default | Used By |
|----------|---------|---------|
| `CLUSTER_SIM_THRESHOLD` | 0.7 | `clustering.js` — moment clustering |
| `SUBDOMAIN_SIM_THRESHOLD` | 0.82 | `subdomainResolver.js` — subdomain matching |
| `CANONICAL_SIM_THRESHOLD` | 0.8 | `canonicalTopics.js` — canonical topic suggestion |
| `CONSOLIDATION_SIM_THRESHOLD` | 0.75 | `consolidation.js` — merge candidate detection |
| `RAG_SIM_THRESHOLD` | 0.65 | `rag.js` — RAG retrieval |
| `RAG_SEARCH_SIM_THRESHOLD` | 0.55 | `search.js` — search query |
| `TOPIC_SIM_THRESHOLD` | 0.8 | `findings.js` — topic matching for learning records |

### Tables Without Migration Files

- `snapshot_clusters` — Defined in schema but no migration file and no application code writes to it. Appears to be planned but not yet implemented.

### Tables with JSON Columns

| Table | Column | Purpose |
|-------|--------|---------|
| `snapshot_clusters` | `moment_ids` | Not used in code |
| `candidate_findings` | `evidence_moment_ids` | JSON array of moment IDs supporting a finding |
| `candidate_findings` | `embedding` | Vector embedding for RAG retrieval |
| `learning_records` | `embedding` | Vector embedding for RAG retrieval and consolidation |
| `subdomains` | `embedding` | Vector embedding for subdomain matching |
| `canonical_topics` | `embedding` | Vector embedding for canonical topic suggestion |

### Missing Indexes

- `canonical_topic_id` on `learning_records` and `candidate_findings` have no indexes, which will slow down deduplication queries. (Migration 009 adds indexes on `learning_records` but not on `candidate_findings`.)

### Notable Bugs

1. **`backend/src/routes/findings.js:141`** — `embedAndStore(connection, 'learning_records', 'record_id', createdRecordId, embeddingText)` references `createdRecordId` which is not defined until line 195. This call at line 141 will pass `undefined` as the ID, likely causing the UPDATE to affect 0 rows or fail silently.

2. **`canonical_topics.embedding`** — Column exists but no code ever generates or stores embeddings for canonical topics. `suggestCanonicalTopic()` always returns `null` because there are no rows with non-null embeddings to compare against.

3. **`subdomains.embedding`** — Column exists but embeddings are only generated via a separate backfill process, not during normal operation.

4. **`snapshot_clusters`** — Table exists but no migration file and no application code writes to it.
