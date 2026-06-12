CREATE TABLE IF NOT EXISTS subdomains (
  subdomain_id CHAR(36) PRIMARY KEY,
  domain_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  count_source INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_subdomains_domain_slug (domain_id, slug),
  KEY idx_subdomains_domain (domain_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE subdomains
  ADD COLUMN embedding JSON NULL;
