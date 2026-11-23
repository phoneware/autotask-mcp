/**
 * Durability of Google sign-in across instances, and the refresh-token rules.
 *
 * Every "instance" below is a separate app with its own provider and store
 * objects. The instances share one fake Firestore and one sealing secret, which
 * is all a second Cloud Run instance has in common with the first. Nothing is
 * shared in process memory, so a test that passes here cannot be passing on
 * memory the other instance happened to hold.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeFirestore } from './test-support/fake-firestore.js';
import { createApp, defaultCreateSession, SessionStore, validateStartup } from '../src/http.js';
import {
  GoogleAuthProvider,
  PENDING_COOKIE,
  refreshIdleTtlMsFromEnv,
} from '../src/auth/google-provider.js';
import { FirestoreClientsStore, FirestoreTokenStore } from '../src/auth/firestore-stores.js';
import { assertSealingSecret, Sealer, SEAL_PURPOSES } from '../src/auth/sealed.js';
import { resetResourceCache } from '../src/auth/resource-lookup.js';
import { governor } from '../src/governor.js';

const SEALING_SECRET = 'sealing-secret-for-tests-only-0123456789';

/** A secret of the shape production was measured at: 25 bytes, 24 distinct byte values. */
const PRODUCTION_SHAPED_SECRET = 'aB3dE5fG7hJ9kL2mN4pQ6rS8a';

const GOOGLE_CLIENT_ID = 'google-client-id.apps.googleusercontent.com';
const PUBLIC_BASE = 'https://mcp.example.test';
const PUBLIC_CALLBACK = `${PUBLIC_BASE}/callback`;
const MCP_CLIENT = 'durable-client-1';
const MCP_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

type Json = Record<string, unknown>;

interface Instance {
  url: string;
  provider: GoogleAuthProvider;
  tokens: FirestoreTokenStore;
  close: () => Promise<void>;
}

interface SignInCookie {
  /** The Google `state` the browser was sent with. */
  state: string;
  /** The `name=value` pair the browser returns to /callback. */
  cookie: string;
}

const realFetch = globalThis.fetch;
let db: FakeFirestore;
const instances: Instance[] = [];

beforeEach(() => {
  resetResourceCache();
  governor.reset();
  db = new FakeFirestore({ ignoreUndefinedProperties: true });
});

