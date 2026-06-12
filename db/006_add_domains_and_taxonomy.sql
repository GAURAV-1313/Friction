-- Add domain taxonomy tables and findings classification columns

CREATE TABLE IF NOT EXISTS domains (
  domain_id CHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  label VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_domains_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS subdomains (
  subdomain_id CHAR(36) PRIMARY KEY,
  domain_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  count_source INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_subdomains_domain
    FOREIGN KEY (domain_id) REFERENCES domains(domain_id)
    ON DELETE CASCADE,
  UNIQUE KEY uniq_subdomains_domain_slug (domain_id, slug),
  KEY idx_subdomains_domain (domain_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE candidate_findings
  ADD COLUMN domain_id CHAR(36) NULL AFTER created_at,
  ADD COLUMN subdomain_id CHAR(36) NULL AFTER domain_id,
  ADD CONSTRAINT fk_candidate_findings_domain
    FOREIGN KEY (domain_id) REFERENCES domains(domain_id)
    ON DELETE SET NULL,
  ADD CONSTRAINT fk_candidate_findings_subdomain
    FOREIGN KEY (subdomain_id) REFERENCES subdomains(subdomain_id)
    ON DELETE SET NULL,
  ADD KEY idx_candidate_findings_domain_subdomain (domain_id, subdomain_id);

ALTER TABLE learning_records
  ADD COLUMN domain_id CHAR(36) NULL AFTER ignored_count,
  ADD COLUMN subdomain_id CHAR(36) NULL AFTER domain_id,
  ADD CONSTRAINT fk_learning_records_domain
    FOREIGN KEY (domain_id) REFERENCES domains(domain_id)
    ON DELETE SET NULL,
  ADD CONSTRAINT fk_learning_records_subdomain
    FOREIGN KEY (subdomain_id) REFERENCES subdomains(subdomain_id)
    ON DELETE SET NULL,
  ADD KEY idx_learning_records_domain_subdomain (domain_id, subdomain_id);

INSERT INTO domains (domain_id, name, label)
VALUES
  (UUID(), 'misc', 'Misc'),
  (UUID(), 'dsa', 'Data Structures & Algorithms')
ON DUPLICATE KEY UPDATE label = VALUES(label);