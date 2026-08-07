/**
 * Where OAuth state lives, and what a client is told when its registration is
 * gone.
 *
 * The persistence choice is load-bearing: picking 'memory' on Cloud Run means
 * every deploy quietly invalidates every already-registered client, so the
 * default has to be right without anyone remembering to set a variable, and it
 * has to be visible from outside once the process is running.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import {
  createApp,
  defaultCreateSession,
  resolvePersistence,
  buildStores,
  SessionStore,
  type AppOptions,
} from '../src/http.js';
import { GoogleAuthProvider } from '../src/auth/google-provider.js';
import { MemoryClientsStore, TokenStore } from '../src/auth/stores.js';

// --- choosing a backend ------------------------------------------------------

describe('resolvePersistence', () => {
  it('defaults to firestore on Cloud Run', () => {
    // K_SERVICE is set by every Cloud Run runtime. In-memory registration there
    // is broken by construction, so it must never be the default.
    expect(resolvePersistence({ K_SERVICE: 'autotask-mcp' } as never)).toBe('firestore');
  });

  it('defaults to memory everywhere else', () => {
    expect(resolvePersistence({} as never)).toBe('memory');
  });

  it('honours an explicit override in both directions', () => {
    expect(resolvePersistence({ AUTOTASK_PERSISTENCE: 'memory', K_SERVICE: 'x' } as never)).toBe(
      'memory',
    );
    expect(resolvePersistence({ AUTOTASK_PERSISTENCE: 'firestore' } as never)).toBe('firestore');
  });

  it('accepts surrounding whitespace and any casing', () => {
    expect(resolvePersistence({ AUTOTASK_PERSISTENCE: '  Firestore ' } as never)).toBe('firestore');
  });

  it('falls back to the environment default on an unrecognised value', () => {
    expect(resolvePersistence({ AUTOTASK_PERSISTENCE: 'redis', K_SERVICE: 'x' } as never)).toBe(
      'firestore',
    );
    expect(resolvePersistence({ AUTOTASK_PERSISTENCE: 'redis' } as never)).toBe('memory');
  });
});

describe('buildStores', () => {
  it('builds in-memory stores for memory persistence', () => {
    const { tokenStore, clientsStore } = buildStores('memory');
    expect(tokenStore).toBeInstanceOf(TokenStore);
    expect(clientsStore).toBeInstanceOf(MemoryClientsStore);
  });
});

// --- MemoryClientsStore ------------------------------------------------------

describe('MemoryClientsStore', () => {
  it('keeps the client_id the SDK generated', async () => {
    const store = new MemoryClientsStore();
    const registered = await store.registerClient({
      client_id: 'sdk-generated-id',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    } as never);

    expect(registered.client_id).toBe('sdk-generated-id');
    expect(await store.getClient('sdk-generated-id')).toBeDefined();
  });

  it('generates one when the SDK did not', async () => {
    const registered = await new MemoryClientsStore().registerClient({
      redirect_uris: [],
    } as never);
    expect(registered.client_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// --- the /authorize dead end -------------------------------------------------

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let base: string;
let server: Server;
let clientsStore: MemoryClientsStore;
let knownClientId: string;

function options(): AppOptions {
  clientsStore = new MemoryClientsStore();
  const provider = new GoogleAuthProvider({
    clientId: 'google-client-id.apps.googleusercontent.com',
    clientSecret: 'google-secret',
    callbackUrl: 'https://mcp.example.com/callback',
    allowedDomains: ['phoneware.us'],
    clientsStore,
    tokenStore: new TokenStore(),
  });
  return {
    googleProvider: provider,
    baseUrl: new URL('https://mcp.example.com'),
    sessions: new SessionStore(),
    limiter: null,
    allowedOrigins: [],
    allowedHosts: [],
    maxBodyBytes: 1024 * 1024,
    createSession: defaultCreateSession,
    persistence: 'firestore',
  };
}

function authorizeUrl(clientId: string): string {
  const url = new URL(`${base}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', REDIRECT);
  return url.href;
}

beforeAll(async () => {
  const app = createApp(options());
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  knownClientId = (
    await clientsStore.registerClient({
      client_id: 'known-client',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    } as never)
  ).client_id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('/authorize with an unknown client', () => {
  // Clients do not re-register when told invalid_client; Claude Code re-sends
  // the same cached id and fails again. Since /register is open anyway, the id
  // was never a secret, so adopting it costs nothing and is the only thing that
  // actually unbreaks a client holding a registration the server has lost.
  it('adopts a stale client_id and carries on to Google', async () => {
    const stale = 'c13c9bc3-2d84-469e-9ad0-165457c895ea';
    const res = await fetch(authorizeUrl(stale), { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it('persists the adopted client, so the next call is an ordinary lookup', async () => {
    const stale = 'a-stale-but-plausible-client-id';
    await fetch(authorizeUrl(stale), { redirect: 'manual' });

    const stored = await clientsStore.getClient(stale);
    expect(stored?.client_id).toBe(stale);
    expect(stored?.redirect_uris).toEqual([REDIRECT]);
  });

  it('adopts a loopback client on any port, which is how CLI clients work', async () => {
    // The port is picked per sign-in attempt, so it can never be pre-registered.
    const url = new URL(`${base}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'a-claude-code-style-client');
    url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('redirect_uri', 'http://localhost:3118/callback');

    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it('refuses to adopt a client pointing anywhere else, and says not to sign in', async () => {
    // The phishing shape: an attacker-controlled destination for the code.
    const url = new URL(`${base}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'attacker-supplied-client');
    url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('redirect_uri', 'https://evil.example/steal');

    const res = await fetch(url, { redirect: 'manual' });
    const body = await res.text();

    expect(res.status).toBe(400);
    expect(body).toMatch(/Do not sign in/i);
    expect(body).toContain('evil.example');
    expect(await clientsStore.getClient('attacker-supplied-client')).toBeUndefined();
  });

  it('escapes the refused redirect rather than reflecting markup', async () => {
    const url = new URL(`${base}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'markup-probe');
    url.searchParams.set('redirect_uri', 'https://evil.example/"><img src=x onerror=alert(1)>');

    const body = await (await fetch(url, { redirect: 'manual' })).text();
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img src=x');
  });

  it('refuses an implausible client_id rather than storing junk', async () => {
    const url = new URL(`${base}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'short');
    url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('redirect_uri', REDIRECT);

    expect((await fetch(url, { redirect: 'manual' })).status).toBe(400);
  });

  it('leaves a request with no client_id to the SDK', async () => {
    // Missing entirely is a different error, and not ours to describe.
    const res = await fetch(`${base}/authorize?response_type=code`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/Do not sign in/i);
  });
});

describe('/register redirect policy', () => {
  async function register(redirectUris: unknown) {
    return fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'policy-probe',
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }),
    });
  }

  it('accepts the callbacks real clients use', async () => {
    expect((await register([REDIRECT])).status).toBe(201);
    expect((await register(['http://127.0.0.1:51000/callback'])).status).toBe(201);
  });

  it('refuses a registration that would send codes off-machine', async () => {
    const res = await register(['https://evil.example/steal']);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('refuses when any one of several redirects is disallowed', async () => {
    expect((await register([REDIRECT, 'https://evil.example/steal'])).status).toBe(400);
  });
});

describe('/authorize with a registered client', () => {
  it('still redirects to Google', async () => {
    const res = await fetch(authorizeUrl(knownClientId), { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//);
  });
});

describe('/health', () => {
  it('reports which persistence backend is in use', async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toMatchObject({ persistence: 'firestore' });
  });
});
