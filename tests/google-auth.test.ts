import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import { GoogleAuthProvider, decodeIdToken, isEmailAllowed } from '../src/auth/google-provider.js';
import { MemoryClientsStore, TokenStore } from '../src/auth/stores.js';
import { resetResourceCache } from '../src/auth/resource-lookup.js';
import { isImpersonatableWrite } from '../src/autotask-api.js';
import { governor } from '../src/governor.js';

const CLIENT_ID = 'google-client-id.apps.googleusercontent.com';

function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
}

function baseClaims(overrides: Record<string, unknown> = {}) {
  return {
    email: 'dave@phoneware.us',
    email_verified: true,
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com',
    ...overrides,
  };
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  return new GoogleAuthProvider({
    clientId: CLIENT_ID,
    clientSecret: 'google-secret',
    callbackUrl: 'https://mcp.example.com/callback',
    allowedDomains: ['phoneware.us'],
    clientsStore: new MemoryClientsStore(),
    tokenStore: new TokenStore(),
    ...overrides,
  } as never);
}

/** Minimal express Response double: redirect / status / send. */
function mockRes() {
  const res = {
    redirectedTo: '' as string,
    statusCode: 200,
    body: '' as string,
    redirect(url: string) {
      this.redirectedTo = url;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
  };
  return res;
}

const CLIENT = { client_id: 'mcp-client-1', redirect_uris: [] } as never;

beforeEach(() => {
  resetResourceCache();
  governor.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- pure helpers ------------------------------------------------------------

describe('isEmailAllowed', () => {
  it('allows a listed domain, case-insensitively', () => {
    expect(isEmailAllowed('Dave@Phoneware.US', ['phoneware.us'])).toBe(true);
    expect(isEmailAllowed('dave@phoneware.us', ['PHONEWARE.US'])).toBe(true);
  });

  it('rejects any other domain', () => {
    expect(isEmailAllowed('attacker@gmail.com', ['phoneware.us'])).toBe(false);
    // Suffix tricks must not pass: the domain is compared whole.
    expect(isEmailAllowed('attacker@evilphoneware.us', ['phoneware.us'])).toBe(false);
    expect(isEmailAllowed('attacker@phoneware.us.evil.com', ['phoneware.us'])).toBe(false);
  });

  it('honors an explicit address allowlist alongside domains', () => {
    expect(isEmailAllowed('contractor@gmail.com', ['phoneware.us'], ['contractor@gmail.com'])).toBe(
      true,
    );
    expect(isEmailAllowed('other@gmail.com', ['phoneware.us'], ['contractor@gmail.com'])).toBe(
      false,
    );
  });

  it('rejects malformed input', () => {
    expect(isEmailAllowed('not-an-email', ['phoneware.us'])).toBe(false);
    expect(isEmailAllowed('', ['phoneware.us'])).toBe(false);
  });
});

describe('decodeIdToken', () => {
  it('reads the claims out of a well-formed token', () => {
    expect(decodeIdToken(idToken(baseClaims()))?.email).toBe('dave@phoneware.us');
  });

  it('returns null for anything malformed', () => {
    expect(decodeIdToken('nope')).toBeNull();
    expect(decodeIdToken('a.b')).toBeNull();
    expect(decodeIdToken('a.!!!not-base64-json!!!.c')).toBeNull();
  });
});

describe('provider construction', () => {
  it('refuses to start with no allowlist at all', () => {
    // Without this, every Google account on earth could reach the tools.
    expect(() => makeProvider({ allowedDomains: [] })).toThrow(/ALLOWED_DOMAINS/);
  });

  it('starts when only an explicit email allowlist is given', () => {
    expect(() =>
      makeProvider({ allowedDomains: [], allowedEmails: ['dave@phoneware.us'] }),
    ).not.toThrow();
  });
});

// --- authorize ---------------------------------------------------------------

describe('authorize', () => {
  it('redirects to Google with our client id, callback and scopes', async () => {
    const provider = makeProvider();
    const res = mockRes();
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'challenge', redirectUri: 'https://claude.ai/cb', state: 'client-state' },
      res as never,
    );

    const url = new URL(res.redirectedTo);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('https://mcp.example.com/callback');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('response_type')).toBe('code');
    // Single-domain deployments get the account chooser pre-filtered.
    expect(url.searchParams.get('hd')).toBe('phoneware.us');
    // Our own state, not the client's, so the callback can be correlated.
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('state')).not.toBe('client-state');
  });

  it('always makes the person pick an account', async () => {
    // Without prompt=select_account Google silently reuses whatever session the
    // browser already has. The account chosen here decides which Autotask
    // resource we impersonate and what rights the session gets, so it must be
    // a deliberate choice rather than inherited browser state.
    const provider = makeProvider();
    const res = mockRes();
    await provider.authorize(
      CLIENT,
      { codeChallenge: 'challenge', redirectUri: 'https://claude.ai/cb' },
      res as never,
    );

    expect(new URL(res.redirectedTo).searchParams.get('prompt')).toBe('select_account');
  });
});

