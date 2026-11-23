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
 *   1. MCP client → /authorize → authorize() seals the pending request into a
 *      cookie bound to this browser and redirects the browser to Google, with a
 *      random nonce as the state.
 *   2. Google → /callback → handleCallback() checks the nonce against the sealed
 *      cookie, exchanges the code for an id_token, verifies it, enforces the
 *      domain allowlist, resolves the Autotask resource, seals an authorization
 *      code, and redirects back.
 *   3. MCP client → /token → exchangeAuthorizationCode() opens the sealed code,
 *      claims its jti in the token store so it can be redeemed once, and issues
 *      our access and refresh tokens carrying the email and resource id.
 *   4. /mcp → verifyAccessToken() returns them as AuthInfo.extra.
 *
 * Nothing about a sign-in in flight is held in this process, so any instance can
 * take any step. Only Google ever sees a password; none passes through this server.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { z } from 'zod';
import type { StoredToken, TokenStoreLike } from './stores.js';
import { resolveResourceForEmail, isResolved } from './resource-lookup.js';
import type { Capability } from './capabilities.js';
import { SEAL_PURPOSES, Sealer } from './sealed.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const DEFAULT_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** Days a refresh token may go unused before it expires. Each refresh resets the clock. */
export const DEFAULT_REFRESH_IDLE_TTL_DAYS = 90;

/** Cookie that carries the sealed pending sign-in from /authorize to /callback. */
export const PENDING_COOKIE = 'autotask_mcp_oauth_pending';
const CALLBACK_PATH = '/callback';

/**
 * Longest sealed value a sign-in can carry. Browsers drop cookies past about
 * 4 KB, and a dropped cookie fails the sign-in with no visible cause, so an
 * oversized request is refused up front.
 */
const MAX_SEALED_LENGTH = 3500;

/** A sign-in in flight, sealed into PENDING_COOKIE. */
const PendingPayloadSchema = z.object({
  mcpClientId: z.string(),
  codeChallenge: z.string(),
  mcpRedirectUri: z.string(),
  mcpState: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  /** Sent to Google as `state`. The callback must echo it back. */
  nonce: z.string(),
  expiresAt: z.number(),
});
type PendingPayload = z.infer<typeof PendingPayloadSchema>;

/** An authorization code, sealed and handed to the MCP client. */
const AuthorizationCodePayloadSchema = z.object({
  /** Identifies the code for single use. */
  jti: z.string(),
  mcpClientId: z.string(),
  codeChallenge: z.string(),
  mcpRedirectUri: z.string(),
  scopes: z.array(z.string()).optional(),
  email: z.string(),
  resourceId: z.number(),
  userType: z.number().optional(),
  capabilities: z.array(z.enum(['read', 'create', 'update', 'delete'])),
  expiresAt: z.number(),
});
type AuthorizationCodePayload = z.infer<typeof AuthorizationCodePayloadSchema>;

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
  /**
   * Key material for sealing sign-in state, normally AUTOTASK_SECRET. It is
   * checked by assertSealingSecret, so a short or placeholder value refuses to
   * start.
   */
  sealingSecret: string;
  /** How long a refresh token may go unused before it expires. Defaults to 90 days. */
  refreshIdleTtlMs?: number;
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

/**
 * REFRESH_TOKEN_IDLE_TTL_DAYS in milliseconds. Unset or empty means the default.
 * Anything other than a positive whole number of days is an error, so a typo
 * cannot silently change how long a sign-in lasts.
 */
export function refreshIdleTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REFRESH_TOKEN_IDLE_TTL_DAYS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_REFRESH_IDLE_TTL_DAYS * DAY_MS;
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(
      `REFRESH_TOKEN_IDLE_TTL_DAYS must be a positive whole number of days, got "${raw}"`,
    );
  }
  return days * DAY_MS;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** The value of one cookie from a Cookie request header. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** Compare two strings in constant time, so a wrong nonce leaks nothing about how close it was. */
function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Errors the token endpoint returns as they are. Anything else becomes a retryable error. */
function asTokenEndpointError(err: unknown): Error {
  if (
    err instanceof InvalidGrantError ||
    err instanceof InvalidScopeError ||
    err instanceof TemporarilyUnavailableError
  ) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new TemporarilyUnavailableError(message);
}

export class GoogleAuthProvider implements OAuthServerProvider {
  private readonly sealer: Sealer;
  private readonly tokenTtlMs: number;
  private readonly refreshIdleTtlMs: number;

