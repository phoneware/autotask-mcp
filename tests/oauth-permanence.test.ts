import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Firestore } from '@google-cloud/firestore';
import {
  type PermanenceHarness,
  runPermanenceContract,
} from './test-support/permanence-contract.js';
import { FakeFirestore } from './test-support/fake-firestore.js';
import { createApp, defaultCreateSession, SessionStore, type AppOptions } from '../src/http.js';
import { GoogleAuthProvider } from '../src/auth/google-provider.js';
import { FirestoreClientsStore, FirestoreTokenStore } from '../src/auth/firestore-stores.js';
import { resetResourceCache } from '../src/auth/resource-lookup.js';
import { governor } from '../src/governor.js';

interface AutotaskHarnessBacking {
  fakeDb: FakeFirestore;
  clientsStore: FirestoreClientsStore;
  tokenStore: FirestoreTokenStore;
  allowedEmails: string[];
}
const originalFetch = globalThis.fetch;

function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
}

function stubUpstream(claims: Record<string, unknown> = {}) {
  const defaultClaims = {
    email: 'dave@phoneware.us',
    email_verified: true,
    aud: 'google-client-id.apps.googleusercontent.com',
    iss: 'https://accounts.google.com',
    ...claims,
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ id_token: idToken(defaultClaims) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('Resources/query')) {
        return new Response(JSON.stringify({ items: [{ id: 77, isActive: true, userType: 14 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('ThresholdInformation') || url.includes('zoneInformation')) {
        return new Response(
          JSON.stringify({ externalRequestThreshold: 10000, currentTimeframeRequestCount: 10 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return originalFetch(input as string, init);
    }),
  );
}

describe('Autotask MCP OAuth Permanence Contract', () => {
  let virtualNow = Date.now();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetResourceCache();
    governor.reset();
    virtualNow = Date.now();
    // Keep reference to real fetch for loopback calls
    (globalThis.fetch as typeof fetch & { realFetch: typeof fetch }).realFetch = realFetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs the OAuth permanence contract against Autotask MCP', async () => {
    const harness: PermanenceHarness<AutotaskHarnessBacking> = {
      name: 'Autotask MCP (Fake Firestore)',
      newBacking: async () => {
        const fakeDb = new FakeFirestore({ ignoreUndefinedProperties: true });
        // Use any cast to pass FakeFirestore as Firestore
        const db = fakeDb as unknown as Firestore;
        const clientsStore = new FirestoreClientsStore({ collection: 'test_clients' });
        // @ts-expect-error inject db
        clientsStore.db = db;
        const tokenStore = new FirestoreTokenStore({ collection: 'test_tokens' });
        // @ts-expect-error inject db
        tokenStore.db = db;

        return {
          fakeDb,
          clientsStore,
          tokenStore,
          allowedEmails: ['dave@phoneware.us', 'allowed@example.com', 'user@example.com'],
        };
      },
      createInstance: async (backing) => {
        const provider = new GoogleAuthProvider({
          clientId: 'google-client-id.apps.googleusercontent.com',
          clientSecret: 'google-secret',
          callbackUrl: 'http://127.0.0.1:0/callback',
          allowedDomains: ['phoneware.us', 'example.com'],
          allowedEmails: backing.allowedEmails,
          clientsStore: backing.clientsStore,
          tokenStore: backing.tokenStore,
          tokenTtlSeconds: 3600,
        });

        let serverUrl = '';
        const opts: AppOptions = {
          googleProvider: provider,
          baseUrl: new URL('http://127.0.0.1:0'),
          sessions: new SessionStore(),
          limiter: null,
          allowedOrigins: [],
          allowedHosts: [],
          maxBodyBytes: 1024 * 1024,
          createSession: defaultCreateSession,
          persistence: 'firestore',
          redirectAllowlist: [
            'http://127.0.0.1:9099/callback',
            'https://claude.ai/api/mcp/auth_callback',
            'https://claude.com/api/mcp/auth_callback',
          ],
        };

        const app = createApp(opts);
        const server: Server = await new Promise((resolve) => {
          const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const port = (server.address() as AddressInfo).port;
        serverUrl = `http://127.0.0.1:${port}`;
        opts.baseUrl = new URL(serverUrl);
        // @ts-expect-error update callbackUrl
        provider.opts.callbackUrl = `${serverUrl}/callback`;

        return {
          url: serverUrl,
          close: async () => {
            await new Promise<void>((resolve, reject) => {
              server.close((err) => (err ? reject(err) : resolve()));
            });
          },
        };
      },
      signIn: async (instanceUrl, opts) => {
        const email = opts?.email ?? 'dave@phoneware.us';
        stubUpstream({ email });

        const clientId = 'permanent_client_id_test';
        const redirectUri = 'http://127.0.0.1:9099/callback';

        const authUrl = `${instanceUrl}/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
          redirectUri,
        )}&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`;

        const authRes = await realFetch(authUrl, { redirect: 'manual' });
        const location = authRes.headers.get('location');
        const googleAuthUrl = new URL(location!, instanceUrl);
        const state = googleAuthUrl.searchParams.get('state');
        expect(state, `location was ${location}`).toBeTruthy();

        // Simulate Google redirecting to /callback
        const callbackUrl = `${instanceUrl}/callback?code=fake_google_code&state=${encodeURIComponent(
          state!,
        )}`;
        const callbackRes = await realFetch(callbackUrl, { redirect: 'manual' });
        if (callbackRes.status !== 302) {
          const body = await callbackRes.text();
          const reason = body.match(/<strong>(.*?)<\/strong>/)?.[1] ?? body;
          throw new Error(`callback failed status=${callbackRes.status}: ${reason}`);
        }
        const mcpRedirect = callbackRes.headers.get('location');
        expect(mcpRedirect).toBeTruthy();
        const ourCode = new URL(mcpRedirect!).searchParams.get('code');
        expect(ourCode).toBeTruthy();

        // Exchange code for tokens at /token
        const tokenRes = await realFetch(`${instanceUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: ourCode!,
            client_id: clientId,
            redirect_uri: redirectUri,
            code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
          }).toString(),
        });
        expect(tokenRes.status).toBe(200);
        const data = (await tokenRes.json()) as Record<string, unknown>;

        return {
          accessToken: String(data.access_token),
          refreshToken: String(data.refresh_token),
          clientId,
          expiresIn: Number(data.expires_in),
        };
      },
      setNow: (now) => {
        virtualNow = now;
        vi.setSystemTime(now);
      },
      getNow: () => virtualNow,
      setStoreOutage: async (backing, active) => {
        backing.fakeDb.setOutage(active);
      },
      setAllowlist: async (backing, allowed) => {
        backing.allowedEmails = allowed;
      },
      supportsAdoption: true,
      supportsRegistration: true,
      supportsAllowlist: false, // Autotask checks allowlist at callback; refresh re-resolves Autotask resource
      resourceMetadataUrl: undefined,
    };

    await runPermanenceContract(harness);
  });
});
