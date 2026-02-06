-- FRICTION v1 schema (MySQL)

-- users
CREATE TABLE IF NOT EXISTS users (
  user_id CHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  google_sub VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_users_google_sub (google_sub),
  UNIQUE KEY uniq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- user_settings
CREATE TABLE IF NOT EXISTS user_settings (
  user_id CHAR(36) PRIMARY KEY,
  output_language ENUM('hinglish','english') NOT NULL DEFAULT 'hinglish',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_settings_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- prompts
CREATE TABLE IF NOT EXISTS prompts (
  prompt_id CHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- buffer_moments
CREATE TABLE IF NOT EXISTS buffer_moments (
  moment_id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  raw_text TEXT NOT NULL,
  source_type ENUM('highlight','bulk_paste') NOT NULL,
  source_url TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status ENUM('pending','processed') NOT NULL DEFAULT 'pending',
  CONSTRAINT fk_buffer_moments_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  KEY idx_buffer_user_status_created (user_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  trigger_type ENUM('manual','scheduled') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  moment_count INT NOT NULL,
  CONSTRAINT fk_snapshots_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  KEY idx_snapshots_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- candidate_findings
CREATE TABLE IF NOT EXISTS candidate_findings (
  finding_id CHAR(36) PRIMARY KEY,
  snapshot_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  type ENUM('confusion','insight','fragile_understanding','pattern') NOT NULL,
  topic VARCHAR(255) NOT NULL,
  summary TEXT NOT NULL,
  confidence_ai ENUM('high','medium','low') NOT NULL,
  evidence_moment_ids JSON NOT NULL,
  state ENUM('unreviewed','confirmed','deferred','rejected') NOT NULL DEFAULT 'unreviewed',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_candidate_findings_snapshot
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_candidate_findings_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  KEY idx_findings_user_state_created (user_id, state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- learning_records
CREATE TABLE IF NOT EXISTS learning_records (
  record_id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  type ENUM('confusion','insight','pattern') NOT NULL,
  topic VARCHAR(255) NOT NULL,
  summary TEXT NOT NULL,
  first_seen_at TIMESTAMP NOT NULL,
  last_admitted_at TIMESTAMP NOT NULL,
  occurrence_count INT NOT NULL,
  ignored_count INT NOT NULL,
  CONSTRAINT fk_learning_records_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  KEY idx_learning_records_user_type_last (user_id, type, last_admitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional: ensure only one active prompt at a time
-- Enforced at application layer in v1.