  constructor(private readonly opts: GoogleAuthProviderOptions) {
    if (opts.allowedDomains.length === 0 && (opts.allowedEmails ?? []).length === 0) {
      throw new Error(
        'Google sign-in requires AUTOTASK_OAUTH_ALLOWED_DOMAINS (or AUTOTASK_OAUTH_ALLOWED_EMAILS). ' +
          'Refusing to start an authorization server that any Google account could pass.',
      );
    }
    this.sealer = new Sealer(opts.sealingSecret);
    this.tokenTtlMs = (opts.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000;
    this.refreshIdleTtlMs = opts.refreshIdleTtlMs ?? DEFAULT_REFRESH_IDLE_TTL_DAYS * DAY_MS;
    if (!(this.refreshIdleTtlMs > 0)) {
      throw new Error('refreshIdleTtlMs must be a positive number of milliseconds');
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.opts.clientsStore;
  }

  // --- 1. Authorization: seal the request, send the browser to Google --------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const nonce = randomBytes(16).toString('hex');
    const pending: PendingPayload = {
      mcpClientId: client.client_id,
      codeChallenge: params.codeChallenge,
      mcpRedirectUri: params.redirectUri,
      mcpState: params.state,
      scopes: params.scopes,
      nonce,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    const sealed = this.sealer.seal(SEAL_PURPOSES.pendingAuthorization, pending);
    if (sealed.length > MAX_SEALED_LENGTH) {
      throw new InvalidRequestError(
        'The authorization request is too large to carry through sign-in.',
      );
    }
    res.cookie(PENDING_COOKIE, sealed, { ...this.cookieAttributes(), maxAge: PENDING_TTL_MS });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.opts.clientId);
    url.searchParams.set('redirect_uri', this.opts.callbackUrl);
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', nonce);
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

    // Only the browser that started the sign-in can finish it, and only by
    // echoing the nonce it was given. Any instance can check both, because the
    // cookie is sealed rather than kept in memory.
    const pending = this.pendingFrom(req);
    if (!pending || state === undefined || !sameValue(state, pending.nonce)) {
      res.status(400).send('Unknown or expired sign-in state. Start the connection again.');
      return;
    }
    // Spent. This browser cannot replay the same sign-in with the same cookie.
    res.clearCookie(PENDING_COOKIE, this.cookieAttributes());

    if (error) {
      res.status(400).send(`Sign-in failed: ${escapeHtml(error)}`);
      return;
    }
    if (!code) {
      res.status(400).send('Missing code or state');
      return;
    }

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

    const ourCode = this.sealer.seal(SEAL_PURPOSES.authorizationCode, {
      jti: randomUUID(),
      mcpClientId: pending.mcpClientId,
      codeChallenge: pending.codeChallenge,
      mcpRedirectUri: pending.mcpRedirectUri,
      scopes: pending.scopes,
      email,
      resourceId: resolution.resourceId,
      userType: resolution.userType,
      capabilities: [...resolution.capabilities],
      expiresAt: Date.now() + CODE_TTL_MS,
    } satisfies AuthorizationCodePayload);

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
    return this.openAuthorizationCode(authorizationCode)?.codeChallenge ?? '';
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    try {
      return await this.redeemAuthorizationCode(client, authorizationCode, redirectUri);
    } catch (err) {
      throw asTokenEndpointError(err);
    }
  }

  private async redeemAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    redirectUri: string | undefined,
  ): Promise<OAuthTokens> {
    const entry = this.openAuthorizationCode(authorizationCode);
    if (!entry || entry.mcpClientId !== client.client_id) {
      throw new InvalidGrantError('unknown authorization code');
    }
    // RFC 6749 section 4.1.3: the redirect_uri must be the one the code was issued for.
    if (redirectUri !== undefined && redirectUri !== entry.mcpRedirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    // Claimed before any token is issued, in the store every instance shares. A
    // second redemption fails whichever instance receives it.
    const claimed = await this.opts.tokenStore.claimAuthorizationCode(entry.jti, entry.expiresAt);
    if (!claimed) {
      throw new InvalidGrantError('authorization code already used');
    }

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
    try {
      return await this.performExchangeRefreshToken(client, refreshToken, scopes);
    } catch (err) {
      throw asTokenEndpointError(err);
    }
  }

  private async performExchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const stored = await this.opts.tokenStore.getByRefreshToken(refreshToken);
    if (stored?.clientId !== undefined && stored.clientId !== client.client_id) {
      throw new InvalidGrantError('unknown refresh token');
    }
    if (!stored) {
      const rotation = await this.opts.tokenStore.rotateRefreshToken(
        refreshToken,
        this.unusedRefreshReplacement(client.client_id),
        client.client_id,
      );
      if (rotation.status === 'retry' && rotation.token.clientId === client.client_id) {
        return this.tokensFromStored(rotation.token);
      }
      throw new InvalidGrantError('unknown refresh token');
    }

    const now = Date.now();
    // A token written before the idle window existed has no last-used stamp. It is
    // grandfathered: accepted now, and stamped by the rotation below, so its 90 days
    // run from this first use. Lacking the stamp is never a reason to refuse it.
    const lastUsedAt = stored.refreshLastUsedAt ?? now;
    if (now - lastUsedAt > this.refreshIdleTtlMs) {
      // Expired by disuse. Nothing in this family is worth keeping.
      await this.opts.tokenStore.deleteByRefreshToken(refreshToken);
      throw new InvalidGrantError('refresh token unused for too long; sign in again');
    }

    if (scopes) {
      const granted = new Set(stored.scopes ?? []);
      const unauthorized = scopes.find((scope) => !granted.has(scope));
      if (unauthorized) {
        throw new InvalidScopeError(`refresh requested ungranted scope: ${unauthorized}`);
      }
    }

    // Identity is checked on every refresh. That is the only point where a
    // deactivated person loses access, so it cannot be skipped. A refusal is not
    // a replay and does not spend the refresh token, so the same token works once
    // the person is active again. The access token in use is revoked, because
    // nothing else checks identity between refreshes.
    const resolution = await resolveResourceForEmail(stored.email, { cache: false });
    if (!isResolved(resolution)) {
      if (resolution.reason.startsWith('Could not reach Autotask')) {
        throw new TemporarilyUnavailableError(resolution.reason);
      }
      if (stored.refreshFamilyId) {
        await this.opts.tokenStore.revokeFamilyAccess(stored.refreshFamilyId);
      }
      throw new InvalidGrantError(resolution.reason);
    }

    const issued = this.buildStoredToken(
      client.client_id,
      stored.email,
      resolution.resourceId,
      resolution.userType,
      resolution.capabilities,
      scopes ?? stored.scopes,
      stored.refreshFamilyId,
      now,
    );
    const rotation = await this.opts.tokenStore.rotateRefreshToken(
      refreshToken,
      issued.stored,
      client.client_id,
      now,
    );
    if (rotation.status !== 'claimed' && rotation.status !== 'retry') {
      throw new InvalidGrantError('unknown refresh token');
    }
    return this.tokensFromStored(rotation.token);
  }

