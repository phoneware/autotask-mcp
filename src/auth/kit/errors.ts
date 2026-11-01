// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/errors.ts at 998685a9dd5843a89e6eb1f3659223e7f9e31fc5). Edit the canonical file, then re-copy.
import {
 InvalidGrantError,
 OAuthError,
 TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export type KitErrorCode = 'store_unavailable' | 'upstream_unavailable' | 'upstream_revoked';

export abstract class KitError extends Error {
 abstract readonly kitCode: KitErrorCode;
}

export class StoreUnavailableError extends KitError {
 readonly kitCode = 'store_unavailable';

 constructor(message: string = 'Store unavailable', options?: { cause?: unknown }) {
  super(message, options);
  this.name = 'StoreUnavailableError';
 }
}

export class UpstreamUnavailableError extends KitError {
 readonly kitCode = 'upstream_unavailable';

 constructor(message: string = 'Upstream unavailable', options?: { cause?: unknown }) {
  super(message, options);
  this.name = 'UpstreamUnavailableError';
 }
}

export class UpstreamRevokedError extends KitError {
 readonly kitCode = 'upstream_revoked';

 constructor(message: string = 'Upstream grant revoked', options?: { cause?: unknown }) {
  super(message, options);
  this.name = 'UpstreamRevokedError';
 }
}

/**
 * Matches KitError codes structurally.
 * Never relies on instanceof alone because multiple kit copies can exist
 * in the same process across dependency boundaries or tarball imports.
 */
export function kitCodeOf(err: unknown): KitErrorCode | undefined {
 if (err && typeof err === 'object' && 'kitCode' in err) {
  const code = err.kitCode;
  if (
   code === 'store_unavailable' ||
   code === 'upstream_unavailable' ||
   code === 'upstream_revoked'
  ) {
   return code;
  }
 }
 return undefined;
}

/**
 * Classifies an upstream token endpoint response as definitive or transient.
 *
 * Definitive failures mean the user's upstream credential or identity ended:
 * invalid_grant, Entra interaction_required, or HTTP 400 with an unparseable body.
 *
 * Transient failures mean the upstream service or network had an issue:
 * 401, invalid_client, unauthorized_client, 408, 429, 5xx, network errors, timeouts.
 *
 * In Starlink multi-tenant mode, invalid_client means that specific person's
 * credential ended, so invalidClientIsDefinitive may be set to true.
 */
export function classifyUpstreamTokenResponse(
 status: number,
 body?: unknown,
 opts?: { invalidClientIsDefinitive?: boolean },
): 'definitive' | 'transient' {
 let parsedError: string | undefined;

 if (typeof body === 'string') {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
   try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
     if ('error' in parsed && typeof parsed.error === 'string') {
      parsedError = parsed.error;
     } else if ('error_description' in parsed && typeof parsed.error_description === 'string') {
      parsedError = parsed.error_description;
     }
    }
   } catch {
    // String looks like JSON but failed to parse.
    if (status === 400) return 'definitive';
   }
  } else {
   parsedError = trimmed;
  }
 } else if (body && typeof body === 'object') {
  if ('error' in body && typeof body.error === 'string') {
   parsedError = body.error;
  } else if ('error_description' in body && typeof body.error_description === 'string') {
   parsedError = body.error_description;
  }
 }

 const normalized = (parsedError ?? '').toLowerCase();

 if (normalized.includes('invalid_grant')) {
  return 'definitive';
 }
 if (normalized.includes('interaction_required')) {
  return 'definitive';
 }

 if (status === 400 && !parsedError) {
  return 'definitive';
 }

 if (opts?.invalidClientIsDefinitive && normalized.includes('invalid_client')) {
  return 'definitive';
 }

 return 'transient';
}

/**
 * Translates any internal error caught during /token processing into a spec-compliant
 * OAuthError so that /token never returns HTTP 500.
 */
export function toTokenEndpointError(
 err: unknown,
 log?: (err: unknown) => void,
): OAuthError {
 const code = kitCodeOf(err);
 if (code === 'store_unavailable' || code === 'upstream_unavailable') {
  const message = err instanceof Error ? err.message : 'Temporarily unavailable';
  return new TemporarilyUnavailableError(message);
 }
 if (code === 'upstream_revoked') {
  const message = err instanceof Error ? err.message : 'Upstream grant revoked';
  return new InvalidGrantError(message);
 }

 if (err instanceof InvalidGrantError) {
  return err;
 }
 if (err instanceof OAuthError) {
  return err;
 }

 if (log) {
  log(err);
 } else {
  console.error('[mcp-oauth-kit] unexpected token endpoint error:', err);
 }

 return new TemporarilyUnavailableError('Service temporarily unavailable');
}
