-- ============================================================
-- Migration 002: API Rate Limiting Configuratie
-- ============================================================

CREATE TABLE rate_limit_config (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      UUID NOT NULL REFERENCES plans(id),
  resource     TEXT NOT NULL,                -- 'api', 'export', 'sync'
  window_secs  INTEGER NOT NULL,             -- sliding window in seconds
  max_requests INTEGER NOT NULL,             -- max calls in that window
  UNIQUE (plan_id, resource)
);

-- API request limits per minute (60 sec)
INSERT INTO rate_limit_config (plan_id, resource, window_secs, max_requests)
SELECT p.id, 'api', 60,
  CASE p.slug
    WHEN 'starter' THEN 100
    WHEN 'growth'  THEN 500
    WHEN 'scale'   THEN 2000
  END
FROM plans p;

-- Concurrent export job limits
INSERT INTO rate_limit_config (plan_id, resource, window_secs, max_requests)
SELECT p.id, 'export', 3600,
  CASE p.slug
    WHEN 'starter' THEN 1
    WHEN 'growth'  THEN 3
    WHEN 'scale'   THEN 10
  END
FROM plans p;

-- Webshop sync cooldown (15 min = 900 sec)
INSERT INTO rate_limit_config (plan_id, resource, window_secs, max_requests)
SELECT p.id, 'sync', 900, 1
FROM plans p;
