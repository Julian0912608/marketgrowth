// ============================================================
// src/shared/middleware/tenant-context.ts
//
// Uses Node.js AsyncLocalStorage so tenant context flows
// automatically through async call chains — no manual passing.
// ============================================================

import { AsyncLocalStorage } from 'async_hooks';
import { TenantContext } from '../types/tenant';

// The store that holds context for the duration of a request
const storage = new AsyncLocalStorage<TenantContext>();

// Get the current tenant context (throws if called outside a request)
export function getTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      '[TenantContext] No context found. ' +
      'This function must be called within a request scope. ' +
      'Ensure tenantContextMiddleware is applied to this route.'
    );
  }
  return ctx;
}

// Get tenant context safely (returns null outside a request)
export function getTenantContextOrNull(): TenantContext | null {
  return storage.getStore() ?? null;
}

// Run a function within a tenant context (used by middleware and workers)
export function runWithTenantContext<T>(
  context: TenantContext,
  fn: () => T
): T {
  return storage.run(context, fn);
}

// Get just the tenantId (most common use case)
export function getCurrentTenantId(): string {
  return getTenantContext().tenantId;
}
