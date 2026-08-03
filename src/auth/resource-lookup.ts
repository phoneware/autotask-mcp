/**
 * Map a Google account email to the Autotask Resource it belongs to.
 *
 * This is the join that makes attribution work: Google tells us who signed in,
 * Autotask needs a numeric Resource id for ImpersonationResourceId, and email
 * is the only field the two systems share.
 */

import { api } from '../autotask-api.js';

/** Cache lifetime for a resolved lookup. Resources change rarely. */
const CACHE_TTL_MS = 60 * 60_000;

interface CacheEntry {
  resourceId?: number;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

interface ResourceQueryResponse {
  items?: Array<{ id?: number; isActive?: boolean | number }>;
}

/** Drop cached lookups. Used by tests and after a config change. */
export function resetResourceCache(): void {
  cache.clear();
}

/**
 * Resolve the Autotask Resource id for `email`, or undefined when the person
 * has no matching resource.
 *
 * A miss is cached too. Otherwise every tool call by someone without an
 * Autotask resource (a contractor, a shared account) would re-query Autotask
 * and spend the tenant's request budget to learn the same thing each time.
 *
 * Never throws: attribution is a nice-to-have, and a lookup failure must not
 * take down the tool call it decorates. On error the caller simply has no
 * resource id and the write falls back to the API user.
 */
export async function resourceIdForEmail(email: string): Promise<number | undefined> {
  const key = email.trim().toLowerCase();
  if (!key) return undefined;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.resourceId;
  }

  let resourceId: number | undefined;
  try {
    const result = (await api.query('Resources', {
      filter: [{ op: 'eq', field: 'email', value: key }],
      MaxRecords: 5,
      IncludeFields: ['id', 'isActive'],
    })) as ResourceQueryResponse;

    const items = result.items ?? [];
    // Prefer an active resource: a departed employee's record can linger and
    // impersonating it would attribute work to someone who has left.
    const active = items.find((r) => r.isActive === true || r.isActive === 1);
    const chosen = active ?? items[0];
    if (chosen && typeof chosen.id === 'number') {
      resourceId = chosen.id;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[autotask-mcp] resource lookup failed for ${key}: ${message}`);
    // Deliberately not cached: a transient failure should be retried, unlike a
    // genuine "no such resource" answer.
    return undefined;
  }

  cache.set(key, { resourceId, fetchedAt: Date.now() });
  return resourceId;
}
