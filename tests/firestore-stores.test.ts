/**
 * Firestore store behaviour, against a fake Firestore.
 *
 * The point of these stores is that state outlives the process, so the central
 * test is the "redeploy" one: write through one store instance, then read
 * through a brand new instance with an empty cache and find it still there.
 * That is exactly the path that broke when clients lived in a process-local
 * map, and it is what an in-memory store cannot pass.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { FakeFirestore, fakeDb } = vi.hoisted(() => {
  const data = new Map<string, Map<string, Record<string, unknown>>>();

  const strip = (doc: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));

  const bucket = (name: string): Map<string, Record<string, unknown>> => {
    let b = data.get(name);
    if (!b) {
      b = new Map();
      data.set(name, b);
    }
    return b;
  };

  class FakeDocRef {
    constructor(
      readonly collectionName: string,
      readonly id: string,
    ) {}
    get(): Promise<{ exists: boolean; data: () => unknown; ref: FakeDocRef }> {
      const doc = bucket(this.collectionName).get(this.id);
      return Promise.resolve({ exists: doc !== undefined, data: () => doc, ref: this });
    }
    set(doc: Record<string, unknown>): Promise<void> {
      bucket(this.collectionName).set(this.id, strip(doc));
      return Promise.resolve();
    }
    delete(): Promise<void> {
      bucket(this.collectionName).delete(this.id);
      return Promise.resolve();
    }
  }

  class FakeQuery {
    constructor(
      protected readonly collectionName: string,
      protected readonly filters: Array<[string, string, unknown]> = [],
      protected readonly lim = Infinity,
    ) {}
    where(field: string, op: string, value: unknown): FakeQuery {
      return new FakeQuery(this.collectionName, [...this.filters, [field, op, value]], this.lim);
    }
    limit(n: number): FakeQuery {
      return new FakeQuery(this.collectionName, this.filters, n);
    }
    get(): Promise<{
      empty: boolean;
      size: number;
      docs: Array<{ data: () => unknown; ref: FakeDocRef }>;
    }> {
      const matches = [...bucket(this.collectionName).entries()]
        .filter(([, doc]) =>
          this.filters.every(([field, op, value]) => {
            if (op === '<=') return (doc[field] as number) <= (value as number);
            if (op === 'array-contains') {
              return Array.isArray(doc[field]) && doc[field].includes(value);
            }
            throw new Error(`fake Firestore: unsupported operator ${op}`);
          }),
        )
        .slice(0, this.lim === Infinity ? undefined : this.lim)
        .map(([id, doc]) => ({ data: () => doc, ref: new FakeDocRef(this.collectionName, id) }));
      return Promise.resolve({ empty: matches.length === 0, size: matches.length, docs: matches });
    }
  }

  class FakeCollection extends FakeQuery {
    doc(id: string): FakeDocRef {
      return new FakeDocRef(this.collectionName, id);
    }
  }

  class FakeBatch {
    private readonly ops: Array<() => void> = [];
    set(ref: FakeDocRef, doc: Record<string, unknown>): void {
      this.ops.push(() => bucket(ref.collectionName).set(ref.id, strip(doc)));
    }
    delete(ref: FakeDocRef): void {
      this.ops.push(() => void bucket(ref.collectionName).delete(ref.id));
    }
    commit(): Promise<void> {
      // Firestore applies a batch atomically; applying at commit rather than at
      // call time keeps that property observable in tests.
      for (const op of this.ops) op();
      this.ops.length = 0;
      return Promise.resolve();
    }
  }

  class FakeFirestoreImpl {
    collection(name: string): FakeCollection {
      return new FakeCollection(name);
    }
    batch(): FakeBatch {
      return new FakeBatch();
    }
    runTransaction<T>(
      fn: (tx: {
        get: (ref: FakeDocRef) => Promise<unknown>;
        set: (ref: FakeDocRef, doc: Record<string, unknown>) => void;
        delete: (ref: FakeDocRef) => void;
      }) => Promise<T>,
    ): Promise<T> {
      const batch = new FakeBatch();
      return fn({
        get: (ref) => ref.get(),
        set: (ref, doc) => batch.set(ref, doc),
        delete: (ref) => batch.delete(ref),
      }).then((result) => batch.commit().then(() => result));
    }
  }

  return {
    FakeFirestore: FakeFirestoreImpl,
    fakeDb: {
      reset: () => data.clear(),
      raw: data,
      docs: (name: string) => bucket(name),
    },
  };
});

vi.mock('@google-cloud/firestore', () => ({ Firestore: FakeFirestore }));

const {
  FirestoreClientsStore,
  FirestoreTokenStore,
  DEFAULT_CLIENTS_COLLECTION,
  DEFAULT_TOKENS_COLLECTION,
} = await import('../src/auth/firestore-stores.js');
const { GoogleAuthProvider } = await import('../src/auth/google-provider.js');

beforeEach(() => {
  fakeDb.reset();
});

function token(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'access-aaa',
    refreshToken: 'refresh-bbb',
    clientId: 'mcp-client-1',
    expiresAt: Date.now() + 3_600_000,
    email: 'dave@phoneware.us',
    resourceId: 77,
    userType: 14,
    capabilities: ['read', 'create', 'update', 'delete'],
    ...overrides,
  };
}

// --- the regression this whole change exists for -----------------------------

describe('surviving a restart', () => {
  it('finds a client registered by a previous process', async () => {
    const before = new FirestoreClientsStore();
    const registered = await before.registerClient({
      client_id: 'c13c9bc3-2d84-469e-9ad0-165457c895ea',
      client_id_issued_at: 1_700_000_000,
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
    } as never);

    // A new instance with a cold cache is what a redeployed container gets.
    const after = new FirestoreClientsStore();
    const found = await after.getClient(registered.client_id);

    expect(found?.client_id).toBe('c13c9bc3-2d84-469e-9ad0-165457c895ea');
    expect(found?.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('finds a token issued by a previous process, by access and by refresh token', async () => {
    await new FirestoreTokenStore().set(token());

    const after = new FirestoreTokenStore();
    expect((await after.get('access-aaa'))?.email).toBe('dave@phoneware.us');
    expect((await after.getByRefreshToken('refresh-bbb'))?.accessToken).toBe('access-aaa');
  });

  it('keeps an unknown client unknown, rather than inventing one', async () => {
    expect(await new FirestoreClientsStore().getClient('never-registered')).toBeUndefined();
  });
});

// --- clients store -----------------------------------------------------------

describe('FirestoreClientsStore', () => {
  it('persists the client_id the SDK already put in the registration response', async () => {
    // Reissuing a different id here would hand the client a registration that
    // does not match what it is told to cache.
    const store = new FirestoreClientsStore();
    const registered = await store.registerClient({
      client_id: 'sdk-generated-id',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    } as never);

    expect(registered.client_id).toBe('sdk-generated-id');
    expect(fakeDb.docs(DEFAULT_CLIENTS_COLLECTION).has('sdk-generated-id')).toBe(true);
  });

  it('generates a client_id when the SDK did not', async () => {
    const registered = await new FirestoreClientsStore().registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    } as never);

    expect(registered.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(registered.client_id_issued_at).toBeGreaterThan(0);
  });

  it('serves a repeat lookup from cache without a second read', async () => {
    const store = new FirestoreClientsStore();
    const { client_id } = await store.registerClient({ redirect_uris: [] } as never);
    await store.getClient(client_id);

    // Delete underneath it: a cached hit still answers, which is safe here
    // because nothing else writes this collection on a single pinned instance.
    fakeDb.docs(DEFAULT_CLIENTS_COLLECTION).clear();
    expect(await store.getClient(client_id)).toBeDefined();
  });
});

// --- token store -------------------------------------------------------------

describe('FirestoreTokenStore', () => {
  it('writes independent access and refresh credentials', async () => {
    await new FirestoreTokenStore().set(token());

    expect(fakeDb.docs(DEFAULT_TOKENS_COLLECTION).has('access-aaa')).toBe(true);
    expect(fakeDb.docs(`${DEFAULT_TOKENS_COLLECTION}_refresh`).get('refresh-bbb')).toMatchObject({
      status: 'active',
      token: { accessToken: 'access-aaa', email: 'dave@phoneware.us' },
    });
  });

  it('deletes only the access credential by access token', async () => {
    const store = new FirestoreTokenStore();
    await store.set(token());
    await store.delete('access-aaa');

    expect(await store.get('access-aaa')).toBeUndefined();
    expect((await store.getByRefreshToken('refresh-bbb'))?.email).toBe('dave@phoneware.us');
    expect(fakeDb.docs(`${DEFAULT_TOKENS_COLLECTION}_refresh`).size).toBe(1);
  });

  it('deletes by refresh token too', async () => {
    const store = new FirestoreTokenStore();
    await store.set(token());
    await store.deleteByRefreshToken('refresh-bbb');

    expect(await store.get('access-aaa')).toBeUndefined();
    expect(fakeDb.docs(DEFAULT_TOKENS_COLLECTION).size).toBe(0);
  });

  it('deleting an unknown token is a no-op, not a throw', async () => {
    await expect(new FirestoreTokenStore().delete('nope')).resolves.toBeUndefined();
    await expect(new FirestoreTokenStore().deleteByRefreshToken('nope')).resolves.toBeUndefined();
  });

  it('sweeps only what has expired', async () => {
    const store = new FirestoreTokenStore();
    const now = Date.now();
    await store.set(
      token({ accessToken: 'live', refreshToken: 'live-r', expiresAt: now + 60_000 }),
    );
    await store.set(token({ accessToken: 'dead', refreshToken: 'dead-r', expiresAt: now - 1 }));

    expect(await store.sweep(now)).toBe(1);
    expect(await store.get('dead')).toBeUndefined();
    expect(await store.get('live')).toBeDefined();
    // Refresh credentials own their subject data and survive access expiry.
    expect(fakeDb.docs(`${DEFAULT_TOKENS_COLLECTION}_refresh`).has('dead-r')).toBe(true);
    expect(fakeDb.docs(`${DEFAULT_TOKENS_COLLECTION}_refresh`).has('live-r')).toBe(true);
  });

  it('atomically rotates refresh tokens and rejects replay by revoking the family', async () => {
    const store = new FirestoreTokenStore();
    await store.set(token());

    const rotated = await store.rotateRefreshToken(
      'refresh-bbb',
      token({ accessToken: 'access-new', refreshToken: 'refresh-new' }),
      'mcp-client-1',
    );
    expect(rotated.status).toBe('claimed');
    expect(await store.getByRefreshToken('refresh-bbb')).toBeUndefined();
    expect((await store.getByRefreshToken('refresh-new'))?.accessToken).toBe('access-new');
    expect(await store.get('access-aaa')).toBeUndefined();

    const replay = await store.rotateRefreshToken(
      'refresh-bbb',
      token({ accessToken: 'access-replay', refreshToken: 'refresh-replay' }),
      'mcp-client-1',
      Date.now() + 60_000,
    );
    expect(replay.status).toBe('replay');
    expect(await store.getByRefreshToken('refresh-new')).toBeUndefined();
    expect(await store.get('access-new')).toBeUndefined();
  });

  it('revokes the family when the oldest deleted refresh token is replayed', async () => {
    const store = new FirestoreTokenStore();
    const now = Date.now();
    await store.set(token());

    await store.rotateRefreshToken(
      'refresh-bbb',
      token({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
      'mcp-client-1',
      now,
    );
    await store.rotateRefreshToken(
      'refresh-2',
      token({ accessToken: 'access-3', refreshToken: 'refresh-3' }),
      'mcp-client-1',
      now + 1,
    );
    await store.rotateRefreshToken(
      'refresh-3',
      token({ accessToken: 'access-4', refreshToken: 'refresh-4' }),
      'mcp-client-1',
      now + 2,
    );

    expect(fakeDb.docs(`${DEFAULT_TOKENS_COLLECTION}_refresh`).has('refresh-bbb')).toBe(false);
    const replay = await store.rotateRefreshToken(
      'refresh-bbb',
      token({ accessToken: 'access-replay', refreshToken: 'refresh-replay' }),
      'mcp-client-1',
      now + 3,
    );

    expect(replay.status).toBe('replay');
    expect(await store.getByRefreshToken('refresh-4')).toBeUndefined();
    expect(await store.get('access-4')).toBeUndefined();
    expect(fakeDb.docs(`${DEFAULT_TOKENS_COLLECTION}_refresh_families`).size).toBe(0);
  });

  it('removes swept tokens from durable storage', async () => {
    const store = new FirestoreTokenStore();
    const now = Date.now();
    await store.set(token({ accessToken: 'dead', refreshToken: 'dead-r', expiresAt: now - 1 }));
    await store.sweep(now);

    expect(await new FirestoreTokenStore().get('dead')).toBeUndefined();
    expect(fakeDb.docs(DEFAULT_TOKENS_COLLECTION).size).toBe(0);
  });

  it('stores a token that has no resource id', async () => {
    // undefined fields are stripped on write; reading one back must not fail.
    const store = new FirestoreTokenStore();
    await store.set(token({ resourceId: undefined, scopes: undefined }));
    const read = await new FirestoreTokenStore().get('access-aaa');

    expect(read?.email).toBe('dave@phoneware.us');
    expect(read?.resourceId).toBeUndefined();
  });
});

// --- the provider must actually await an async store -------------------------

describe('GoogleAuthProvider against an async store', () => {
  it('verifies, refreshes and revokes a token held in Firestore', async () => {
    // If any await on the token store is dropped, these see a Promise where a
    // token should be and every assertion below fails.
    const tokenStore = new FirestoreTokenStore();
    const provider = new GoogleAuthProvider({
      clientId: 'google-client-id.apps.googleusercontent.com',
      clientSecret: 'google-secret',
      callbackUrl: 'https://mcp.example.com/callback',
      allowedDomains: ['phoneware.us'],
      clientsStore: new FirestoreClientsStore(),
      tokenStore,
    });
    await tokenStore.set(token());

    const auth = await provider.verifyAccessToken('access-aaa');
    expect(auth.extra).toMatchObject({ email: 'dave@phoneware.us', resourceId: 77 });

    await provider.revokeToken({ client_id: 'mcp-client-1' } as never, { token: 'access-aaa' });
    await expect(provider.verifyAccessToken('access-aaa')).rejects.toThrow(/invalid_token/);
    expect(await tokenStore.getByRefreshToken('refresh-bbb')).toBeUndefined();
  });

  it('rejects an expired token and clears it out', async () => {
    const tokenStore = new FirestoreTokenStore();
    const provider = new GoogleAuthProvider({
      clientId: 'google-client-id.apps.googleusercontent.com',
      clientSecret: 'google-secret',
      callbackUrl: 'https://mcp.example.com/callback',
      allowedDomains: ['phoneware.us'],
      clientsStore: new FirestoreClientsStore(),
      tokenStore,
    });
    await tokenStore.set(token({ expiresAt: Date.now() - 1 }));

    await expect(provider.verifyAccessToken('access-aaa')).rejects.toThrow(/expired/);
    expect(await tokenStore.get('access-aaa')).toBeUndefined();
    expect((await tokenStore.getByRefreshToken('refresh-bbb'))?.email).toBe('dave@phoneware.us');
  });

  it('revokes by refresh token as well', async () => {
    const tokenStore = new FirestoreTokenStore();
    const provider = new GoogleAuthProvider({
      clientId: 'google-client-id.apps.googleusercontent.com',
      clientSecret: 'google-secret',
      callbackUrl: 'https://mcp.example.com/callback',
      allowedDomains: ['phoneware.us'],
      clientsStore: new FirestoreClientsStore(),
      tokenStore,
    });
    await tokenStore.set(token());

    await provider.revokeToken({ client_id: 'mcp-client-1' } as never, { token: 'refresh-bbb' });
    expect(await tokenStore.get('access-aaa')).toBeUndefined();
    expect(await tokenStore.getByRefreshToken('refresh-bbb')).toBeUndefined();
  });
});
