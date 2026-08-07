/**
 * Google OAuth bridge. Implements the MCP SDK's OAuthServerProvider by acting
 * as both:
 *   - an OAuth 2.1 authorization server to MCP clients (claude.ai, Claude Code)
 *   - an OAuth 2.0 client to Google
 *
 * Autotask has no OAuth of its own and no per-user credentials, so Google is
 * not standing in for Autotask auth: it is here purely to establish *who* is
 * connecting. The email it returns is matched to an Autotask Resource, and that
 * resource id rides out on ImpersonationResourceId so writes are attributed to
 * a real person instead of the shared API user.
 *
 * Flow:
 *   1. MCP client → /authorize → authorize() stores the pending request and
 *      redirects the browser to Google.
 *   2. Google → /callback → handleCallback() exchanges the code for an
 *      id_token, verifies it, enforces the domain allowlist, resolves the
 *      Autotask resource, mints our own authorization code, and redirects back.
 *   3. MCP client → /token → exchangeAuthorizationCode() issues our access and
 *      refresh tokens carrying the email and resource id.
 *   4. /mcp → verifyAccessToken() returns them as AuthInfo.extra.
 *
 * Only Google ever sees a password; none passes through this server.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { StoredToken, TokenStoreLike } from './stores.js';
import { resolveResourceForEmail, isResolved } from './resource-lookup.js';
import type { Capability } from './capabilities.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const DEFAULT_TOKEN_TTL_SECONDS = 12 * 60 * 60;

interface PendingAuth {
  mcpClientId: string;
  codeChallenge: string;
  mcpRedirectUri: string;
  mcpState?: string;
  scopes?: string[];
  createdAt: number;
}

interface AuthCodeEntry {
  mcpClientId: string;
  codeChallenge: string;
  mcpRedirectUri: string;
  scopes?: string[];
  email: string;
  resourceId: number;
  userType?: number;
  capabilities: readonly Capability[];
  createdAt: number;
}

export interface GoogleAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Absolute redirect URI registered with Google (baseUrl + /callback). */
  callbackUrl: string;
  /**
   * Email domains permitted to sign in. Required and never empty: without it
   * any Google account on earth could reach the tool surface.
   */
  allowedDomains: string[];
  /** Optional explicit address allowlist, checked in addition to domains. */
  allowedEmails?: string[];
  clientsStore: OAuthRegisteredClientsStore;
  tokenStore: TokenStoreLike;
  tokenTtlSeconds?: number;
}

/** Minimal shape of Google's token response. */
interface GoogleTokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** The id_token claims we rely on. */
export interface IdTokenClaims {
  email?: string;
  email_verified?: boolean | string;
  hd?: string;
  aud?: string;
  iss?: string;
  exp?: number;
}

function base64UrlDecode(segment: string): string {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

/**
 * Read the claims out of a Google id_token.
 *
 * The signature is deliberately not checked here: this token came back over TLS
 * from a direct server-to-server call to Google's token endpoint, in exchange
 * for a code plus our client secret, so it cannot have been substituted by the
 * browser. That is the same basis on which Google's own libraries skip
 * verification for the authorization-code flow. `issuer` and `aud` are still
 * checked below as a defence against a misconfigured client.
 */
export function decodeIdToken(idToken: string): IdTokenClaims | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as IdTokenClaims;
  } catch {
    return null;
  }
}