afterEach(async () => {
  while (instances.length > 0) await instances.pop()!.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- instances and HTTP ------------------------------------------------------

/**
 * Stores built over the shared database. The real Firestore client is never
 * used: the stores read their database from these fields, so the fake is
 * substituted here, as the other OAuth tests do.
 */
function storesOver(database: FakeFirestore): {
  tokens: FirestoreTokenStore;
  clients: FirestoreClientsStore;
} {
  const tokens = new FirestoreTokenStore();
  const clients = new FirestoreClientsStore();
  // @ts-expect-error the store's database is private; tests substitute the shared fake
  tokens.db = database;
  // @ts-expect-error the store's database is private; tests substitute the shared fake
  clients.db = database;
  return { tokens, clients };
}

/** One instance: its own provider and stores, serving on its own loopback port. */
async function startInstance(sealingSecret: string = SEALING_SECRET): Promise<Instance> {
  const { tokens, clients } = storesOver(db);
  const provider = new GoogleAuthProvider({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: 'google-secret',
    callbackUrl: PUBLIC_CALLBACK,
    allowedDomains: ['phoneware.us'],
    clientsStore: clients,
    tokenStore: tokens,
    tokenTtlSeconds: 3600,
    sealingSecret,
  });
  const app = createApp({
    googleProvider: provider,
    baseUrl: new URL(PUBLIC_BASE),
    sessions: new SessionStore(),
    limiter: null,
    allowedOrigins: [],
    allowedHosts: [],
    maxBodyBytes: 1024 * 1024,
    createSession: defaultCreateSession,
    persistence: 'firestore',
    redirectAllowlist: [MCP_REDIRECT],
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const instance: Instance = {
    url: `http://127.0.0.1:${port}`,
    provider,
    tokens,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
  instances.push(instance);
  return instance;
}

/** Google and Autotask stand-ins. Requests to our own loopback instances go to the network. */
function stubUpstream(email = 'dave@phoneware.us') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1')) return realFetch(url, init);
      if (url.includes('oauth2.googleapis.com/token')) {
        return jsonResponse({
          id_token: idToken({
            email,
            email_verified: true,
            aud: GOOGLE_CLIENT_ID,
            iss: 'https://accounts.google.com',
          }),
        });
      }
      if (url.includes('/Resources/query')) {
        return jsonResponse({ items: [{ id: 77, isActive: true, userType: 14 }] });
      }
      if (url.includes('ThresholdInformation') || url.includes('zoneInformation')) {
        return jsonResponse({ externalRequestThreshold: 10000, currentTimeframeRequestCount: 10 });
      }
      return realFetch(url, init);
    }),
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
}

function authorizeUrl(instance: Instance): string {
  const query = new URLSearchParams({
    client_id: MCP_CLIENT,
    redirect_uri: MCP_REDIRECT,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
  });
  return `${instance.url}/authorize?${query.toString()}`;
}

/** What the browser does at /authorize: keep the cookie, follow the redirect to Google. */
async function beginSignIn(instance: Instance): Promise<SignInCookie> {
  const res = await realFetch(authorizeUrl(instance), { redirect: 'manual' });
  if (res.status !== 302) throw new Error(`authorize ${res.status}: ${await res.text()}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const state = new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '';
  return { state, cookie };
}

/** What the browser does after Google: return to /callback with the cookie and the echoed state. */
async function finishSignIn(instance: Instance, session: SignInCookie): Promise<URL> {
  const res = await realFetch(
    `${instance.url}/callback?code=google-code&state=${encodeURIComponent(session.state)}`,
    { redirect: 'manual', headers: { cookie: session.cookie } },
  );
  if (res.status !== 302) throw new Error(`callback ${res.status}: ${await res.text()}`);
  return new URL(res.headers.get('location') ?? '');
}

/** A complete sign-in whose first and last steps may land on different instances. */
async function signInCode(begin: Instance, finish: Instance): Promise<string> {
  const session = await beginSignIn(begin);
  const redirect = await finishSignIn(finish, session);
  return redirect.searchParams.get('code') ?? '';
}

async function redeem(
  instance: Instance,
  code: string,
  redirectUri = MCP_REDIRECT,
): Promise<{ status: number; body: Json }> {
  const res = await realFetch(`${instance.url}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: MCP_CLIENT,
      redirect_uri: redirectUri,
      code_verifier: VERIFIER,
    }).toString(),
  });
  const body: Json = await res.json();
  return { status: res.status, body };
}

