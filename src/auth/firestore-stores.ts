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
 *   {collection}                      - registered DCR clients, keyed by client_id
 *   {tokenCollection}                 - issued access tokens, keyed by access token
 *   {tokenCollection}_refresh         - refresh credentials, keyed by refresh token
 *   {tokenCollection}_refresh_families - bounded current/previous refresh family state
 *
 * Registered DCR clients use a read-through cache because they are immutable
 * after registration. Tokens are always read from Firestore at the point of use.
 */

import { randomUUID } from 'node:crypto';
import { Firestore, type DocumentReference, type Transaction } from '@google-cloud/firestore';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { RefreshRotationResult, StoredToken, TokenStoreLike } from './stores.js';
import {
  MAX_RETIRED_REFRESH_FINGERPRINTS,
  REFRESH_RETRY_WINDOW_MS,
  normalizePublicClient,
  refreshFingerprint,
} from './stores.js';

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
    const ref = this.db.collection(this.collection).doc(docId(clientId));
    const snap = await ref.get();
    if (!snap.exists) return undefined;
    const client = snap.data() as OAuthClientInformationFull;
    const normalized = normalizePublicClient(client);
    if (normalized !== client) await ref.set(normalized);
    this.cache.set(clientId, normalized);
    return normalized;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> &
      Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): Promise<OAuthClientInformationFull> {
    // The SDK mints client_id before calling us. Reusing it keeps the persisted
    // record identical to the registration response the client is about to cache.
    const registered = normalizePublicClient({
      ...client,
      client_id: client.client_id ?? randomUUID(),
      client_id_issued_at: client.client_id_issued_at ?? Math.floor(Date.now() / 1000),
    });
    await this.db.collection(this.collection).doc(docId(registered.client_id)).set(registered);
    this.cache.set(registered.client_id, registered);
    return registered;
  }
}

type StoredRefreshRecord = {
  status: 'active' | 'consumed';
  familyId: string;
  token: StoredToken;
  successorRefreshToken?: string;
  consumedAt?: number;
};

type StoredRefreshFamily = {
  id: string;
  currentAccessToken: string;
  currentRefreshToken: string;
  previousAccessToken?: string;
  previousRefreshToken?: string;
  retiredRefreshFingerprints: string[];
};

type LegacyRefreshPointer = { accessToken: string };

export class FirestoreTokenStore implements TokenStoreLike {
  private readonly db: Firestore;
  private readonly collection: string;
  private readonly refreshCollection: string;
  private readonly familyCollection: string;

  constructor(opts: { collection?: string; projectId?: string } = {}) {
    this.collection = opts.collection ?? DEFAULT_TOKENS_COLLECTION;
    this.refreshCollection = `${this.collection}_refresh`;
    this.familyCollection = `${this.collection}_refresh_families`;
    this.db = connect(opts.projectId);
  }

  async get(accessToken: string): Promise<StoredToken | undefined> {
    const snap = await this.db.collection(this.collection).doc(docId(accessToken)).get();
    return snap.exists ? (snap.data() as StoredToken) : undefined;
  }

  async getByRefreshToken(refreshToken: string): Promise<StoredToken | undefined> {
    const snap = await this.db.collection(this.refreshCollection).doc(docId(refreshToken)).get();
    if (!snap.exists) return undefined;
    const raw = snap.data() as StoredRefreshRecord | LegacyRefreshPointer;
    if ('status' in raw) return raw.status === 'active' ? raw.token : undefined;

    // Production used access-token pointers before refresh families existed.
    // Migrate them lazily so an upgrade does not invalidate a live connector.
    const legacy = await this.get(raw.accessToken);
    return legacy ? this.migrateLegacyToken(legacy) : undefined;
  }

  async set(token: StoredToken): Promise<void> {
    const familyId = token.refreshFamilyId ?? randomUUID();
    const stored = { ...token, refreshFamilyId: familyId };
    const batch = this.db.batch();
    batch.set(this.db.collection(this.collection).doc(docId(stored.accessToken)), stored);
    batch.set(this.db.collection(this.refreshCollection).doc(docId(stored.refreshToken)), {
      status: 'active',
      familyId,
      token: stored,
    });
    batch.set(this.db.collection(this.familyCollection).doc(docId(familyId)), {
      id: familyId,
      currentAccessToken: stored.accessToken,
      currentRefreshToken: stored.refreshToken,
      retiredRefreshFingerprints: [],
    });
    await batch.commit();
  }

  async delete(accessToken: string): Promise<void> {
    const token = await this.get(accessToken);
    if (token && !token.refreshFamilyId) await this.migrateLegacyToken(token);
    await this.db.collection(this.collection).doc(docId(accessToken)).delete();
  }