/** Whether an email may sign in, given the configured allowlists. */
export function isEmailAllowed(
  email: string,
  allowedDomains: string[],
  allowedEmails: string[] = [],
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  if (allowedEmails.some((e) => e.trim().toLowerCase() === normalized)) return true;
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  return allowedDomains.some((d) => d.trim().toLowerCase() === domain);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export class GoogleAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuth>();
  private readonly authCodes = new Map<string, AuthCodeEntry>();
  private readonly tokenTtlMs: number;

  constructor(private readonly opts: GoogleAuthProviderOptions) {
    if (opts.allowedDomains.length === 0 && (opts.allowedEmails ?? []).length === 0) {
      throw new Error(
        'Google sign-in requires AUTOTASK_OAUTH_ALLOWED_DOMAINS (or AUTOTASK_OAUTH_ALLOWED_EMAILS). ' +
          'Refusing to start an authorization server that any Google account could pass.',
      );
    }
    this.tokenTtlMs = (opts.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.opts.clientsStore;
  }

  /**
   * Expire the short-lived in-process state. Issued tokens are swept on the
   * reaper interval instead: with a persistent store that is a query, and
   * running one on every /authorize would be a needless round trip on the
   * latency-sensitive path.
   */
  private sweep(now = Date.now()): void {
    for (const [key, entry] of this.pending) {
      if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(key);
    }
    for (const [key, entry] of this.authCodes) {
      if (now - entry.createdAt > CODE_TTL_MS) this.authCodes.delete(key);
    }
  }

  // --- 1. Authorization: send the browser to Google --------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.sweep();
    const state = randomUUID();
    this.pending.set(state, {
      mcpClientId: client.client_id,
      codeChallenge: params.codeChallenge,
      mcpRedirectUri: params.redirectUri,
      mcpState: params.state,
      scopes: params.scopes,
      createdAt: Date.now(),
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.opts.clientId);
    url.searchParams.set('redirect_uri', this.opts.callbackUrl);
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', state);
    // Nudge Google's account chooser toward the right workspace.
    if (this.opts.allowedDomains.length === 1) {
      url.searchParams.set('hd', this.opts.allowedDomains[0]);
    }
    // Always make the person pick. Without this, Google silently reuses whatever
    // session the browser already has, so someone with several Google accounts
    // gets signed in as whichever one happened to be active, with no visible
    // choice. The identity chosen here decides which Autotask resource we
    // impersonate and which rights the session gets, so it has to be deliberate
    // rather than inherited from browser state.
    url.searchParams.set('prompt', 'select_account');
    res.redirect(url.toString());
  }

  // --- 2. Callback: verify the identity, mint our code -----------------------

  handleCallback = async (req: Request, res: Response): Promise<void> => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const error = typeof req.query.error === 'string' ? req.query.error : undefined;

    if (error) {
      res.status(400).send(`Sign-in failed: ${escapeHtml(error)}`);
      return;
    }
    if (!code || !state) {
      res.status(400).send('Missing code or state');
      return;
    }
    const pending = this.pending.get(state);
    if (!pending) {
      res.status(400).send('Unknown or expired sign-in state. Start the connection again.');
      return;
    }
    this.pending.delete(state);

    let claims: IdTokenClaims | null;
    try {
      claims = await this.exchangeWithGoogle(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[autotask-mcp] Google code exchange failed: ${message}`);
      res.status(502).send('Failed to complete sign-in with Google.');
      return;
    }

    const email = claims?.email?.trim().toLowerCase();
    if (!email) {
      res.status(502).send('Google did not return an email address.');
      return;
    }
    // An unverified address can be attacker-chosen, so it must never satisfy a
    // domain allowlist.
    if (claims?.email_verified !== true && claims?.email_verified !== 'true') {
      res.status(403).send('That Google account has an unverified email address.');
      return;
    }
    if (!isEmailAllowed(email, this.opts.allowedDomains, this.opts.allowedEmails)) {
      console.error(`[autotask-mcp] rejected sign-in for ${email}: not in the allowlist`);
      res.status(403).send(`${escapeHtml(email)} is not permitted to use this server.`);
      return;
    }

    // Resolve identity and rights now, while a browser is present to show the
    // reason. This gates the sign-in rather than decorating it: a person we
    // cannot resolve to exactly one active Autotask resource has no identity to
    // act as, and letting them through would mean writes landing as the API
    // user with nobody's name on them.
    const resolution = await resolveResourceForEmail(email);
    if (!isResolved(resolution)) {
      res.status(403).send(this.refusalPage(email, resolution.reason));
      return;
    }

    const ourCode = randomUUID();
    this.authCodes.set(ourCode, {
      mcpClientId: pending.mcpClientId,
      codeChallenge: pending.codeChallenge,
      mcpRedirectUri: pending.mcpRedirectUri,
      scopes: pending.scopes,
      email,
      resourceId: resolution.resourceId,
      userType: resolution.userType,
      capabilities: resolution.capabilities,
      createdAt: Date.now(),
    });

    const redirect = new URL(pending.mcpRedirectUri);
    redirect.searchParams.set('code', ourCode);
    if (pending.mcpState) redirect.searchParams.set('state', pending.mcpState);
    res.redirect(redirect.toString());
  };

  /**
   * A refusal the person can act on. They authenticated with Google fine; what
   * failed is the Autotask side, and only an Autotask administrator can fix it,
   * so say which account was rejected and why.
   */
  private refusalPage(email: string, reason: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autotask access refused</title>
<style>
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 34rem; margin: 12vh auto; padding: 0 1.5rem; color: #1c1c1c; }
  h1 { font-size: 1.35rem; margin-bottom: .5rem; }
  code { background: #f0f0f0; padding: .1rem .35rem; border-radius: 3px; font-size: .85em; }
  .muted { color: #666; font-size: .85rem; margin-top: 2rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #161616; color: #e8e8e8; }
    code { background: #2a2a2a; }
    .muted { color: #999; }
  }
</style>
</head>
<body>
<h1>Signed in, but not allowed into Autotask</h1>
<p>Google confirmed you as <code>${escapeHtml(email)}</code>, but this server
could not match that to an Autotask account it can act as.</p>
<p><strong>${escapeHtml(reason)}</strong></p>
<p>Every action here is carried out as a specific Autotask person, so without
that match there is nothing to act as. If you signed in with the wrong Google
account, start the connection again and pick the right one.</p>
<p class="muted">Nothing was changed in Autotask.</p>
</body>
</html>`;
  }

  private async exchangeWithGoogle(code: string): Promise<IdTokenClaims | null> {
    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        redirect_uri: this.opts.callbackUrl,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const body = (await resp.json()) as GoogleTokenResponse;
    if (!resp.ok || body.error) {
      throw new Error(body.error_description || body.error || `HTTP ${resp.status}`);
    }
    if (!body.id_token) throw new Error('no id_token in Google response');

    const claims = decodeIdToken(body.id_token);
    if (!claims) throw new Error('unparseable id_token');
    if (claims.aud !== this.opts.clientId) {
      throw new Error('id_token audience does not match our client id');
    }
    if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') {
      throw new Error(`unexpected id_token issuer: ${claims.iss}`);
    }
    return claims;
  }

  // --- 3. Token endpoint -----------------------------------------------------

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.authCodes.get(authorizationCode)?.codeChallenge ?? '';
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry || entry.mcpClientId !== client.client_id) {
      throw new Error('invalid_grant: unknown authorization code');
    }
    // Single use, whatever happens next.
    this.authCodes.delete(authorizationCode);

    return this.issueTokens(
      client.client_id,
      entry.email,
      entry.resourceId,
      entry.userType,
      entry.capabilities,
      entry.scopes,
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const stored = await this.opts.tokenStore.getByRefreshToken(refreshToken);
    if (!stored || stored.clientId !== client.client_id) {
      throw new Error('invalid_grant: unknown refresh token');
    }
    await this.opts.tokenStore.delete(stored.accessToken);

    // Re-resolve on every refresh: someone may have been deactivated, or had
    // their security level changed, since they first signed in. A refresh is
    // the only checkpoint we get, so rights must be re-derived here rather than
    // carried forward from the original sign-in.
    const resolution = await resolveResourceForEmail(stored.email);
    if (!isResolved(resolution)) {
      throw new Error(`invalid_grant: ${resolution.reason}`);
    }
    return this.issueTokens(
      client.client_id,
      stored.email,
      resolution.resourceId,
      resolution.userType,
      resolution.capabilities,
      scopes ?? stored.scopes,
      refreshToken,
    );
  }

  private async issueTokens(
    clientId: string,
    email: string,
    resourceId: number,
    userType: number | undefined,
    capabilities: readonly Capability[],
    scopes?: string[],
    reuseRefreshToken?: string,
  ): Promise<OAuthTokens> {
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = reuseRefreshToken ?? randomBytes(32).toString('hex');

    const stored: StoredToken = {
      accessToken,
      refreshToken,
      clientId,
      expiresAt: Date.now() + this.tokenTtlMs,
      scopes,
      email,
      resourceId,
      userType,
      capabilities: [...capabilities],
    };
    await this.opts.tokenStore.set(stored);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(this.tokenTtlMs / 1000),
      refresh_token: refreshToken,
      scope: scopes?.join(' '),
    };
  }

  // --- 4. Verification, per MCP request --------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = await this.opts.tokenStore.get(token);
    if (!stored) throw new Error('invalid_token: unknown access token');
    if (stored.expiresAt <= Date.now()) {
      await this.opts.tokenStore.delete(token);
      throw new Error('invalid_token: access token expired');
    }
    // A token with no capabilities was minted before rights were enforced, so
    // nobody ever checked whether this person should have been let in. Refuse
    // it rather than guessing a safe floor: the client still holds a refresh
    // token, and refreshing re-resolves the person against Autotask properly.
    if (!stored.capabilities?.length || stored.resourceId === undefined) {
      await this.opts.tokenStore.delete(token);
      throw new Error('invalid_token: issued before authorization, sign in again');
    }

    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes ?? [],
      expiresAt: Math.floor(stored.expiresAt / 1000),
      extra: {
        email: stored.email,
        resourceId: stored.resourceId,
        userType: stored.userType,
        capabilities: stored.capabilities ?? [],
      },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: { token: string; token_type_hint?: string },
  ): Promise<void> {
    if (await this.opts.tokenStore.get(request.token)) {
      await this.opts.tokenStore.delete(request.token);
      return;
    }
    await this.opts.tokenStore.deleteByRefreshToken(request.token);
  }
}
