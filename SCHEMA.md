# FRICTION — Deployed Database Schema
**Source:** Aiven Cloud (mysql-30da7675-gs1197418-6800.e.aivencloud.com)
**Dumped:** 2026-06-25 17:14:49
**Server Version:** MySQL 8.0.45
**Database:** defaultdb

---

## 1. users
| Column | Type | Constraints |
|--------|------|-------------|
| `user_id` | `char(36)` | PRIMARY KEY |
| `email` | `varchar(255)` | NOT NULL, UNIQUE |
| `name` | `varchar(255)` | NOT NULL |
| `google_sub` | `varchar(255)` | NOT NULL, UNIQUE |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |

**Indexes:**
- `PRIMARY KEY (user_id)`
- `uniq_users_google_sub (google_sub)`
- `uniq_users_email (email)`

**Charset:** `utf8mb4` / `utf8mb4_0900_ai_ci`

---

## 2. user_settings
| Column | Type | Constraints |
|--------|------|-------------|
| `user_id` | `char(36)` | PRIMARY KEY, FK → users(user_id) ON DELETE CASCADE |
| `output_language` | `enum('hinglish','english')` | NOT NULL DEFAULT 'hinglish' |
| `updated_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP |

**Indexes:**
- `PRIMARY KEY (user_id)`

---

## 3. prompts
| Column | Type | Constraints |
|--------|------|-------------|
| `prompt_id` | `char(36)` | PRIMARY KEY |
| `name` | `varchar(255)` | NOT NULL |
| `body` | `text` | NOT NULL |
| `is_active` | `tinyint(1)` | NOT NULL DEFAULT 0 |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP |

**Indexes:**
- `PRIMARY KEY (prompt_id)`

---

## 4. buffer_moments
| Column | Type | Constraints |
|--------|------|-------------|
| `moment_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) ON DELETE CASCADE |
| `raw_text` | `mediumtext` | NOT NULL |
| `source_type` | `enum('highlight','bulk_paste')` | NOT NULL |
| `source_url` | `text` | NULL |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `status` | `enum('pending','processed')` | NOT NULL DEFAULT 'pending' |

**Indexes:**
- `PRIMARY KEY (moment_id)`
- `idx_buffer_user_status_created (user_id, status, created_at)`

---

