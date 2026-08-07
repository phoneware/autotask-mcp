/**
 * Firestore-backed OAuth stores.
 *
 * These exist so a deploy does not log everyone out and, more importantly, does
 * not invalidate the client registrations that MCP clients cached long ago. See
 * the header of ./stores.ts for why an in-process map is the wrong home for
 * either on Cloud Run.
 *
 * Firestore is external to the container, needs no connection management, and
 * is already in use by peplink-mcp in the same project under the same runtime
 * service account, so this adds no new infrastructure.
 *
 * Collection layout:
 *   {collection}                    - registered DCR clients, keyed by client_id
 *   {tokenCollection}               - issued tokens, keyed by access token
 *   {tokenCollection}_refresh       - refresh token -> access token pointer
 *
 * Each store keeps a read-through in-process cache. The service runs as a
 * single pinned instance, so nothing else mutates these documents underneath
 * us, and every cache entry is invalidated on the write path that would make it
 * stale.
 */

import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { StoredToken, TokenStoreLike } from './stores.js';

export const DEFAULT_CLIENTS_COLLECTION = 'autotask_mcp_oauth_clients';
export const DEFAULT_TOKENS_COLLECTION = 'autotask_mcp_oauth_tokens';

/** How many expired tokens one sweep pass will delete. */
const SWEEP_BATCH = 400;

/**
 * Firestore document ids may not contain a forward slash and may not be "." or
 * "..". Our own ids are hex or UUIDs and never trip that, but a client id can
 * in principle arrive from outside, and a rejected write here would surface as
 * a confusing 500 rather than a clean auth failure.
 */
function docId(raw: string): string {
  return /^[A-Za-z0-9._~-]+$/.test(raw) && raw !== '.' && raw !== '..'
    ? raw
    : encodeURIComponent(raw).replace(/\./g, '%2E');
}

function connect(projectId?: string): Firestore {
  // undefined lets the client resolve the project from ADC, which is what
  // happens on Cloud Run. ignoreUndefinedProperties spares every write path a
  // hand-rolled undefined strip: our stored shapes have genuinely optional
  // fields (scopes, resourceId) that Firestore would otherwise reject.
  return new Firestore({ projectId, ignoreUndefinedProperties: true });
}

export class FirestoreClientsStore implements OAuthRegisteredClientsStore {
  private readonly cache = new Map<string, OAuthClientInformationFull>();
  private readonly db: Firestore;
  private readonly collection: string;

  constructor(opts: { collection?: string; projectId?: string } = {}) {
    this.collection = opts.collection ?? DEFAULT_CLIENTS_COLLECTION;
    this.db = connect(opts.projectId);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const hit = this.cache.get(clientId);
    if (hit) return hit;
    const snap = await this.db.collection(this.collection).doc(docId(clientId)).get();
    if (!snap.exists) return undefined;
    const client = snap.data() as OAuthClientInformationFull;
    this.cache.set(clientId, client);
    return client;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> &
      Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): Promise<OAuthClientInformationFull> {
    // The SDK mints client_id and any client_secret before calling us. Reusing
    // them keeps the persisted record identical to the registration response
    // the client is about to cache.
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: client.client_id ?? randomUUID(),
      client_id_issued_at: client.client_id_issued_at ?? Math.floor(Date.now() / 1000),
    };
    await this.db.collection(this.collection).doc(docId(registered.client_id)).set(registered);
    this.cache.set(registered.client_id, registered);
    return registered;
  }
}

export class FirestoreTokenStore implements TokenStoreLike {
  private readonly cache = new Map<string, StoredToken>();
  private readonly refreshCache = new Map<string, string>();
  private readonly db: Firestore;
  private readonly collection: string;
  private readonly refreshCollection: string;

  constructor(opts: { collection?: string; projectId?: string } = {}) {
    this.collection = opts.collection ?? DEFAULT_TOKENS_COLLECTION;
    this.refreshCollection = `${this.collection}_refresh`;
    this.db = connect(opts.projectId);
  }

  get size(): number {
    return this.cache.size;
  }

  async get(accessToken: string): Promise<StoredToken | undefined> {
    const hit = this.cache.get(accessToken);
    if (hit) return hit;
    const snap = await this.db.collection(this.collection).doc(docId(accessToken)).get();
    if (!snap.exists) return undefined;
    const token = snap.data() as StoredToken;
    this.cache.set(token.accessToken, token);
    this.refreshCache.set(token.refreshToken, token.accessToken);
    return token;
  }

  async getByRefreshToken(refreshToken: string): Promise<StoredToken | undefined> {
    const cached = this.refreshCache.get(refreshToken);
    if (cached) {
      const hit = this.cache.get(cached);
      if (hit) return hit;
    }
    const ptr = await this.db.collection(this.refreshCollection).doc(docId(refreshToken)).get();
    if (!ptr.exists) return undefined;
    const { accessToken } = ptr.data() as { accessToken: string };
    return this.get(accessToken);
  }

  async set(token: StoredToken): Promise<void> {
    const batch = this.db.batch();
    batch.set(this.db.collection(this.collection).doc(docId(token.accessToken)), token);
    batch.set(this.db.collection(this.refreshCollection).doc(docId(token.refreshToken)), {
      accessToken: token.accessToken,
    });
    await batch.commit();
    this.cache.set(token.accessToken, token);
    this.refreshCache.set(token.refreshToken, token.accessToken);
  }

  async delete(accessToken: string): Promise<void> {
    const existing = this.cache.get(accessToken) ?? (await this.get(accessToken));
    if (!existing) return;
    await this.deleteBoth(existing);
  }

  async deleteByRefreshToken(refreshToken: string): Promise<void> {
    const existing = await this.getByRefreshToken(refreshToken);
    if (!existing) return;
    await this.deleteBoth(existing);
  }

  private async deleteBoth(token: StoredToken): Promise<void> {
    const batch = this.db.batch();
    batch.delete(this.db.collection(this.collection).doc(docId(token.accessToken)));
    batch.delete(this.db.collection(this.refreshCollection).doc(docId(token.refreshToken)));
    await batch.commit();
    this.cache.delete(token.accessToken);
    this.refreshCache.delete(token.refreshToken);
  }

  /**
   * Delete expired access tokens, capped per pass so a long-neglected
   * collection cannot turn one reap tick into an unbounded write burst. The
   * reaper runs on an interval, so whatever is left goes on the next pass.
   */
  async sweep(now: number = Date.now()): Promise<number> {
    const expired = await this.db
      .collection(this.collection)
      .where('expiresAt', '<=', now)
      .limit(SWEEP_BATCH)
      .get();

    if (expired.empty) {
      this.pruneCache(now);
      return 0;
    }

    const batch = this.db.batch();
    for (const doc of expired.docs) {
      const token = doc.data() as StoredToken;
      batch.delete(doc.ref);
      batch.delete(this.db.collection(this.refreshCollection).doc(docId(token.refreshToken)));
      this.cache.delete(token.accessToken);
      this.refreshCache.delete(token.refreshToken);
    }
    await batch.commit();
    this.pruneCache(now);
    return expired.size;
  }

  /** Keep the read-through cache from outliving what it mirrors. */
  private pruneCache(now: number): void {
    for (const token of [...this.cache.values()]) {
      if (token.expiresAt <= now) {
        this.cache.delete(token.accessToken);
        this.refreshCache.delete(token.refreshToken);
      }
    }
  }
}