async function refresh(
  instance: Instance,
  refreshToken: string,
): Promise<{ status: number; body: Json }> {
  const res = await realFetch(`${instance.url}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: MCP_CLIENT,
    }).toString(),
  });
  const body: Json = await res.json();
  return { status: res.status, body };
}

/** Freezes the clock at the start and moves it only when the test says so. */
function fakeClock(start: number) {
  const clock = {
    now: start,
    advance(ms: number) {
      clock.now += ms;
    },
  };
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  return clock;
}

// --- a sign-in that changes instance ----------------------------------------

describe('a sign-in that changes instance', () => {
  it('starts on one instance and completes on another that shares only the store and the secret', async () => {
    const first = await startInstance();
    const second = await startInstance();
    stubUpstream();

    const session = await beginSignIn(first);
    const redirect = await finishSignIn(second, session);
    expect(redirect.origin + redirect.pathname).toBe(MCP_REDIRECT);

    const issued = await redeem(second, redirect.searchParams.get('code') ?? '');
    expect(issued.status).toBe(200);
    expect(issued.body.access_token).toEqual(expect.any(String));
    expect(issued.body.refresh_token).toEqual(expect.any(String));

    // The token is honoured by the instance that never saw the sign-in begin.
    await expect(
      first.provider.verifyAccessToken(String(issued.body.access_token)),
    ).resolves.toMatchObject({ extra: { email: 'dave@phoneware.us', resourceId: 77 } });
  });

  it('completes a sign-in across instances with a production-shaped secret', async () => {
    const first = await startInstance(PRODUCTION_SHAPED_SECRET);
    const second = await startInstance(PRODUCTION_SHAPED_SECRET);
    stubUpstream();

    const code = await signInCode(first, second);
    const issued = await redeem(second, code);

    expect(issued.status).toBe(200);
    expect(issued.body.access_token).toEqual(expect.any(String));
  });

  it('sets the sign-in cookie for the callback only, and HttpOnly', async () => {
    const instance = await startInstance();
    const res = await realFetch(authorizeUrl(instance), { redirect: 'manual' });

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(new RegExp(`^${PENDING_COOKIE}=`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/callback');
    // The public callback is https, so the cookie must not travel over plain http.
    expect(setCookie).toContain('Secure');
  });

  it('refuses a callback from a browser that does not hold the sign-in cookie', async () => {
    const instance = await startInstance();
    stubUpstream();
    const session = await beginSignIn(instance);

    const res = await realFetch(
      `${instance.url}/callback?code=google-code&state=${encodeURIComponent(session.state)}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redeems an authorization code once, on any instance', async () => {
    const first = await startInstance();
    const second = await startInstance();
    stubUpstream();
    const code = await signInCode(first, second);

    expect((await redeem(first, code)).status).toBe(200);

    // The second redemption is refused wherever it lands.
    const onSecond = await redeem(second, code);
    expect(onSecond.status).toBe(400);
    expect(onSecond.body.error).toBe('invalid_grant');
    const onFirst = await redeem(first, code);
    expect(onFirst.status).toBe(400);
    expect(onFirst.body.error).toBe('invalid_grant');
  });

  it('refuses a code presented with another redirect_uri, and does not spend it', async () => {
    const instance = await startInstance();
    stubUpstream();
    const code = await signInCode(instance, instance);

    const wrong = await redeem(instance, code, 'https://claude.ai/some/other/path');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');

    expect((await redeem(instance, code)).status).toBe(200);
  });

  it('refuses a sign-in cookie presented as an authorization code', async () => {
    const instance = await startInstance();
    stubUpstream();
    const session = await beginSignIn(instance);
    const sealedPending = session.cookie.slice(session.cookie.indexOf('=') + 1);

    const attempt = await redeem(instance, sealedPending);
    expect(attempt.status).toBe(400);
    expect(attempt.body.error).toBe('invalid_grant');
  });

  it('refuses an altered authorization code', async () => {
    const instance = await startInstance();
    stubUpstream();
    const code = await signInCode(instance, instance);
    const bytes = Buffer.from(code, 'base64url');
    bytes[bytes.length - 1] ^= 0x01;

    const attempt = await redeem(instance, bytes.toString('base64url'));
    expect(attempt.status).toBe(400);
    expect(attempt.body.error).toBe('invalid_grant');
  });

  it('refuses an authorization code presented more than five minutes after it was issued', async () => {
    const clock = fakeClock(Date.now());
    const instance = await startInstance();
    stubUpstream();
    const code = await signInCode(instance, instance);

    clock.advance(5 * MINUTE + 1);

    expect((await redeem(instance, code)).status).toBe(400);
  });

  it('refuses a sign-in left pending for more than ten minutes', async () => {
    const clock = fakeClock(Date.now());
    const instance = await startInstance();
    stubUpstream();
    const session = await beginSignIn(instance);

    clock.advance(10 * MINUTE + 1);

    await expect(finishSignIn(instance, session)).rejects.toThrow(/callback 400/);
  });
});

// --- the refresh token idle window ------------------------------------------

