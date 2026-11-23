/**
 * Refresh credentials written by earlier releases keep working through this
 * change. The tests seed the stored shapes as production holds them and drive
 * the provider directly. They use only APIs that existed before the idle window,
 * so they pass on the code before the change as well as after it: nothing a
 * person signed in with may be lost to a deploy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import { FakeFirestore } from './test-support/fake-firestore.js';
import { GoogleAuthProvider } from '../src/auth/google-provider.js';
import {
  DEFAULT_TOKENS_COLLECTION,
  FirestoreClientsStore,
  FirestoreTokenStore,
} from '../src/auth/firestore-stores.js';
import { resetResourceCache } from '../src/auth/resource-lookup.js';
import { governor } from '../src/governor.js';

const SEALING_SECRET = 'sealing-secret-for-tests-only-0123456789';
const DAY = 24 * 60 * 60 * 1000;
const REFRESH_COLLECTION = `${DEFAULT_TOKENS_COLLECTION}_refresh`;
const CLIENT = { client_id: 'legacy-client' } as never;

let db: FakeFirestore;
let tokens: FirestoreTokenStore;
let provider: GoogleAuthProvider;

beforeEach(() => {
  resetResourceCache();
  governor.reset();
  db = new FakeFirestore({ ignoreUndefinedProperties: true });
  tokens = new FirestoreTokenStore();
  const clients = new FirestoreClientsStore();
  // The stores read their database from these fields. Tests substitute the shared fake.
  // @ts-expect-error the store's database is private
  tokens.db = db;
  // @ts-expect-error the store's database is private
  clients.db = db;
  provider = new GoogleAuthProvider({
    clientId: 'google-client-id.apps.googleusercontent.com',
    clientSecret: 'google-secret',
    callbackUrl: 'https://mcp.example.test/callback',
    allowedDomains: ['phoneware.us'],
    clientsStore: clients,
    tokenStore: tokens,
    tokenTtlSeconds: 3600,
    sealingSecret: SEALING_SECRET,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Autotask only: the identity lookup that every refresh makes. */
function stubAutotask(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/Resources/query')) {
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
      throw new Error(`unexpected request in a legacy-shape test: ${url}`);
    }),
  );
}

/**
 * The oldest layout: the refresh credential is a pointer to an access record,
 * and that record carries the refresh token and has no refresh family.
 */
async function seedPointerShape(accessExpiresAt: number): Promise<void> {
  await db
    .collection(DEFAULT_TOKENS_COLLECTION)
    .doc('legacy-access')
    .set({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      clientId: 'legacy-client',
      expiresAt: accessExpiresAt,
      email: 'dave@phoneware.us',
      resourceId: 77,
      userType: 14,
      capabilities: ['read', 'create', 'update', 'delete'],
    });
  await db.collection(REFRESH_COLLECTION).doc('legacy-refresh').set({
    accessToken: 'legacy-access',
  });
}

describe('refresh credentials written by earlier releases', () => {
  it('accepts a refresh token written before the idle window, however old its access record is', async () => {
    stubAutotask();
    await tokens.set({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      clientId: 'legacy-client',
      expiresAt: Date.now() - 400 * DAY,
      email: 'dave@phoneware.us',
      resourceId: 77,
      userType: 14,
      capabilities: ['read', 'create', 'update', 'delete'],
    });

    const rotated = await provider.exchangeRefreshToken(CLIENT, 'legacy-refresh');

    expect(rotated.refresh_token).toEqual(expect.any(String));
    expect(rotated.refresh_token).not.toBe('legacy-refresh');
  });

  it('keeps a refresh credential that points at a legacy access record', async () => {
    stubAutotask();
    await seedPointerShape(Date.now() + 3600 * 1000);

    const rotated = await provider.exchangeRefreshToken(CLIENT, 'legacy-refresh');

    expect(rotated.refresh_token).toEqual(expect.any(String));
    await expect(provider.verifyAccessToken(rotated.access_token)).resolves.toMatchObject({
      extra: { email: 'dave@phoneware.us', resourceId: 77 },
    });
  });

  it('sweeps an expired legacy access record without costing its refresh credential', async () => {
    stubAutotask();
    await seedPointerShape(Date.now() - 1000);

    await tokens.sweep(Date.now());
    const rotated = await provider.exchangeRefreshToken(CLIENT, 'legacy-refresh');

    expect(rotated.refresh_token).toEqual(expect.any(String));
  });
});