## 5. snapshots
| Column | Type | Constraints |
|--------|------|-------------|
| `snapshot_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) ON DELETE CASCADE |
| `trigger_type` | `enum('manual','scheduled')` | NOT NULL |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `moment_count` | `int` | NOT NULL |

**Indexes:**
- `PRIMARY KEY (snapshot_id)`
- `idx_snapshots_user_created (user_id, created_at)`

---

## 6. snapshot_clusters (no migration file)
| Column | Type | Constraints |
|--------|------|-------------|
| `cluster_id` | `char(36)` | PRIMARY KEY |
| `snapshot_id` | `char(36)` | NOT NULL, FK → snapshots(snapshot_id) |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) |
| `cluster_summary` | `text` | NULL |
| `moment_ids` | `json` | NOT NULL |
| `created_at` | `timestamp` | NULL DEFAULT CURRENT_TIMESTAMP |

**Indexes:**
- `PRIMARY KEY (cluster_id)`
- `idx_snapshot (snapshot_id)`
- `idx_user (user_id)`

**Charset:** `utf8mb4_unicode_ci` (different from rest of DB)

---

## 7. domains
| Column | Type | Constraints |
|--------|------|-------------|
| `domain_id` | `char(36)` | PRIMARY KEY |
| `name` | `varchar(255)` | NOT NULL, UNIQUE |
| `label` | `varchar(255)` | NOT NULL |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |

**Indexes:**
- `PRIMARY KEY (domain_id)`
- `uniq_domains_name (name)`

---

## 8. subdomains
| Column | Type | Constraints |
|--------|------|-------------|
| `subdomain_id` | `char(36)` | PRIMARY KEY |
| `domain_id` | `char(36)` | NOT NULL, FK → domains(domain_id) ON DELETE CASCADE |
| `name` | `varchar(255)` | NOT NULL |
| `slug` | `varchar(255)` | NOT NULL |
| `count_source` | `int` | NOT NULL DEFAULT 0 |
| `created_at` | `timestamp` | NOT NULL DEFAULT CURRENT_TIMESTAMP |
| `embedding` | `json` | NULL |

**Indexes:**
- `PRIMARY KEY (subdomain_id)`
- `uniq_subdomains_domain_slug (domain_id, slug)`
- `idx_subdomains_domain (domain_id)`

---

## 9. candidate_findings
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

**Indexes:**
- `PRIMARY KEY (finding_id)`
- `fk_candidate_findings_snapshot (snapshot_id)`
- `idx_findings_user_state_created (user_id, state, created_at)`
- `fk_candidate_findings_subdomain (subdomain_id)`
- `idx_candidate_findings_domain_subdomain (domain_id, subdomain_id)`

---

## 10. learning_records
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

**Indexes:**
- `PRIMARY KEY (record_id)`
- `idx_learning_records_user_type_last (user_id, type, last_admitted_at)`
- `fk_learning_records_subdomain (subdomain_id)`
- `idx_learning_records_domain_subdomain (domain_id, subdomain_id)`

---

## 11. merge_candidates
| Column | Type | Constraints |
|--------|------|-------------|
| `candidate_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) |
| `source_record_id` | `char(36)` | NOT NULL, FK → learning_records(record_id) |
| `target_record_id` | `char(36)` | NOT NULL, FK → learning_records(record_id) |
| `similarity` | `float` | NOT NULL |
| `status` | `enum('pending','accepted','rejected')` | NOT NULL DEFAULT 'pending' |
| `created_at` | `timestamp` | NULL DEFAULT CURRENT_TIMESTAMP |

**Indexes:**
- `PRIMARY KEY (candidate_id)`
- `idx_user_status (user_id, status)`
- `idx_source (source_record_id)`
- `idx_target (target_record_id)`

---

## 12. canonical_topics
| Column | Type | Constraints |
|--------|------|-------------|
| `topic_id` | `char(36)` | PRIMARY KEY |
| `user_id` | `char(36)` | NOT NULL, FK → users(user_id) |
| `name` | `varchar(255)` | NOT NULL |
| `embedding` | `json` | NULL |
| `occurrence_count` | `int` | NOT NULL DEFAULT 0 |
| `created_at` | `timestamp` | NULL DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | `timestamp` | NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP |

**Indexes:**
- `PRIMARY KEY (topic_id)`
- `uk_user_name (user_id, name)` — UNIQUE
- `idx_user_count (user_id, occurrence_count)`

---

## Summary

| Metric | Count |
|--------|-------|
| Total tables | 12 |
| Tables with JSON columns | 5 (`snapshot_clusters`, `candidate_findings`, `learning_records`, `subdomains`, `canonical_topics`) |
| Tables with embeddings | 4 (`subdomains`, `candidate_findings`, `learning_records`, `canonical_topics`) |
| Foreign key relationships | 18 |
| Total indexes (excl PK) | 19 |
| Default charset | `utf8mb4` / `utf8mb4_0900_ai_ci` |

## Notable Observations

1. **`snapshot_clusters`** — No migration file exists for this table. Used for hierarchical/cluster-based snapshots.

2. **`type` enum** — Both `candidate_findings` and `learning_records` have `'confusion'` in the enum (added back after migration 003 removed it).

3. **Embedding columns** — All embedding columns are `json DEFAULT NULL`. MySQL JSON columns cannot be directly indexed, so RAG queries use `embedding IS NOT NULL` which does a full table scan.

4. **Missing indexes** — `canonical_topic_id` on `learning_records` and `candidate_findings` have no indexes, which will slow down deduplication queries.

5. **`snapshot_clusters` charset mismatch** — Uses `utf8mb4_unicode_ci` while all other tables use `utf8mb4_0900_ai_ci`.
