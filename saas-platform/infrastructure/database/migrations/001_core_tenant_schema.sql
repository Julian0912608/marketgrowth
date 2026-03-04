-- ============================================================
-- Migration 001: Core Tenant Schema + Row-Level Security
-- Platform: AI-Driven SaaS voor Ecommerce Ondernemers
-- ============================================================
-- Run: psql $DATABASE_URL -f 001_core_tenant_schema.sql
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TENANTS (one row = one paying customer account)
-- ============================================================
CREATE TABLE tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,         -- used in URLs
  email        TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SUBSCRIPTION PLANS
-- ============================================================
CREATE TABLE plans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,         -- 'starter' | 'growth' | 'scale'
  name         TEXT NOT NULL,
  stripe_price_id TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the three plans
INSERT INTO plans (slug, name) VALUES
  ('starter', 'Starter'),
  ('growth',  'Growth'),
  ('scale',   'Scale');

-- ============================================================
-- TENANT SUBSCRIPTIONS
-- ============================================================
CREATE TABLE tenant_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id         UUID NOT NULL REFERENCES plans(id),
  stripe_sub_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'trialing', 'past_due', 'cancelled')),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end   TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenant_subscriptions_tenant_id ON tenant_subscriptions(tenant_id);

-- ============================================================
-- FEATURES (the feature registry)
-- ============================================================
CREATE TABLE features (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT NOT NULL UNIQUE,         -- e.g. 'ad-analytics', 'ai-recommendations'
  name         TEXT NOT NULL,
  description  TEXT,
  is_metered   BOOLEAN NOT NULL DEFAULT false, -- true = has usage limits
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed all features
INSERT INTO features (slug, name, is_metered) VALUES
  ('sales-dashboard',         'Sales Dashboard',                  false),
  ('order-analytics',         'Order & Omzet Analyse',            false),
  ('ai-recommendations',      'AI Product Aanbevelingen',         true),
  ('ad-analytics',            'Advertentie Analyse',              false),
  ('ai-ad-optimization',      'AI Advertentie Optimalisatie',     true),
  ('customer-ltv',            'Klant Lifetime Value Prognose',    false),
  ('multi-shop',              'Multi-webshop Beheer',             false),
  ('report-export',           'Rapportage Export',                false),
  ('api-access',              'API Toegang',                      false),
  ('white-label',             'White-label Dashboard',            false),
  ('team-accounts',           'Team Accounts',                    false);

-- ============================================================
-- PLAN FEATURES (which features belong to which plan)
-- ============================================================
CREATE TABLE plan_features (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_id  UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  UNIQUE (plan_id, feature_id)
);

-- Starter features
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.slug = 'starter'
  AND f.slug IN ('sales-dashboard', 'order-analytics');

-- Growth features (includes all Starter +)
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.slug = 'growth'
  AND f.slug IN (
    'sales-dashboard', 'order-analytics',
    'ai-recommendations', 'ad-analytics',
    'customer-ltv', 'multi-shop', 'report-export'
  );

-- Scale features (all features)
INSERT INTO plan_features (plan_id, feature_id)
SELECT p.id, f.id FROM plans p, features f
WHERE p.slug = 'scale';

-- ============================================================
-- USAGE LIMITS per plan per feature
-- ============================================================
CREATE TABLE usage_limits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     UUID NOT NULL REFERENCES plans(id),
  feature_id  UUID NOT NULL REFERENCES features(id),
  limit_type  TEXT NOT NULL CHECK (limit_type IN ('monthly', 'daily', 'total')),
  limit_value INTEGER,                       -- NULL = unlimited
  UNIQUE (plan_id, feature_id, limit_type)
);

-- AI credits per month
INSERT INTO usage_limits (plan_id, feature_id, limit_type, limit_value)
SELECT p.id, f.id, 'monthly',
  CASE p.slug
    WHEN 'starter' THEN 500
    WHEN 'growth'  THEN 5000
    WHEN 'scale'   THEN NULL   -- unlimited
  END
FROM plans p, features f
WHERE f.slug = 'ai-recommendations';

-- Max webshops (stored as 'total' limit)
INSERT INTO usage_limits (plan_id, feature_id, limit_type, limit_value)
SELECT p.id, f.id, 'total',
  CASE p.slug
    WHEN 'starter' THEN 1
    WHEN 'growth'  THEN 3
    WHEN 'scale'   THEN NULL   -- unlimited
  END
FROM plans p, features f
WHERE f.slug = 'multi-shop';

-- ============================================================
-- ACCOUNT FEATURE OVERRIDES (manual exceptions per tenant)
-- Use case: give a Starter tenant temporary Growth access
-- ============================================================
CREATE TABLE account_feature_overrides (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_id  UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  granted     BOOLEAN NOT NULL DEFAULT true,  -- true = grant, false = explicitly revoke
  expires_at  TIMESTAMPTZ,                    -- NULL = permanent override
  reason      TEXT,                           -- audit trail note
  created_by  TEXT NOT NULL,                  -- support agent email or 'system'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, feature_id)
);

CREATE INDEX idx_account_overrides_tenant_id ON account_feature_overrides(tenant_id);

-- ============================================================
-- FEATURE USAGE (metered usage tracking per billing period)
-- ============================================================
CREATE TABLE feature_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_id      UUID NOT NULL REFERENCES features(id),
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  usage_count     INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, feature_id, period_start)
);

CREATE INDEX idx_feature_usage_tenant_id   ON feature_usage(tenant_id);
CREATE INDEX idx_feature_usage_period      ON feature_usage(tenant_id, feature_id, period_start);

-- ============================================================
-- ROW LEVEL SECURITY setup helper function
-- Called once per table to enable multi-tenant isolation
-- ============================================================
CREATE OR REPLACE FUNCTION enable_tenant_rls(table_name TEXT)
RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I
       USING (tenant_id = current_setting(''app.tenant_id'', true)::UUID)',
    table_name
  );
END;
$$ LANGUAGE plpgsql;

-- Apply RLS to all tenant-scoped tables
SELECT enable_tenant_rls('tenant_subscriptions');
SELECT enable_tenant_rls('account_feature_overrides');
SELECT enable_tenant_rls('feature_usage');

-- ============================================================
-- updated_at auto-trigger
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tenant_subscriptions_updated_at
  BEFORE UPDATE ON tenant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
