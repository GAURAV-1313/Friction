-- Update schema for new prompt (gap/pattern/insight + recall_anchor)

-- candidate_findings: update type enum and add recall_anchor
ALTER TABLE candidate_findings
  MODIFY type ENUM('gap','pattern','insight') NOT NULL,
  ADD COLUMN recall_anchor TEXT NULL AFTER summary;

-- learning_records: update type enum and add recall_anchor
ALTER TABLE learning_records
  MODIFY type ENUM('gap','pattern','insight') NOT NULL,
  ADD COLUMN recall_anchor TEXT NULL AFTER summary;

-- evidence_moment_ids remains JSON, ensure we always write [] when missing
