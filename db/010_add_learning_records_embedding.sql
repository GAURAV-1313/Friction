-- vNext enhancement: Add embedding column to learning_records for RAG retrieval
-- Idempotent - safe to run multiple times

SET @dbname = DATABASE();
SET @tablename = 'learning_records';
SET @columnname = 'embedding';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE (table_name = @tablename) AND (table_schema = @dbname) AND (column_name = @columnname)
  ) > 0,
  'SELECT 1',
  CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN embedding JSON NULL')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Note: MySQL JSON columns cannot be directly indexed.
-- The embedding IS NOT NULL check in queries will use a full table scan,
-- which is acceptable for typical learning_records table sizes.