  async revokeByAccessToken(accessToken: string): Promise<void> {
    const token = await this.get(accessToken);
    if (!token) return;
    if (token.refreshFamilyId) {
      await this.revokeFamily(token.refreshFamilyId);
      return;
    }

    const batch = this.db.batch();
    batch.delete(this.db.collection(this.collection).doc(docId(token.accessToken)));
    batch.delete(this.db.collection(this.refreshCollection).doc(docId(token.refreshToken)));
    await batch.commit();
  }

  async deleteByRefreshToken(refreshToken: string): Promise<void> {
    const ref = this.db.collection(this.refreshCollection).doc(docId(refreshToken));
    const snap = await ref.get();
    if (snap.exists) {
      const raw = snap.data() as StoredRefreshRecord | LegacyRefreshPointer;
      if ('status' in raw) {
        await this.revokeFamily(raw.familyId);
      } else {
        const batch = this.db.batch();
        batch.delete(ref);
        batch.delete(this.db.collection(this.collection).doc(docId(raw.accessToken)));
        await batch.commit();
      }
      return;
    }
    await this.revokeRetiredToken(refreshToken);
  }

  async rotateRefreshToken(
    oldRefreshToken: string,
    replacement: StoredToken,
    expectedClientId: string,
    now: number = Date.now(),
  ): Promise<RefreshRotationResult> {
    const oldRef = this.db.collection(this.refreshCollection).doc(docId(oldRefreshToken));
    const result = await this.db.runTransaction(async (transaction: Transaction) => {
      const oldSnap = await transaction.get(oldRef);
      if (!oldSnap.exists) return { status: 'missing' } as const;
      const raw = oldSnap.data() as StoredRefreshRecord | LegacyRefreshPointer;
      if (!('status' in raw) || raw.token.clientId !== expectedClientId) {
        return { status: 'missing' } as const;
      }
      const oldRecord = raw;
      const familyRef = this.db.collection(this.familyCollection).doc(docId(oldRecord.familyId));
      const familySnap = await transaction.get(familyRef);
      const family: StoredRefreshFamily = familySnap.exists
        ? {
            ...(familySnap.data() as StoredRefreshFamily),
            retiredRefreshFingerprints:
              (familySnap.data() as StoredRefreshFamily).retiredRefreshFingerprints ?? [],
          }
        : {
            id: oldRecord.familyId,
            currentAccessToken: oldRecord.token.accessToken,
            currentRefreshToken: oldRefreshToken,
            retiredRefreshFingerprints: [],
          };

      if (oldRecord.status === 'consumed') {
        const successor = oldRecord.successorRefreshToken
          ? await transaction.get(
              this.db
                .collection(this.refreshCollection)
                .doc(docId(oldRecord.successorRefreshToken)),
            )
          : undefined;
        if (
          family.previousRefreshToken === oldRefreshToken &&
          oldRecord.consumedAt !== undefined &&
          now - oldRecord.consumedAt <= REFRESH_RETRY_WINDOW_MS &&
          successor?.exists
        ) {
          const successorRecord = successor.data() as StoredRefreshRecord;
          if (
            successorRecord.status === 'active' &&
            successorRecord.token.clientId === expectedClientId
          ) {
            return { status: 'retry', token: successorRecord.token } as const;
          }
        }
        this.deleteFamilyInTransaction(transaction, familyRef, family);
        return { status: 'replay' } as const;
      }

      const retiredRefreshFingerprints = [...family.retiredRefreshFingerprints];
      if (family.previousRefreshToken) {
        retiredRefreshFingerprints.push(refreshFingerprint(family.previousRefreshToken));
        transaction.delete(
          this.db.collection(this.refreshCollection).doc(docId(family.previousRefreshToken)),
        );
      }
      const boundedRetired = [
        ...new Set(retiredRefreshFingerprints.slice(-MAX_RETIRED_REFRESH_FINGERPRINTS)),
      ];
      const stored = { ...replacement, refreshFamilyId: oldRecord.familyId };
      if (family.previousAccessToken) {
        transaction.delete(
          this.db.collection(this.collection).doc(docId(family.previousAccessToken)),
        );
      }
      transaction.delete(
        this.db.collection(this.collection).doc(docId(oldRecord.token.accessToken)),
      );
      transaction.set(oldRef, {
        ...oldRecord,
        status: 'consumed',
        successorRefreshToken: stored.refreshToken,
        consumedAt: now,
      });
      transaction.set(this.db.collection(this.collection).doc(docId(stored.accessToken)), stored);
      transaction.set(this.db.collection(this.refreshCollection).doc(docId(stored.refreshToken)), {
        status: 'active',
        familyId: oldRecord.familyId,
        token: stored,
      });
      transaction.set(familyRef, {
        id: oldRecord.familyId,
        currentAccessToken: stored.accessToken,
        currentRefreshToken: stored.refreshToken,
        previousAccessToken: oldRecord.token.accessToken,
        previousRefreshToken: oldRefreshToken,
        retiredRefreshFingerprints: boundedRetired,
      });
      return { status: 'claimed', token: stored } as const;
    });

    if (result.status !== 'missing') return result;
    return (await this.revokeRetiredToken(oldRefreshToken))
      ? { status: 'replay' }
      : { status: 'missing' };
  }

