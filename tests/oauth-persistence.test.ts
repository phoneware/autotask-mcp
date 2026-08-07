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
  it('explains how to fix it instead of returning bare JSON', async () => {
    const res = await fetch(authorizeUrl('c13c9bc3-2d84-469e-9ad0-165457c895ea'), {
      redirect: 'manual',
    });
    const body = await res.text();

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    // The actionable part: remove and re-add, which is what re-registers it.
    expect(body).toMatch(/Remove the Autotask connector/i);
    expect(body).toMatch(/Add it back/i);
    expect(body).not.toMatch(/"error":"invalid_client"/);
  });

  it('echoes the offending client_id so it can be matched to a log line', async () => {
    const res = await fetch(authorizeUrl('some-stale-id'), { redirect: 'manual' });
    expect(await res.text()).toContain('some-stale-id');
  });

  it('escapes the client_id rather than reflecting markup', async () => {
    const res = await fetch(authorizeUrl('<img src=x onerror=alert(1)>'), { redirect: 'manual' });
    const body = await res.text();

    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img src=x');
  });

  it('leaves a request with no client_id to the SDK', async () => {
    // Missing entirely is a different error, and not ours to describe.
    const res = await fetch(`${base}/authorize?response_type=code`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/Remove the Autotask connector/i);
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
