/**
 * Map a Google account email to the Autotask Resource it belongs to, and to
 * what that person is allowed to do.
 *
 * This is the join that makes both attribution and authorization work: Google
 * tells us who signed in, Autotask needs a numeric Resource id for
 * ImpersonationResourceId, and email is the only field the two systems share.
 * The same lookup carries back `userType`, Autotask's security level, which is
 * the only signal we get about the person's rights.
 *
 * The resolution rules are deliberately strict, because every loose end here
 * becomes an unattributable write against a root-level API credential:
 *
 *   - Only *active* resources count. A departed employee's record lingers in
 *     Autotask, and impersonating it would attribute today's work to someone
 *     who left. Two Phoneware addresses match only inactive records right now,
 *     so this is not hypothetical.
 *   - An email matching more than one active resource is refused. We would be
 *     guessing which person we are acting as, and guessing identity is the one
 *     thing this layer must never do.
 *   - No match at all is refused. Previously such a person still signed in and
 *     their writes silently fell back to the API user, which is precisely the
 *     anonymous root write this exists to prevent.
 *   - Service-account levels (API User) are refused. A person must not borrow
 *     an integration's identity.
 */

import { api } from '../autotask-api.js';
import {
  capabilitiesForUserType,
  isServiceAccount,
  labelForUserType,
  type Capability,
} from './capabilities.js';

/** Cache lifetime for a resolved lookup. Resources change rarely. */
const CACHE_TTL_MS = 60 * 60_000;

/** A resolved, authorized person. */
export interface ResolvedResource {
  resourceId: number;
  userType?: number;
  licenseType?: number;
  capabilities: readonly Capability[];
}

/** Why a sign-in was refused, in words the person can act on. */
export type ResolutionFailure = { reason: string };

export type Resolution = ResolvedResource | ResolutionFailure;

export function isResolved(r: Resolution): r is ResolvedResource {
  return (r as ResolvedResource).resourceId !== undefined;
}

interface CacheEntry {
  resolution: Resolution;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

interface ResourceRow {
  id?: number;
  isActive?: boolean | number;
  userType?: number;
  licenseType?: number;
}

interface ResourceQueryResponse {
  items?: ResourceRow[];
}

/** Drop cached lookups. Used by tests and after a config change. */
export function resetResourceCache(): void {
  cache.clear();
}

function isActive(row: ResourceRow): boolean {
  return row.isActive === true || row.isActive === 1;
}

/**
 * Resolve the Autotask identity and rights for `email`.
 *
 * Returns either a resolved resource or a refusal with a reason. A transient
 * lookup failure is a refusal too, and is deliberately not cached: this now
 * gates access rather than decorating it, so failing open would hand out the
 * API user's rights exactly when Autotask is unreachable.
 */
export async function resolveResourceForEmail(
  email: string,
  opts: { cache?: boolean } = {},
): Promise<Resolution> {
  const key = email.trim().toLowerCase();
  if (!key) return { reason: 'No email address was provided.' };

  const useCache = opts.cache !== false;
  const hit = useCache ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.resolution;
  }

  let items: ResourceRow[];
  try {
    const result = (await api.query('Resources', {
      filter: [{ op: 'eq', field: 'email', value: key }],
      MaxRecords: 5,
      IncludeFields: ['id', 'isActive', 'userType', 'licenseType'],
    })) as ResourceQueryResponse;
    items = result.items ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[autotask-mcp] resource lookup failed for ${key}: ${message}`);
    // Not cached: a transient failure should be retried, unlike a genuine
    // "no such resource" answer.
    return { reason: 'Could not reach Autotask to confirm your account. Try again shortly.' };
  }

  const resolution = classify(key, items);
  if (useCache) cache.set(key, { resolution, fetchedAt: Date.now() });
  return resolution;
}

function classify(email: string, items: ResourceRow[]): Resolution {
  const active = items.filter((r) => isActive(r) && typeof r.id === 'number');

  if (active.length === 0) {
    const inactive = items.length > 0;
    console.error(
      `[autotask-mcp] refused ${email}: ${
        inactive ? 'only inactive Autotask resources match' : 'no Autotask resource matches'
      }`,
    );
    return {
      reason: inactive
        ? 'Your Autotask account is deactivated, so there is no active resource to act as.'
        : 'No active Autotask resource matches this email address.',
    };
  }

  if (active.length > 1) {
    console.error(
      `[autotask-mcp] refused ${email}: ${active.length} active Autotask resources match ` +
        `(${active.map((r) => r.id).join(', ')})`,
    );
    return {
      reason:
        'More than one active Autotask resource shares this email address, so it is ambiguous ' +
        'which person to act as. An Autotask administrator needs to resolve the duplicate.',
    };
  }

  const row = active[0];
  if (isServiceAccount(row.userType)) {
    console.error(
      `[autotask-mcp] refused ${email}: resource ${row.id} is a service account ` +
        `(${labelForUserType(row.userType)})`,
    );
    return {
      reason:
        'This email belongs to an Autotask API/service account rather than a person. ' +
        'Sign in with your own account.',
    };
  }

  const capabilities = capabilitiesForUserType(row.userType);
  console.error(
    `[autotask-mcp] ${email} -> resource ${row.id}, ${labelForUserType(row.userType)}, ` +
      `capabilities: ${capabilities.join(', ')}`,
  );
  return {
    resourceId: row.id as number,
    userType: row.userType,
    licenseType: row.licenseType,
    capabilities,
  };
}