  private async migrateLegacyToken(token: StoredToken): Promise<StoredToken> {
    const refreshRef = this.db.collection(this.refreshCollection).doc(docId(token.refreshToken));
    const stored = await this.db.runTransaction(async (transaction: Transaction) => {
      const refreshSnap = await transaction.get(refreshRef);
      if (refreshSnap.exists) {
        const current = refreshSnap.data() as StoredRefreshRecord | LegacyRefreshPointer;
        if ('status' in current) return current.token;
      }

      const familyId = randomUUID();
      const migrated = { ...token, refreshFamilyId: familyId };
      transaction.set(
        this.db.collection(this.collection).doc(docId(migrated.accessToken)),
        migrated,
      );
      transaction.set(refreshRef, {
        status: 'active',
        familyId,
        token: migrated,
      });
      transaction.set(this.db.collection(this.familyCollection).doc(docId(familyId)), {
        id: familyId,
        currentAccessToken: migrated.accessToken,
        currentRefreshToken: migrated.refreshToken,
        retiredRefreshFingerprints: [],
      });
      return migrated;
    });
    return stored;
  }

  private async revokeRetiredToken(refreshToken: string): Promise<boolean> {
    const fingerprint = refreshFingerprint(refreshToken);
    const matches = await this.db
      .collection(this.familyCollection)
      .where('retiredRefreshFingerprints', 'array-contains', fingerprint)
      .limit(1)
      .get();
    const familyRef = matches.docs[0]?.ref;
    if (!familyRef) return false;

    const revoked = await this.db.runTransaction(async (transaction: Transaction) => {
      const familySnap = await transaction.get(familyRef);
      if (!familySnap.exists) return false;
      const family = familySnap.data() as StoredRefreshFamily;
      if (!(family.retiredRefreshFingerprints ?? []).includes(fingerprint)) return false;
      this.deleteFamilyInTransaction(transaction, familyRef, family);
      return true;
    });
    return revoked;
  }

  private deleteFamilyInTransaction(
    transaction: Transaction,
    familyRef: DocumentReference,
    family: StoredRefreshFamily,
  ): void {
    transaction.delete(this.db.collection(this.collection).doc(docId(family.currentAccessToken)));
    transaction.delete(
      this.db.collection(this.refreshCollection).doc(docId(family.currentRefreshToken)),
    );
    if (family.previousAccessToken) {
      transaction.delete(
        this.db.collection(this.collection).doc(docId(family.previousAccessToken)),
      );
    }
    if (family.previousRefreshToken) {
      transaction.delete(
        this.db.collection(this.refreshCollection).doc(docId(family.previousRefreshToken)),
      );
    }
    transaction.delete(familyRef);
  }

  private async revokeFamily(familyId: string): Promise<void> {
    const familyRef = this.db.collection(this.familyCollection).doc(docId(familyId));
    await this.db.runTransaction(async (transaction: Transaction) => {
      const familySnap = await transaction.get(familyRef);
      if (!familySnap.exists) return;
      this.deleteFamilyInTransaction(
        transaction,
        familyRef,
        familySnap.data() as StoredRefreshFamily,
      );
    });
  }

  /**
   * Delete expired access tokens without deleting their refresh family. Legacy
   * access-token pointers are migrated first, so an upgrade cannot reproduce the
   * original bug by sweeping the only copy of the refresh credential's identity.
   */
  async sweep(now: number = Date.now()): Promise<number> {
    const expired = await this.db
      .collection(this.collection)
      .where('expiresAt', '<=', now)
      .limit(SWEEP_BATCH)
      .get();

    for (const doc of expired.docs) {
      const token = doc.data() as StoredToken;
      if (!token.refreshFamilyId) await this.migrateLegacyToken(token);
    }
    if (!expired.empty) {
      const batch = this.db.batch();
      for (const doc of expired.docs) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }
    return expired.size;
  }
}