describe('the refresh token idle window', () => {
  it('expires a refresh token unused for 90 days, and each refresh resets the window', async () => {
    const clock = fakeClock(Date.now());
    const instance = await startInstance();
    stubUpstream();
    const issued = await redeem(instance, await signInCode(instance, instance));
    let refreshToken = String(issued.body.refresh_token);

    clock.advance(89 * DAY);
    const second = await refresh(instance, refreshToken);
    expect(second.status).toBe(200);
    refreshToken = String(second.body.refresh_token);

    // 178 days since issue, but only 89 since the last use: still alive.
    clock.advance(89 * DAY);
    const third = await refresh(instance, refreshToken);
    expect(third.status).toBe(200);
    refreshToken = String(third.body.refresh_token);

    clock.advance(91 * DAY);
    const expired = await refresh(instance, refreshToken);
    expect(expired.status).toBe(400);
    expect(expired.body.error).toBe('invalid_grant');
    expect(String(expired.body.error_description)).toMatch(/unused for too long/);
  });

  it('starts the 90-day window at the first use of a token written before the window existed', async () => {
    const clock = fakeClock(Date.now());
    const instance = await startInstance();
    // The authorize request registers the test client, as a real sign-in does.
    await beginSignIn(instance);
    stubUpstream();
    // Written by an earlier release: no last-used stamp, and its access expiry is long past.
    await instance.tokens.set({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      clientId: MCP_CLIENT,
      expiresAt: Date.now() - 400 * DAY,
      email: 'dave@phoneware.us',
      resourceId: 77,
      userType: 14,
      capabilities: ['read', 'create', 'update', 'delete'],
    });

    // Never refused for lacking the stamp, however old the record is.
    const first = await refresh(instance, 'legacy-refresh');
    expect(first.status).toBe(200);
    let refreshToken = String(first.body.refresh_token);

    // The first use started the clock: 89 idle days are fine, 91 are not.
    clock.advance(89 * DAY);
    const second = await refresh(instance, refreshToken);
    expect(second.status).toBe(200);
    refreshToken = String(second.body.refresh_token);

    clock.advance(91 * DAY);
    const expired = await refresh(instance, refreshToken);
    expect(expired.status).toBe(400);
    expect(String(expired.body.error_description)).toMatch(/unused for too long/);
  });

  it('keeps a live refresh token through a sweep of its expired access token', async () => {
    const clock = fakeClock(Date.now());
    const instance = await startInstance();
    stubUpstream();
    const issued = await redeem(instance, await signInCode(instance, instance));

    clock.advance(2 * 60 * MINUTE);
    await instance.tokens.sweep(Date.now());

    const refreshed = await refresh(instance, String(issued.body.refresh_token));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toEqual(expect.any(String));
  });
});

// --- configuration and startup refusals -------------------------------------

describe('REFRESH_TOKEN_IDLE_TTL_DAYS', () => {
  it('defaults to 90 days', () => {
    expect(refreshIdleTtlMsFromEnv({})).toBe(90 * DAY);
  });

  it('takes a whole number of days', () => {
    expect(refreshIdleTtlMsFromEnv({ REFRESH_TOKEN_IDLE_TTL_DAYS: '30' })).toBe(30 * DAY);
  });

  it('treats an empty value as unset', () => {
    expect(refreshIdleTtlMsFromEnv({ REFRESH_TOKEN_IDLE_TTL_DAYS: '  ' })).toBe(90 * DAY);
  });

  it.each(['0', '-5', '1.5', '90d', 'ninety', '1e2'])('refuses %s', (value) => {
    expect(() => refreshIdleTtlMsFromEnv({ REFRESH_TOKEN_IDLE_TTL_DAYS: value })).toThrow(
      /positive whole number of days/,
    );
  });
});

describe('startup refusals', () => {
  const googleEnv = {
    AUTOTASK_OAUTH_CLIENT_ID: GOOGLE_CLIENT_ID,
    AUTOTASK_OAUTH_CLIENT_SECRET: 'google-secret',
  };

  it('refuses a malformed idle window before serving anything', () => {
    expect(() => validateStartup({ REFRESH_TOKEN_IDLE_TTL_DAYS: '0' })).toThrow(
      /REFRESH_TOKEN_IDLE_TTL_DAYS/,
    );
  });

  it('refuses Google sign-in without a usable sealing secret', () => {
    expect(() => validateStartup({ ...googleEnv })).toThrow(/AUTOTASK_SECRET is not set/);
    expect(() => validateStartup({ ...googleEnv, AUTOTASK_SECRET: 'abcdefghijklmno' })).toThrow(
      /at least 16 bytes/,
    );
    expect(() => validateStartup({ ...googleEnv, AUTOTASK_SECRET: 'super-secret-value' })).toThrow(
      /placeholder/,
    );
    expect(() => validateStartup({ ...googleEnv, AUTOTASK_SECRET: 'ab'.repeat(16) })).toThrow(
      /distinct byte values/,
    );
  });

  it('starts with a production-shaped secret, and needs no secret without Google sign-in', () => {
    expect(validateStartup({ ...googleEnv, AUTOTASK_SECRET: PRODUCTION_SHAPED_SECRET })).toEqual({
      refreshIdleTtlMs: 90 * DAY,
    });
    expect(validateStartup({})).toEqual({ refreshIdleTtlMs: 90 * DAY });
  });
});

