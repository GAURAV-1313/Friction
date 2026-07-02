-- Add 'auto' to source_type enum and capture_hash column for deduplication

ALTER TABLE buffer_moments MODIFY source_type ENUM('highlight','bulk_paste','auto') NOT NULL;

ALTER TABLE buffer_moments ADD COLUMN capture_hash VARCHAR(64) NULL AFTER status;

ALTER TABLE buffer_moments ADD UNIQUE INDEX uniq_capture_hash (capture_hash);