  private unusedRefreshReplacement(clientId: string): StoredToken {
    return {
      accessToken: 'unused-refresh-replacement-access-token',
      refreshToken: 'unused-refresh-replacement-refresh-token',
      clientId,
      expiresAt: 0,
      email: 'unused@invalid',
      capabilities: [],
    };
  }

  private async issueTokens(
    clientId: string,
    email: string,
    resourceId: number,
    userType: number | undefined,
    capabilities: readonly Capability[],
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const issued = this.buildStoredToken(
      clientId,
      email,
      resourceId,
      userType,
      capabilities,
      scopes,
    );
    await this.opts.tokenStore.set(issued.stored);
    return issued.tokens;
  }

  private buildStoredToken(
    clientId: string,
    email: string,
    resourceId: number,
    userType: number | undefined,
    capabilities: readonly Capability[],
    scopes?: string[],
    refreshFamilyId?: string,
    now: number = Date.now(),
  ): { stored: StoredToken; tokens: OAuthTokens } {
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');

    const stored: StoredToken = {
      accessToken,
      refreshToken,
      clientId,
      refreshFamilyId,
      expiresAt: now + this.tokenTtlMs,
      refreshLastUsedAt: now,
      scopes,
      email,
      resourceId,
      userType,
      capabilities: [...capabilities],
    };

    return {
      stored,
      tokens: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(this.tokenTtlMs / 1000),
        refresh_token: refreshToken,
        scope: scopes?.join(' '),
      },
    };
  }

  private tokensFromStored(stored: StoredToken): OAuthTokens {
    return {
      access_token: stored.accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((stored.expiresAt - Date.now()) / 1000)),
      refresh_token: stored.refreshToken,
      scope: stored.scopes?.join(' '),
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
      await this.opts.tokenStore.revokeByAccessToken(request.token);
      return;
    }
    await this.opts.tokenStore.deleteByRefreshToken(request.token);
  }

  // --- helpers ---------------------------------------------------------------

  /** The sealed pending sign-in from this browser's cookie, if it is still valid. */
  private pendingFrom(req: Request): PendingPayload | undefined {
    const sealed = readCookie(req.headers.cookie, PENDING_COOKIE);
    if (sealed === undefined) return undefined;
    const parsed = PendingPayloadSchema.safeParse(
      this.sealer.unseal(SEAL_PURPOSES.pendingAuthorization, sealed),
    );
    return parsed.success && parsed.data.expiresAt > Date.now() ? parsed.data : undefined;
  }

  /** The sealed authorization code, if it is genuine and not yet expired. */
  private openAuthorizationCode(authorizationCode: string): AuthorizationCodePayload | undefined {
    const parsed = AuthorizationCodePayloadSchema.safeParse(
      this.sealer.unseal(SEAL_PURPOSES.authorizationCode, authorizationCode),
    );
    return parsed.success && parsed.data.expiresAt > Date.now() ? parsed.data : undefined;
  }

  /** Attributes shared by setting and clearing the pending cookie. */
  private cookieAttributes() {
    return {
      httpOnly: true,
      // Google returns the browser with a top-level GET, which SameSite=Lax still accompanies.
      sameSite: 'lax' as const,
      secure: new URL(this.opts.callbackUrl).protocol === 'https:',
      path: CALLBACK_PATH,
    };
  }
}