describe('the sealing secret', () => {
  it('accepts the production-shaped secret: 25 bytes, 24 distinct byte values', () => {
    // The live AUTOTASK_SECRET was measured at this shape. The floor must stay below it.
    expect(Buffer.byteLength(PRODUCTION_SHAPED_SECRET)).toBe(25);
    expect(new Set(Buffer.from(PRODUCTION_SHAPED_SECRET)).size).toBe(24);
    expect(() => assertSealingSecret(PRODUCTION_SHAPED_SECRET)).not.toThrow();
  });

  it('accepts the floor itself: 16 bytes with 12 distinct byte values', () => {
    expect(() => assertSealingSecret('abcdefghijkl' + 'aaaa')).not.toThrow();
  });

  it('refuses 16 bytes with only 11 distinct byte values', () => {
    expect(() => assertSealingSecret('abcdefghijk' + 'aaaaa')).toThrow(/11 distinct byte values/);
  });

  it('refuses a secret shorter than 16 bytes', () => {
    expect(() => assertSealingSecret('abcdefghijklmno')).toThrow(/at least 16 bytes/);
    expect(() => new Sealer('abcdefghijklmno')).toThrow(/at least 16 bytes/);
  });

  it('refuses a placeholder, whatever its length', () => {
    expect(() => assertSealingSecret('super-secret-value')).toThrow(/placeholder/);
  });

  it('refuses a secret with few distinct byte values, whatever its length', () => {
    expect(() => assertSealingSecret('ab'.repeat(16))).toThrow(/2 distinct byte values/);
  });

  it('measures length in bytes, not characters', () => {
    // Eleven accented letters: 11 characters, 22 bytes, 12 distinct byte values.
    expect(() => assertSealingSecret('àáâãäåæçèéê')).not.toThrow();
  });
});

describe('sealed state', () => {
  const sealer = new Sealer(SEALING_SECRET);

  it('opens only under the purpose it was sealed for', () => {
    const sealed = sealer.seal(SEAL_PURPOSES.authorizationCode, { hello: 'world' });

    expect(sealer.unseal(SEAL_PURPOSES.authorizationCode, sealed)).toEqual({ hello: 'world' });
    expect(sealer.unseal(SEAL_PURPOSES.pendingAuthorization, sealed)).toBeUndefined();
  });

  it('opens only under the secret it was sealed with', () => {
    const sealed = sealer.seal(SEAL_PURPOSES.authorizationCode, { hello: 'world' });
    const other = new Sealer('another-sealing-secret-0123456789abcd');

    expect(other.unseal(SEAL_PURPOSES.authorizationCode, sealed)).toBeUndefined();
  });

  it('refuses an altered, truncated or foreign value', () => {
    const sealed = sealer.seal(SEAL_PURPOSES.authorizationCode, { hello: 'world' });
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[bytes.length - 1] ^= 0x01;

    expect(
      sealer.unseal(SEAL_PURPOSES.authorizationCode, bytes.toString('base64url')),
    ).toBeUndefined();
    expect(sealer.unseal(SEAL_PURPOSES.authorizationCode, sealed.slice(0, 20))).toBeUndefined();
    expect(sealer.unseal(SEAL_PURPOSES.authorizationCode, 'not-a-sealed-value')).toBeUndefined();
  });

  it('seals and opens with a production-shaped secret, and not with any other', () => {
    const production = new Sealer(PRODUCTION_SHAPED_SECRET);
    const sealed = production.seal(SEAL_PURPOSES.pendingAuthorization, { nonce: 'n-1' });

    expect(production.unseal(SEAL_PURPOSES.pendingAuthorization, sealed)).toEqual({
      nonce: 'n-1',
    });
    expect(sealer.unseal(SEAL_PURPOSES.pendingAuthorization, sealed)).toBeUndefined();
  });
});
