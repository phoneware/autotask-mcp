/**
 * Per-user tool-usage tracking for automatic promotion of frequently-used
 * full-registry tools into the default tool list.
 *
 * Implements:
 * - InMemoryUsageStore (for tests and stdio)
 * - FirestoreUsageStore (for production on Cloud Run)
 */

import { Firestore } from '@google-cloud/firestore';

export interface UsageRecord {
  count: number;
  lastUsed: number;
}

export interface UsageStore {
  recordCall(userKey: string, toolName: string): Promise<void>;
  getUserUsage(userKey: string): Promise<Map<string, UsageRecord>>;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly map = new Map<string, Map<string, UsageRecord>>();

  async recordCall(userKey: string, toolName: string): Promise<void> {
    let perUser = this.map.get(userKey);
    if (!perUser) {
      perUser = new Map();
      this.map.set(userKey, perUser);
    }
    const existing = perUser.get(toolName);
    perUser.set(toolName, {
      count: (existing?.count ?? 0) + 1,
      lastUsed: Date.now(),
    });
  }

  async getUserUsage(userKey: string): Promise<Map<string, UsageRecord>> {
    return new Map(this.map.get(userKey) ?? []);
  }
}

export class FirestoreUsageStore implements UsageStore {
  private readonly db: Firestore;
  private readonly collection: string;
  private readonly cache = new Map<string, { fetchedAt: number; data: Map<string, UsageRecord> }>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(opts: { collection?: string; projectId?: string } = {}) {
    this.collection = opts.collection ?? 'autotask_mcp_tool_usage';
    this.db = new Firestore({ projectId: opts.projectId, ignoreUndefinedProperties: true });
  }

  private docId(userKey: string, toolName: string): string {
    const safeUser = Buffer.from(userKey).toString('base64url');
    return `${safeUser}__${toolName}`;
  }

  async recordCall(userKey: string, toolName: string): Promise<void> {
    const docRef = this.db.collection(this.collection).doc(this.docId(userKey, toolName));
    try {
      const snap = await docRef.get();
      const existing = snap.exists ? (snap.data() as { count?: number }) : undefined;
      const next: UsageRecord & { userKey: string; toolName: string } = {
        count: (existing?.count ?? 0) + 1,
        lastUsed: Date.now(),
        userKey,
        toolName,
      };
      await docRef.set(next);
      this.cache.delete(userKey);
    } catch {
      // Best-effort tracking: never fail tool call on storage error
    }
  }

  async getUserUsage(userKey: string): Promise<Map<string, UsageRecord>> {
    const cached = this.cache.get(userKey);
    if (cached && Date.now() - cached.fetchedAt < FirestoreUsageStore.CACHE_TTL_MS) {
      return new Map(cached.data);
    }
    try {
      const query = await this.db.collection(this.collection).where('userKey', '==', userKey).get();
      const map = new Map<string, UsageRecord>();
      query.forEach((doc) => {
        const data = doc.data() as { toolName?: string; count?: number; lastUsed?: number };
        if (data.toolName && typeof data.count === 'number' && typeof data.lastUsed === 'number') {
          map.set(data.toolName, { count: data.count, lastUsed: data.lastUsed });
        }
      });
      this.cache.set(userKey, { fetchedAt: Date.now(), data: map });
      return new Map(map);
    } catch {
      return new Map();
    }
  }
}

let singleton: UsageStore | null = null;

export function getUsageStore(): UsageStore {
  if (singleton) return singleton;
  const useFirestore =
    process.env.AUTOTASK_PERSISTENCE === 'firestore' ||
    (process.env.AUTOTASK_PERSISTENCE !== 'memory' && !!process.env.GOOGLE_CLOUD_PROJECT);
  singleton = useFirestore
    ? new FirestoreUsageStore({ projectId: process.env.GOOGLE_CLOUD_PROJECT })
    : new InMemoryUsageStore();
  return singleton;
}

export function _resetUsageStoreForTests(store?: UsageStore): void {
  singleton = store ?? null;
}
