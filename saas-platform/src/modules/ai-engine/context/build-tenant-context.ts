// ============================================================
// src/modules/ai-engine/context/build-tenant-context.ts
//
// Bouwt een Engels-talige context-string uit de 4 onboarding
// velden (country, sells-to, business goal, marketing style).
//
// Architecture Plan §5 Gap 2 eist dat deze context bovenop elke
// AI prompt komt te staan. Per call 1 DB read op tenants pkey
// (~1ms), geen cache nodig op V0 schaal.
//
// Gebruik:
//
//   const ctx = await buildTenantContextString(tenantId);
//   const systemPrompt = `${ctx}\n\nYou are an ecom advisor...`;
//
// Bij missende velden (skipped onboarding): functie geeft een
// kortere string terug met alleen de bekende facts. Bij volledig
// lege tenant (corner case, mag eigenlijk niet bestaan): lege string.
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { logger } from '../../../shared/logging/logger';

interface TenantContextRow {
  country_code:       string | null;
  sells_to_countries: string[] | null;
  business_goal:      string | null;
  marketing_style:    string | null;
}

// Sync houden met frontend Step1Country.tsx COUNTRIES lijst.
const COUNTRY_NAMES: Record<string, string> = {
  AT: 'Austria',         BE: 'Belgium',         BG: 'Bulgaria',
  HR: 'Croatia',         CY: 'Cyprus',          CZ: 'Czech Republic',
  DK: 'Denmark',         EE: 'Estonia',         FI: 'Finland',
  FR: 'France',          DE: 'Germany',         GR: 'Greece',
  HU: 'Hungary',         IE: 'Ireland',         IT: 'Italy',
  LV: 'Latvia',          LT: 'Lithuania',       LU: 'Luxembourg',
  MT: 'Malta',           NL: 'the Netherlands', PL: 'Poland',
  PT: 'Portugal',        RO: 'Romania',         SK: 'Slovakia',
  SI: 'Slovenia',        ES: 'Spain',           SE: 'Sweden',
  GB: 'the United Kingdom', NO: 'Norway',       CH: 'Switzerland',
};

const GOAL_DESCRIPTIONS: Record<string, string> = {
  'lifestyle':     'lifestyle income (3-8k EUR/month, not chasing infinite scale)',
  'steady':        'steady growth (20-50% per year, sustainable and profitable)',
  'scale-to-exit': 'scale to exit (grow fast, sell in 5-7 years)',
  'side-project':  'side project alongside a day job (learning and earning extra)',
};

const STYLE_DESCRIPTIONS: Record<string, string> = {
  'paid':    'aggressive paid acquisition (Meta and Google, ROAS-first)',
  'organic': 'organic and content first (SEO, social content, email)',
  'mix':     'a balanced mix of paid and organic channels',
};

// Cache TTL kort genoeg dat een Settings-edit binnen redelijke tijd
// effect heeft op de AI prompts. 5 min is genoeg.
const CACHE_TTL_SECONDS = 300;
const cache: Map<string, { value: string; expiresAt: number }> = new Map();

export async function buildTenantContextString(tenantId: string): Promise<string> {
  // In-memory cache check
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let row: TenantContextRow | null = null;

  try {
    const result = await db.query<TenantContextRow>(
      `SELECT country_code, sells_to_countries, business_goal, marketing_style
       FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
      { allowNoTenant: true }
    );
    row = result.rows[0] ?? null;
  } catch (err) {
    logger.warn('ai.context.build_failed', {
      tenantId,
      error: (err as Error).message,
    });
    return '';
  }

  const value = buildString(row);
  cache.set(tenantId, {
    value,
    expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
  });
  return value;
}

// Manual invalidatie. Aanroepen vanuit onboarding.service.ts
// updateProfileFields zodat een Settings-edit direct doorwerkt.
export function invalidateTenantContext(tenantId: string): void {
  cache.delete(tenantId);
}

function buildString(row: TenantContextRow | null): string {
  if (!row) return '';

  const parts: string[] = [];

  // Geographic context
  if (row.country_code) {
    const countryName = COUNTRY_NAMES[row.country_code] ?? row.country_code;
    let geo = `The user is an ecom founder based in ${countryName}`;

    if (row.sells_to_countries && row.sells_to_countries.length > 0) {
      const sellingTo = row.sells_to_countries
        .map(c => c === 'GLOBAL' ? 'globally' : (COUNTRY_NAMES[c] ?? c))
        .join(', ');
      geo += `, selling to ${sellingTo}`;
    }
    parts.push(geo + '.');
  }

  // Business goal
  if (row.business_goal && GOAL_DESCRIPTIONS[row.business_goal]) {
    parts.push(`Business goal: ${GOAL_DESCRIPTIONS[row.business_goal]}.`);
  }

  // Marketing style
  if (row.marketing_style && STYLE_DESCRIPTIONS[row.marketing_style]) {
    parts.push(`Marketing style: ${STYLE_DESCRIPTIONS[row.marketing_style]}.`);
  }

  if (parts.length === 0) return '';

  return [
    'TENANT CONTEXT:',
    ...parts,
    'Tailor recommendations to fit this profile. Do not contradict it.',
  ].join('\n');
}
