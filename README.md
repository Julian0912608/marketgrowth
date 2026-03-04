# AI-Driven SaaS Platform — Ecommerce Ondernemers

## Architectuur

Dit project volgt de principes uit het architectuurdocument:

- **Multi-tenancy**: Row-Level Security (PostgreSQL) — elke klant ziet alleen zijn eigen data
- **Module scheiding**: Verticale slices — modules communiceren via events, nooit directe imports
- **Permission Service**: Centrale feature-toegangscontrole per abonnement
- **Observability**: Elk log-regel bevat automatisch `tenantId` + `traceId`

---

## Projectstructuur

```
src/
  modules/
    sales-dashboard/        ← Module 1
      api/                  (routes & controllers)
      service/              (business logic)
      repository/           (ENIGE toegang tot eigen DB-tabellen)
      events/               (events die deze module uitzendt)
      tests/                (incl. tenant-isolatie tests)
    ad-analytics/           ← Module 2 (identieke structuur)
    ai-engine/              ← Module 3
    subscription/           ← Abonnementenbeheer
  shared/
    types/                  (gedeelde TypeScript types)
    middleware/             (tenant context, error handler)
    permissions/            (Permission Service)
    events/                 (Event Bus)
    logging/                (Logger met auto-context)
infrastructure/
  database/
    migrations/             (SQL migraties — run in volgorde)
  cache/                    (Redis client)
  queue/                    (BullMQ workers)
```

---

## Setup

### 1. Installeer dependencies
```bash
npm install
```

### 2. Stel environment variabelen in
```bash
cp .env.example .env
# Vul DATABASE_URL, REDIS_URL, JWT_SECRET in
```

### 3. Draai database migraties
```bash
psql $DATABASE_URL -f infrastructure/database/migrations/001_core_tenant_schema.sql
psql $DATABASE_URL -f infrastructure/database/migrations/002_rate_limiting.sql
```

### 4. Start de development server
```bash
npm run dev
```

---

## Regels voor ontwikkelaars

### Tenant isolatie
- **Elke** database query heeft automatisch RLS — je hoeft GEEN `WHERE tenant_id = ?` toe te voegen
- Gebruik `getTenantContext()` om de huidige tenantId op te halen — nooit via een parameter
- Queries buiten een request context (jobs, scripts) moeten `{ allowNoTenant: true }` meegeven én zelf filteren

### Module scheiding
```typescript
// ✅ CORRECT: event publiceren
await eventBus.publish({ type: 'order.created', tenantId, payload: { ... } });

// ❌ FOUT: directe import uit andere module
import { AdAnalyticsService } from '../ad-analytics/service/...';  // VERBODEN
```

### Feature toegang
```typescript
// ✅ CORRECT: altijd via permissionService
const { allowed, requiredPlan } = await permissionService.check({
  tenantId,
  feature: 'ad-analytics',
});
if (!allowed) throw new FeatureNotAvailableError('ad-analytics', requiredPlan);

// ❌ FOUT: zelf plan checken
if (tenant.plan === 'growth') { ... }  // VERBODEN — gebruik permissionService
```

---

## Tests

```bash
# Alle tests
npm test

# Alleen tenant-isolatie tests (draait bij elke PR)
npm run test:isolation
```

---

## Drie Pakketten

| Feature                       | Starter | Growth | Scale     |
|-------------------------------|---------|--------|-----------|
| Sales Dashboard               | ✓       | ✓      | ✓         |
| Order & Omzet Analyse         | ✓       | ✓      | ✓         |
| AI Product Aanbevelingen      | –       | ✓      | ✓         |
| Advertentie Analyse           | –       | ✓      | ✓         |
| AI Advertentie Optimalisatie  | –       | –      | ✓         |
| Multi-webshop Beheer          | –       | Tot 3  | Onbeperkt |
| API Toegang                   | –       | –      | ✓         |
| AI Credits / maand            | 500     | 5.000  | Onbeperkt |
