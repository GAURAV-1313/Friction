-- Increase raw_text capacity for large captures
ALTER TABLE buffer_moments MODIFY raw_text MEDIUMTEXT NOT NULL;
