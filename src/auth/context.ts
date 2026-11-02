/**
 * Per-request identity, carried without threading an argument through every
 * tool signature.
 *
 * A single AutotaskApi instance is shared by every session, but impersonation
 * is per-user: the same client object has to send a different
 * ImpersonationResourceId depending on who is making the call. AsyncLocalStorage
 * scopes that to the request, so `authHeaders()` can read it at the point the
 * HTTP call is actually built.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Capability } from './capabilities.js';

export interface CallerIdentity {
  /** Google account email of the person making the request. */
  email: string;
  /**
   * Autotask Resource id this email maps to. Always present: sign-in is
   * refused when an email does not resolve to exactly one active resource,
   * because a write we cannot attribute is a write against the API user's
   * root-level credential with nobody's name on it.
   */
  resourceId: number;
  /** Autotask security level (Resource.userType) behind the capabilities. */
  userType?: number;
  /** What this person may do, derived from their Autotask security level. */
  capabilities: readonly Capability[];
}

const storage = new AsyncLocalStorage<CallerIdentity>();

/** Run `fn` with `identity` visible to everything it awaits. */
export function withCaller<T>(identity: CallerIdentity | undefined, fn: () => T): T {
  return identity ? storage.run(identity, fn) : fn();
}

/** The caller for the current request, if the request carried an identity. */
export function currentCaller(): CallerIdentity | undefined {
  return storage.getStore();
}

/**
 * Resolve and strictly validate caller actor identity for protected provisioning mutations.
 * Refuses unauthenticated, anonymous, or fallback actors (e.g. autotask-mcp or resource 0).
 */
export function resolveActorOrThrow(): { email: string; resourceId: number } {
  const caller = currentCaller();
  if (caller) {
    const email = (caller.email || '').trim().toLowerCase();
    const resourceId = caller.resourceId;
    if (email && Number.isSafeInteger(resourceId) && resourceId > 0) {
      return { email, resourceId };
    }
  }

  // Check stdio / environment actor if running outside authenticated HTTP session
  const envEmail = (process.env.AUTOTASK_ACTOR_EMAIL || process.env.STDIO_ACTOR_EMAIL || '').trim().toLowerCase();
  const envResId = parseInt(
    process.env.AUTOTASK_ACTOR_RESOURCE_ID || process.env.STDIO_ACTOR_RESOURCE_ID || '',
    10,
  );
  if (envEmail && Number.isSafeInteger(envResId) && envResId > 0) {
    return { email: envEmail, resourceId: envResId };
  }

  throw new Error(
    'Refused: provisioning operations require an authenticated caller with a verified email and positive resourceId. Fallback or anonymous actors are forbidden.',
  );
}