// --- callback ----------------------------------------------------------------

/** Stub Google's token endpoint and Autotask's Resources query. */
// The default resource is active and a System Administrator, because that is
// what a real Autotask row looks like: sign-in now requires exactly one active
// resource, and rights come from userType.
function stubUpstream(
  claims: Record<string, unknown>,
  resources: unknown[] = [{ id: 77, isActive: true, userType: 14 }],
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ id_token: idToken(claims) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/Resources/query')) {
        return new Response(JSON.stringify({ items: resources }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('ThresholdInformation')) {
        return new Response(
          JSON.stringify({ externalRequestThreshold: 10000, currentTimeframeRequestCount: 10 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

async function startAuth(provider: GoogleAuthProvider) {
  const res = mockRes();
  await provider.authorize(
    CLIENT,
    { codeChallenge: 'challenge', redirectUri: 'https://claude.ai/cb', state: 'client-state' },
    res as never,
  );
  return new URL(res.redirectedTo).searchParams.get('state')!;
}

describe('callback', () => {
  it('rejects an email outside the allowlist', async () => {
    stubUpstream(baseClaims({ email: 'attacker@gmail.com' }));
    const provider = makeProvider();
    const state = await startAuth(provider);
    const res = mockRes();

    await provider.handleCallback({ query: { code: 'g-code', state } } as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(res.redirectedTo).toBe('');
  });

  it('rejects an unverified Google email', async () => {
    // An unverified address is attacker-choosable, so it must never satisfy a
    // domain allowlist.
    stubUpstream(baseClaims({ email_verified: false }));
    const provider = makeProvider();
    const state = await startAuth(provider);
    const res = mockRes();

    await provider.handleCallback({ query: { code: 'g-code', state } } as never, res as never);

    expect(res.statusCode).toBe(403);
  });

  it('rejects an id_token minted for a different audience', async () => {
    stubUpstream(baseClaims({ aud: 'someone-elses-client-id' }));
    const provider = makeProvider();
    const state = await startAuth(provider);
    const res = mockRes();

    await provider.handleCallback({ query: { code: 'g-code', state } } as never, res as never);

    expect(res.statusCode).toBe(502);
  });

  it('rejects an unknown or replayed state', async () => {
    stubUpstream(baseClaims());
    const provider = makeProvider();
    const res = mockRes();

    await provider.handleCallback(
      { query: { code: 'g-code', state: 'never-issued' } } as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
  });

  it('redirects back to the MCP client with a code and the original state', async () => {
    stubUpstream(baseClaims());
    const provider = makeProvider();
    const state = await startAuth(provider);
    const res = mockRes();

    await provider.handleCallback({ query: { code: 'g-code', state } } as never, res as never);

    const redirect = new URL(res.redirectedTo);
    expect(redirect.origin + redirect.pathname).toBe('https://claude.ai/cb');
    expect(redirect.searchParams.get('code')).toBeTruthy();
    expect(redirect.searchParams.get('state')).toBe('client-state');
  });
});

// --- token exchange and verification ----------------------------------------

async function signIn(provider: GoogleAuthProvider): Promise<string> {
  const state = await startAuth(provider);
  const res = mockRes();
  await provider.handleCallback({ query: { code: 'g-code', state } } as never, res as never);
  return new URL(res.redirectedTo).searchParams.get('code')!;
}

describe('token exchange', () => {
  it('issues a token carrying the email and resolved Autotask resource id', async () => {
    stubUpstream(baseClaims(), [{ id: 77, isActive: true }]);
    const provider = makeProvider();
    const code = await signIn(provider);

    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect(auth.extra).toMatchObject({ email: 'dave@phoneware.us', resourceId: 77 });
  });

  it('prefers an active resource over a deactivated one', async () => {
    // Impersonating a departed employee's lingering record would misattribute
    // the work.
    stubUpstream(baseClaims(), [
      { id: 11, isActive: false },
      { id: 22, isActive: true },
    ]);
    const provider = makeProvider();
    const code = await signIn(provider);
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);
    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect((auth.extra as { resourceId?: number }).resourceId).toBe(22);
  });

  it('refuses sign-in when the person has no Autotask resource', async () => {
    // Previously they signed in and their writes silently landed as the API
    // user. That is an unattributable write against a root credential, which is
    // the whole thing this layer exists to stop.
    stubUpstream(baseClaims(), []);
    const provider = makeProvider();
    const state = await startAuth(provider);
    const res = mockRes();
    await provider.handleCallback({ query: { code: 'g-code', state } } as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/No active Autotask resource/i);
    expect(res.redirectedTo).toBe('');
  });

  it('burns the authorization code after one use', async () => {
    stubUpstream(baseClaims());
    const provider = makeProvider();
    const code = await signIn(provider);

    await provider.exchangeAuthorizationCode(CLIENT, code);
    await expect(provider.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow(/invalid_grant/);
  });

  it('refuses a code issued to a different MCP client', async () => {
    stubUpstream(baseClaims());
    const provider = makeProvider();
    const code = await signIn(provider);

    await expect(
      provider.exchangeAuthorizationCode({ client_id: 'someone-else' } as never, code),
    ).rejects.toThrow(/invalid_grant/);
  });

  it('returns the PKCE challenge that started the flow', async () => {
    stubUpstream(baseClaims());
    const provider = makeProvider();
    const code = await signIn(provider);
    expect(await provider.challengeForAuthorizationCode(CLIENT, code)).toBe('challenge');
  });

  it('rotates the access token on refresh and keeps the identity', async () => {
    stubUpstream(baseClaims());
    const provider = makeProvider();
    const code = await signIn(provider);
    const first = await provider.exchangeAuthorizationCode(CLIENT, code);

    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token!);
    expect(second.access_token).not.toBe(first.access_token);

    // The old access token is dead, the new one carries the same person.
    await expect(provider.verifyAccessToken(first.access_token)).rejects.toThrow(/invalid_token/);
    const auth = await provider.verifyAccessToken(second.access_token);
    expect((auth.extra as { email?: string }).email).toBe('dave@phoneware.us');
  });

  it('re-derives rights on refresh when the security level changed', async () => {
    // A refresh is the only checkpoint we get between sign-in and expiry, so
    // a demotion in Autotask has to take effect there rather than being
    // carried forward from whatever was true at sign-in.
    stubUpstream(baseClaims(), [{ id: 77, isActive: true, userType: 14 }]);
    const provider = makeProvider();
    const code = await signIn(provider);
    const first = await provider.exchangeAuthorizationCode(CLIENT, code);
    expect(
      ((await provider.verifyAccessToken(first.access_token)).extra as { capabilities?: string[] })
        .capabilities,
    ).toEqual(['read', 'create', 'update', 'delete']);

    // Demoted to Service Desk User, and the cached lookup has expired.
    resetResourceCache();
    stubUpstream(baseClaims(), [{ id: 77, isActive: true, userType: 20 }]);
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token!);
    const auth = await provider.verifyAccessToken(second.access_token);

    expect((auth.extra as { capabilities?: string[] }).capabilities).toEqual(['read', 'create']);
  });

  it('refuses to refresh someone who has since been deactivated', async () => {
    stubUpstream(baseClaims(), [{ id: 77, isActive: true, userType: 14 }]);
    const provider = makeProvider();
    const code = await signIn(provider);
    const first = await provider.exchangeAuthorizationCode(CLIENT, code);

    resetResourceCache();
    stubUpstream(baseClaims(), [{ id: 77, isActive: false, userType: 14 }]);

    await expect(provider.exchangeRefreshToken(CLIENT, first.refresh_token!)).rejects.toThrow(
      /invalid_grant/,
    );
  });

  it('refuses a token minted before authorization existed', async () => {
    // Nobody checked whether that person should have been let in, so it must
    // not be honoured. The client still holds a refresh token, and refreshing
    // re-resolves them properly.
    const tokenStore = new TokenStore();
    const provider = makeProvider({ tokenStore });
    tokenStore.set({
      accessToken: 'legacy-token',
      refreshToken: 'legacy-refresh',
      clientId: 'mcp-client-1',
      expiresAt: Date.now() + 3_600_000,
      email: 'dave@phoneware.us',
      resourceId: 77,
    });

    await expect(provider.verifyAccessToken('legacy-token')).rejects.toThrow(
      /issued before authorization/,
    );
  });

  it('revokes an access token', async () => {
    stubUpstream(baseClaims());
    const provider = makeProvider();
    const code = await signIn(provider);
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    await provider.revokeToken(CLIENT, { token: tokens.access_token });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/invalid_token/);
  });

  it('rejects an expired access token', async () => {
    stubUpstream(baseClaims());
    const provider = makeProvider({ tokenTtlSeconds: -1 });
    const code = await signIn(provider);
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/expired/);
  });

  it('rejects a token it never issued', async () => {
    const provider = makeProvider();
    await expect(provider.verifyAccessToken('made-up')).rejects.toThrow(/invalid_token/);
  });
});

// --- impersonation targeting -------------------------------------------------

describe('isImpersonatableWrite', () => {
  it('is true only for entity creates', () => {
    expect(isImpersonatableWrite('POST', 'V1.0/Tickets')).toBe(true);
    expect(isImpersonatableWrite('POST', 'V1.0/Tickets/123/Notes')).toBe(true);
  });

  it('is false for queries, counts, reads and updates', () => {
    // Autotask supports impersonation on creates only, and sending the header
    // where it is unsupported can fail a call that would otherwise work.
    expect(isImpersonatableWrite('POST', 'V1.0/Tickets/query')).toBe(false);
    expect(isImpersonatableWrite('POST', 'V1.0/Tickets/query/count')).toBe(false);
    expect(isImpersonatableWrite('GET', 'V1.0/Tickets/1')).toBe(false);
    expect(isImpersonatableWrite('PATCH', 'V1.0/Tickets')).toBe(false);
    expect(isImpersonatableWrite('DELETE', 'V1.0/Tickets/1')).toBe(false);
  });
});
