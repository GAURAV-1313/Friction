-- vNext enhancements: indexes, columns, and schema improvements
-- Idempotent - safe to run multiple times

-- 1. Add merged_at column to learning_records (only if not exists)
SET @dbname = DATABASE();
SET @tablename = 'learning_records';
SET @columnname = 'merged_at';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE (table_name = @tablename) AND (table_schema = @dbname) AND (column_name = @columnname)
  ) > 0,
  'SELECT 1',
  CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @columnname, ' TIMESTAMP NULL')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- 2. Index on canonical_topic_id for faster joins (only if not exists)
SET @columnname = 'idx_canonical_topic';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE table_name = @tablename AND index_name = @columnname
  ) > 0,
  'SELECT 1',
  'ALTER TABLE learning_records ADD INDEX idx_canonical_topic (canonical_topic_id)'
));
PREPARE addIndexIfNotExists FROM @preparedStatement;
EXECUTE addIndexIfNotExists;
DEALLOCATE PREPARE addIndexIfNotExists;

-- 3. Composite index for user + canonical topic queries (only if not exists)
SET @columnname = 'idx_user_canonical';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE table_name = @tablename AND index_name = @columnname
  ) > 0,
  'SELECT 1',
  'ALTER TABLE learning_records ADD INDEX idx_user_canonical (user_id, canonical_topic_id)'
));
PREPARE addIndexIfNotExists2 FROM @preparedStatement;
EXECUTE addIndexIfNotExists2;
DEALLOCATE PREPARE addIndexIfNotExists2;

-- 4. Index for canonical topic embedding lookups (only if not exists)
SET @tablename = 'canonical_topics';
SET @columnname = 'idx_canonical_embedding';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE table_name = @tablename AND index_name = @columnname
  ) > 0,
  'SELECT 1',
  'ALTER TABLE canonical_topics ADD INDEX idx_canonical_embedding (user_id, topic_id)'
));
PREPARE addIndexIfNotExists3 FROM @preparedStatement;
EXECUTE addIndexIfNotExists3;
DEALLOCATE PREPARE addIndexIfNotExists3;

-- 5. Index on learning_records for occurrence-based queries (only if not exists)
SET @tablename = 'learning_records';
SET @columnname = 'idx_user_occurrence';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE table_name = @tablename AND index_name = @columnname
  ) > 0,
  'SELECT 1',
  'ALTER TABLE learning_records ADD INDEX idx_user_occurrence (user_id, occurrence_count DESC)'
));
PREPARE addIndexIfNotExists4 FROM @preparedStatement;
EXECUTE addIndexIfNotExists4;
DEALLOCATE PREPARE addIndexIfNotExists4;
