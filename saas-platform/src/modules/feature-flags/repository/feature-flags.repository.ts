// ============================================================
// src/modules/feature-flags/repository/feature-flags.repository.ts
//
// Enige plek die de feature_flags tabel leest.
// feature_flags is een global lookup (geen tenant_id),
// dus we gebruiken altijd allowNoTenant: true.
// ============================================================

import { db } from '../../../infrastructure/database/connection';
import { FeatureFlagRow } from '../types/feature-flags.types';

export class FeatureFlagsRepository {

  // Haal alle rows op (zowel global rows met country_code IS NULL
  // als alle country-specifieke overrides). De resolve-stap doet
  // de service.
  async getAllRows(): Promise<FeatureFlagRow[]> {
    const result = await db.query<FeatureFlagRow>(
      `SELECT feature_key, country_code, enabled, default_enabled, description
       FROM feature_flags
       ORDER BY feature_key, country_code NULLS FIRST`,
      [],
      { allowNoTenant: true }
    );
    return result.rows;
  }
}
