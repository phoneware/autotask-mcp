// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/src/bearer.ts at 998685a9dd5843a89e6eb1f3659223e7f9e31fc5). Edit the canonical file, then re-copy.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
 InsufficientScopeError,
 InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { kitCodeOf } from './errors.js';

export interface TokenVerifier {
  verifyAccessToken(token: string): Promise<
    | AuthInfo
    | {
        token: string;
        clientId: string;
        scopes: string[];
        expiresAt?: number;
        resource?: URL;
        extra?: Record<string, unknown>;
      }
  >;
}

export interface RequireBearerOptions {
 verifier: TokenVerifier;
 resourceMetadataUrl?: string | URL;
 requiredScopes?: string[];
 now?: () => number;
}

/**
 * Middleware that authenticates Bearer tokens on /mcp requests per RFC 6750 and the kit contract.
 *
 * Implements HTTP semantics:
 * - Missing, unknown, expired, or revoked token: 401 with WWW-Authenticate header
 *   carrying error="invalid_token" and optional resource_metadata URL.
 * - Insufficient scopes: 403 with WWW-Authenticate carrying error="insufficient_scope".
 * - Store unavailable or transient upstream failure on expired token: 503 with Retry-After: 5
 *   and error="temporarily_unavailable".
 * - Unexpected exceptions: 500 (logged).
 */
export function requireBearer(opts: RequireBearerOptions): RequestHandler {
 const requiredScopes = opts.requiredScopes ?? [];

 return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const buildWwwAuth = (
   errorCode: string,
   description: string,
   extra?: { scope?: string },
  ): string => {
   let header = `Bearer error="${errorCode}", error_description="${description}"`;
   if (extra?.scope) {
    header += `, scope="${extra.scope}"`;
   }
   if (opts.resourceMetadataUrl) {
    header += `, resource_metadata="${String(opts.resourceMetadataUrl)}"`;
   }
   return header;
  };

  const authHeader = req.headers.authorization;
  if (!authHeader) {
   const header = buildWwwAuth('invalid_token', 'Missing Authorization header');
   res.set('WWW-Authenticate', header);
   res.status(401).json({
    error: 'invalid_token',
    error_description: 'Missing Authorization header',
   });
   return;
  }

  const parts = authHeader.split(' ');
  const scheme = parts[0];
  const token = parts.slice(1).join(' ');

  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
   const header = buildWwwAuth(
    'invalid_token',
    "Invalid Authorization header format, expected 'Bearer TOKEN'",
   );
   res.set('WWW-Authenticate', header);
   res.status(401).json({
    error: 'invalid_token',
    error_description: "Invalid Authorization header format, expected 'Bearer TOKEN'",
   });
   return;
  }

  try {
   const authInfo = await opts.verifier.verifyAccessToken(token);

   if (requiredScopes.length > 0) {
    const scopes = authInfo.scopes ?? [];
    const hasAll = requiredScopes.every((scope) => scopes.includes(scope));
    if (!hasAll) {
     const header = buildWwwAuth('insufficient_scope', 'Insufficient scope', {
      scope: requiredScopes.join(' '),
     });
     res.set('WWW-Authenticate', header);
     res.status(403).json({
      error: 'insufficient_scope',
      error_description: 'Insufficient scope',
      scope: requiredScopes.join(' '),
     });
     return;
    }
   }

   const now = opts.now ? opts.now() : Date.now();
   if (typeof authInfo.expiresAt === 'number') {
    const isSeconds = authInfo.expiresAt < 1e10 && now > 1e11;
    const expired = isSeconds
     ? authInfo.expiresAt <= Math.floor(now / 1000)
     : authInfo.expiresAt <= now;
    if (expired) {
     const header = buildWwwAuth('invalid_token', 'Token has expired');
     res.set('WWW-Authenticate', header);
     res.status(401).json({
      error: 'invalid_token',
      error_description: 'Token has expired',
     });
     return;
    }
   }

   (req as unknown as { auth?: unknown }).auth = authInfo;
   next();
  } catch (err: unknown) {
   const code = kitCodeOf(err);
   if (code === 'store_unavailable' || code === 'upstream_unavailable') {
    const message = err instanceof Error ? err.message : 'Temporarily unavailable';
    res.set('Retry-After', '5');
    res.status(503).json({
     error: 'temporarily_unavailable',
     error_description: message,
    });
    return;
   }

   if (code === 'upstream_revoked') {
    const message = err instanceof Error ? err.message : 'Upstream grant revoked';
    const header = buildWwwAuth('invalid_token', message);
    res.set('WWW-Authenticate', header);
    res.status(401).json({
     error: 'invalid_token',
     error_description: message,
    });
    return;
   }

   if (err instanceof InsufficientScopeError) {
    const header = buildWwwAuth('insufficient_scope', err.message, {
     scope: requiredScopes.join(' '),
    });
    res.set('WWW-Authenticate', header);
    res.status(403).json({
     error: 'insufficient_scope',
     error_description: err.message,
    });
    return;
   }

   if (
    err instanceof InvalidTokenError ||
    (err instanceof Error &&
     (err.message.includes('invalid_token') ||
      err.message.includes('unknown access token') ||
      err.message.includes('expired')))
   ) {
    const message = err instanceof Error ? err.message : 'Invalid access token';
    const header = buildWwwAuth('invalid_token', message);
    res.set('WWW-Authenticate', header);
    res.status(401).json({
     error: 'invalid_token',
     error_description: message,
    });
    return;
   }

   console.error('[mcp-oauth-kit] unexpected bearer verification error:', err);
   res.status(500).json({
    error: 'server_error',
    error_description: 'Internal Server Error',
   });
  }
 };
}
