-- vNext schema: consolidation, canonical topics, confidence model

-- 1. Consolidation candidates
CREATE TABLE IF NOT EXISTS merge_candidates (
  candidate_id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  source_record_id CHAR(36) NOT NULL,
  target_record_id CHAR(36) NOT NULL,
  similarity FLOAT NOT NULL,
  status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_status (user_id, status),
  INDEX idx_source (source_record_id),
  INDEX idx_target (target_record_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (source_record_id) REFERENCES learning_records(record_id),
  FOREIGN KEY (target_record_id) REFERENCES learning_records(record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Canonical topics
CREATE TABLE IF NOT EXISTS canonical_topics (
  topic_id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  embedding JSON NULL,
  occurrence_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_name (user_id, name),
  INDEX idx_user_count (user_id, occurrence_count DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Add confidence_ai to learning_records
ALTER TABLE learning_records
  ADD COLUMN confidence_ai ENUM('high','medium','low') NULL;

-- 4. Add canonical_topic_id to learning_records
ALTER TABLE learning_records
  ADD COLUMN canonical_topic_id CHAR(36) NULL;

-- 5. Add evidence_count to canonical_topics (materialized)
-- Computed from learning_records, updated via trigger or app logic
