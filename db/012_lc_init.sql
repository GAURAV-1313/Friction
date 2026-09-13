-- Anchor (LeetCode tutor) schema, additive only. Nothing in Friction's tables is touched.
-- lc:expect-users-collation utf8mb4_0900_ai_ci
-- Every lc_ table declares the collation of users.user_id explicitly so FKs never hit errno 3780.

CREATE TABLE IF NOT EXISTS lc_schema_migrations (
  name VARCHAR(64) PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by VARCHAR(128) NULL,
  server_version VARCHAR(64) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_profiles (
  user_id CHAR(36) NOT NULL,
  leetcode_username VARCHAR(64) NULL,
  language ENUM('english','hinglish') NOT NULL DEFAULT 'english',
  consent_code TINYINT(1) NOT NULL DEFAULT 0,
  consent_at TIMESTAMP NULL,
  sync_status ENUM('never','partial','complete') NOT NULL DEFAULT 'never',
  sync_progress JSON NULL,
  last_synced_at TIMESTAMP NULL,
  skill_summary JSON NULL,
  model_version VARCHAR(32) NULL,
  hints_day DATE NULL,
  hints_today INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_lc_profiles_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_consents (
  user_id CHAR(36) NOT NULL,
  version VARCHAR(16) NOT NULL,
  accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, version),
  CONSTRAINT fk_lc_consents_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Shared problem cache. No user FK: the cache must survive a user's deletion.
CREATE TABLE IF NOT EXISTS lc_problems (
  slug VARCHAR(191) NOT NULL,
  title VARCHAR(255) NOT NULL,
  frontend_id VARCHAR(16) NULL,
  question_id VARCHAR(16) NULL,
  difficulty ENUM('easy','medium','hard') NULL,
  topic_tags JSON NULL,
  similar_slugs JSON NULL,
  hints JSON NULL,
  statement_excerpt TEXT NULL,
  constraints_text VARCHAR(1000) NULL,
  is_paid TINYINT(1) NOT NULL DEFAULT 0,
  first_writer_user_id CHAR(36) NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_solved (
  user_id CHAR(36) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  title VARCHAR(255) NULL,
  difficulty ENUM('easy','medium','hard') NULL,
  tags JSON NULL,
  source ENUM('sync','attempt') NOT NULL DEFAULT 'sync',
  solved_at TIMESTAMP NULL,
  first_ac_ts INT UNSIGNED NULL,
  first_ac_submission_id BIGINT NULL,
  attempts_to_ac INT NULL,
  fails_before_ac INT NULL,
  assisted TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, slug),
  KEY idx_lc_solved_user_ac (user_id, first_ac_ts),
  CONSTRAINT fk_lc_solved_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_submissions (
  user_id CHAR(36) NOT NULL,
  lc_submission_id BIGINT NOT NULL,
  slug VARCHAR(191) NOT NULL,
  status_code TINYINT NULL,
  status_msg VARCHAR(64) NULL,
  verdict_bucket VARCHAR(32) NULL,
  lang VARCHAR(32) NULL,
  ts INT UNSIGNED NOT NULL,
  runtime_percentile DECIMAL(6,3) NULL,
  last_testcase TEXT NULL,
  expected_output TEXT NULL,
  code_output TEXT NULL,
  error_text TEXT NULL,
  total_correct INT NULL,
  total_testcases INT NULL,
  has_details TINYINT(1) NOT NULL DEFAULT 0,
  code MEDIUMTEXT NULL,
  code_hash CHAR(64) NULL,
  captured_via ENUM('sync','interceptor','manual') NOT NULL DEFAULT 'sync',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, lc_submission_id),
  KEY idx_lc_submissions_user_ts (user_id, ts),
  KEY idx_lc_submissions_user_slug_ts (user_id, slug, ts),
  CONSTRAINT fk_lc_submissions_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_skill_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) NOT NULL,
  kind ENUM('sync','attempt','recompute','habit_feedback','profile','delete') NOT NULL,
  payload JSON NULL,
  model_version VARCHAR(32) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lc_skill_events_user (user_id, created_at),
  CONSTRAINT fk_lc_skill_events_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_habits (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) NOT NULL,
  habit_key VARCHAR(96) NOT NULL,
  category ENUM('overflow','gap','bucket') NOT NULL,
  subpattern VARCHAR(64) NULL,
  bucket VARCHAR(32) NULL,
  tier ENUM('high','medium','low') NOT NULL,
  live TINYINT(1) NOT NULL DEFAULT 0,
  counts JSON NULL,
  evidence JSON NULL,
  state ENUM('auto','confirmed','dismissed','stale') NOT NULL DEFAULT 'auto',
  reaction ENUM('confirmed','dismissed') NULL,
  reaction_at TIMESTAMP NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lc_habits_user_key (user_id, habit_key),
  KEY idx_lc_habits_user_live (user_id, live, state),
  CONSTRAINT fk_lc_habits_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_chat_sessions (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  plan_text VARCHAR(500) NULL,
  turn_count INT NOT NULL DEFAULT 0,
  max_rung TINYINT NOT NULL DEFAULT 0,
  is_contest TINYINT(1) NOT NULL DEFAULT 0,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lc_sessions_user_slug (user_id, slug),
  CONSTRAINT fk_lc_sessions_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_chat_messages (
  id CHAR(36) NOT NULL,
  session_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role ENUM('user','assistant') NOT NULL,
  content TEXT NOT NULL,
  rung TINYINT NULL,
  anchors JSON NULL,
  habits JSON NULL,
  contract JSON NULL,
  usage_json JSON NULL,
  guard_json JSON NULL,
  provider VARCHAR(16) NULL,
  model VARCHAR(64) NULL,
  degraded TINYINT(1) NOT NULL DEFAULT 0,
  feedback_thumb ENUM('up','down') NULL,
  feedback_reason ENUM('helped','too_much','too_little','wrong') NULL,
  feedback_note VARCHAR(500) NULL,
  feedback_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lc_messages_session (session_id, created_at),
  KEY idx_lc_messages_user (user_id, created_at),
  CONSTRAINT fk_lc_messages_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS lc_client_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id CHAR(36) NOT NULL,
  type VARCHAR(48) NOT NULL,
  payload JSON NULL,
  ext_version VARCHAR(20) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lc_client_events_user (user_id, type, created_at),
  CONSTRAINT fk_lc_client_events_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
