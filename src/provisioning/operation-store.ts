import crypto from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type {
  Actor,
  Claim,
  OperationIntent,
  OperationKind,
  TicketCoordinator,
} from './contracts.js';

export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

export function canonicalizeNumericId(raw: string | number, label = 'id'): string {
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) {
    throw new Error(`${label} must be a positive numeric integer (got: ${JSON.stringify(raw)})`);
  }
  const n = parseInt(str, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive safe integer (got: ${JSON.stringify(raw)})`);
  }
  return String(n);
}

export function deriveAccountKey(effectiveZoneUrl?: string): string {
  const username = (process.env.AUTOTASK_USERNAME || '').toLowerCase().trim();
  const rawUrl =
    effectiveZoneUrl ||
    process.env.AUTOTASK_API_URL ||
    'https://webservices.autotask.net/atservicesrest/';

  let normalizedUrl: string;
  try {
    const parsed = new URL(rawUrl);
    normalizedUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    normalizedUrl = rawUrl.toLowerCase().trim().replace(/\/+$/, '');
  }

  return crypto.createHash('sha256').update(`${username}\0${normalizedUrl}`).digest('hex').slice(0, 16);
}

export function operationKey(accountKey: string, operationId: string): string {
  return crypto.createHash('sha256').update(`${accountKey}\0${operationId.trim()}`).digest('hex');
}

export function coordinatorDocId(accountKey: string, canonicalTicketId: string): string {
  return `${accountKey}_${canonicalTicketId}`;
}

export interface AcquireResult {
  acquired: boolean;
  claim: Claim;
  operation: OperationIntent;
}

export interface OperationStore {
  prepareOperation(params: {
    accountKey: string;
    operationId: string;
    actor: Actor;
    kind: OperationKind;
    ticketId: string;
    targetId?: string;
    intentSha256: string;
    payload: Record<string, unknown>;
  }): Promise<OperationIntent>;

  savePreparedState(params: {
    accountKey: string;
    ticketId: string;
    operationId: string;
    claim: Claim;
    preparedState: Record<string, unknown>;
  }): Promise<void>;

  getOperation(accountKey: string, operationId: string): Promise<OperationIntent | null>;

  acquireCoordinatorLease(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    owner: string,
    ttlMs: number,
    operationId: string,
  ): Promise<AcquireResult>;

  armDispatch(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    intentSha256: string,
  ): Promise<{ armed: boolean; expiresAt: number }>;

  markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: Record<string, unknown>,
  ): Promise<void>;

  markUncertain(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    error: string,
  ): Promise<void>;

  renewLease(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    ttlMs: number,
  ): Promise<{ renewed: boolean; expiresAt: number }>;

  releaseLease(accountKey: string, ticketId: string, attemptId: string): Promise<void>;

  inspectCoordinator(accountKey: string, ticketId: string): Promise<TicketCoordinator | null>;
}

export class MemoryOperationStore implements OperationStore {
  private readonly operations = new Map<string, OperationIntent>();
  private readonly coordinators = new Map<string, TicketCoordinator>();

  async prepareOperation(params: {
    accountKey: string;
    operationId: string;
    actor: Actor;
    kind: OperationKind;
    ticketId: string;
    targetId?: string;
    intentSha256: string;
    payload: Record<string, unknown>;
  }): Promise<OperationIntent> {
    const key = operationKey(params.accountKey, params.operationId);
    const existing = this.operations.get(key);
    const now = Date.now();

    if (existing) {
      if (
        existing.intentSha256 !== params.intentSha256 ||
        existing.ticketId !== params.ticketId ||
        existing.kind !== params.kind
      ) {
        throw new Error(
          `Conflict: operationId "${params.operationId}" was previously recorded with different intent/target; write refused`,
        );
      }
      if (
        existing.actor.email !== params.actor.email ||
        existing.actor.resourceId !== params.actor.resourceId
      ) {
        throw new Error(
          `Conflict: operationId "${params.operationId}" was previously prepared by another actor (${existing.actor.email} / ${existing.actor.resourceId}); write refused`,
        );
      }
      return { ...existing };
    }

    const intent: OperationIntent = {
      version: 1,
      accountKey: params.accountKey,
      operationId: params.operationId,
      actor: params.actor,
      kind: params.kind,
      ticketId: params.ticketId,
      targetId: params.targetId,
      intentSha256: params.intentSha256,
      payload: params.payload,
      phase: 'preparing',
      createdAt: now,
      updatedAt: now,
    };

    this.operations.set(key, intent);
    return { ...intent };
  }

  async savePreparedState(params: {
    accountKey: string;
    ticketId: string;
    operationId: string;
    claim: Claim;
    preparedState: Record<string, unknown>;
  }): Promise<void> {
    const coordKey = coordinatorDocId(params.accountKey, params.ticketId);
    const coord = this.coordinators.get(coordKey);
    const now = Date.now();

    if (
      !coord ||
      !coord.lease ||
      coord.lease.attemptId !== params.claim.attemptId ||
      coord.fence !== params.claim.fence ||
      coord.lease.expiresAt <= now
    ) {
      throw new Error(
        `Conflict: cannot commit preparation for ticket ${params.ticketId}; claim expired or superseded`,
      );
    }

    const key = operationKey(params.accountKey, params.operationId);
    const op = this.operations.get(key);
    if (!op) {
      throw new Error(`Operation "${params.operationId}" not found`);
    }

    if (op.phase === 'dispatching' || op.phase === 'verified') {
      throw new Error(`Conflict: operation "${params.operationId}" is already ${op.phase}`);
    }

    op.preparedState = { ...(op.preparedState ?? {}), ...params.preparedState };
    op.phase = 'prepared';
    op.updatedAt = now;
  }

  async getOperation(accountKey: string, operationId: string): Promise<OperationIntent | null> {
    const key = operationKey(accountKey, operationId);
    const op = this.operations.get(key);
    return op ? { ...op } : null;
  }

  async acquireCoordinatorLease(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    owner: string,
    ttlMs: number,
    operationId: string,
  ): Promise<AcquireResult> {
    const now = Date.now();
    const coordKey = coordinatorDocId(accountKey, ticketId);
    let coord = this.coordinators.get(coordKey);
    if (!coord) {
      coord = { accountKey, ticketId, fence: 0, lease: null, activeDispatch: null };
      this.coordinators.set(coordKey, coord);
    }

    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (!op) {
      throw new Error(`Operation "${operationId}" must be prepared before acquiring coordinator lease`);
    }

    const mode =
      op.phase === 'dispatching' || op.phase === 'uncertain' ? 'reconciling' : 'preparing';

    if (coord.activeDispatch && coord.activeDispatch.operationId !== operationId) {
      throw new Error(
        `Conflict: ticket ${ticketId} has an unresolved dispatch barrier for operation "${coord.activeDispatch.operationId}"; cannot acquire for operation "${operationId}" until reconciled`,
      );
    }

    if (coord.lease && coord.lease.expiresAt > now && coord.lease.attemptId !== attemptId) {
      return {
        acquired: false,
        claim: { attemptId, fence: coord.fence, expiresAt: coord.lease.expiresAt, mode },
        operation: { ...op },
      };
    }

    const fence = coord.fence + 1;
    const expiresAt = now + ttlMs;
    coord.fence = fence;
    coord.lease = {
      attemptId,
      owner,
      expiresAt,
    };

    return {
      acquired: true,
      claim: { attemptId, fence, expiresAt, mode },
      operation: { ...op },
    };
  }

  async armDispatch(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    intentSha256: string,
  ): Promise<{ armed: boolean; expiresAt: number }> {
    const now = Date.now();
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);
    if (!coord || !coord.lease || coord.lease.attemptId !== attemptId || coord.lease.expiresAt <= now) {
      return { armed: false, expiresAt: 0 };
    }

    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (!op || op.phase !== 'prepared') {
      throw new Error(
        `Conflict: operation "${operationId}" must be in exact "prepared" phase to arm dispatch (current: ${
          op?.phase ?? 'missing'
        })`,
      );
    }

    coord.activeDispatch = {
      operationKey: opKey,
      attemptId,
      operationId,
      intentSha256,
      dispatchedAt: now,
    };

    op.phase = 'dispatching';
    op.dispatchedAt = now;
    op.updatedAt = now;

    return { armed: true, expiresAt: coord.lease.expiresAt };
  }

  async markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);
    if (coord && coord.activeDispatch?.operationId === operationId) {
      coord.activeDispatch = null;
    }

    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (op) {
      op.phase = 'verified';
      op.completedAt = now;
      op.updatedAt = now;
      op.receipt = receipt;
    }
  }

  async markUncertain(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    error: string,
  ): Promise<void> {
    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (op && op.phase !== 'verified') {
      op.phase = 'uncertain';
      op.updatedAt = Date.now();
      op.error = error;
    }
  }

  async renewLease(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    ttlMs: number,
  ): Promise<{ renewed: boolean; expiresAt: number }> {
    const now = Date.now();
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);
    if (!coord || !coord.lease || coord.lease.attemptId !== attemptId) {
      return { renewed: false, expiresAt: 0 };
    }
    if (coord.lease.expiresAt <= now) {
      return { renewed: false, expiresAt: 0 };
    }
    coord.lease.expiresAt = now + ttlMs;
    return { renewed: true, expiresAt: coord.lease.expiresAt };
  }

  async releaseLease(accountKey: string, ticketId: string, attemptId: string): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);
    if (coord && coord.lease && coord.lease.attemptId === attemptId) {
      coord.lease = null;
    }
  }

  async inspectCoordinator(accountKey: string, ticketId: string): Promise<TicketCoordinator | null> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);
    return coord ? JSON.parse(JSON.stringify(coord)) : null;
  }

  clear(): void {
    this.operations.clear();
    this.coordinators.clear();
  }
}

export const OPERATIONS_COLLECTION = 'autotask_mcp_ticket_operations';
export const COORDINATORS_COLLECTION = 'autotask_mcp_ticket_coordinators';

export class FirestoreOperationStore implements OperationStore {
  constructor(private readonly firestore: Firestore) {}

  async prepareOperation(params: {
    accountKey: string;
    operationId: string;
    actor: Actor;
    kind: OperationKind;
    ticketId: string;
    targetId?: string;
    intentSha256: string;
    payload: Record<string, unknown>;
  }): Promise<OperationIntent> {
    const key = operationKey(params.accountKey, params.operationId);
    const docRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(key);

    return this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const now = Date.now();
      if (snap.exists) {
        const existing = snap.data() as OperationIntent;
        if (
          existing.intentSha256 !== params.intentSha256 ||
          existing.ticketId !== params.ticketId ||
          existing.kind !== params.kind
        ) {
          throw new Error(
            `Conflict: operationId "${params.operationId}" was previously recorded with different intent/target; write refused`,
          );
        }
        if (
          existing.actor.email !== params.actor.email ||
          existing.actor.resourceId !== params.actor.resourceId
        ) {
          throw new Error(
            `Conflict: operationId "${params.operationId}" was previously prepared by another actor (${existing.actor.email} / ${existing.actor.resourceId}); write refused`,
          );
        }
        return existing;
      }

      const intent: OperationIntent = {
        version: 1,
        accountKey: params.accountKey,
        operationId: params.operationId,
        actor: params.actor,
        kind: params.kind,
        ticketId: params.ticketId,
        targetId: params.targetId,
        intentSha256: params.intentSha256,
        payload: params.payload,
        phase: 'preparing',
        createdAt: now,
        updatedAt: now,
      };

      txn.set(docRef, intent);
      return intent;
    });
  }

  async savePreparedState(params: {
    accountKey: string;
    ticketId: string;
    operationId: string;
    claim: Claim;
    preparedState: Record<string, unknown>;
  }): Promise<void> {
    const coordKey = coordinatorDocId(params.accountKey, params.ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(params.accountKey, params.operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    await this.firestore.runTransaction(async (txn) => {
      const coordSnap = await txn.get(coordRef);
      const now = Date.now();
      const coord = coordSnap.data() as TicketCoordinator | undefined;

      if (
        !coord ||
        !coord.lease ||
        coord.lease.attemptId !== params.claim.attemptId ||
        coord.fence !== params.claim.fence ||
        coord.lease.expiresAt <= now
      ) {
        throw new Error(
          `Conflict: cannot commit preparation for ticket ${params.ticketId}; claim expired or superseded`,
        );
      }

      const opSnap = await txn.get(opRef);
      const op = opSnap.data() as OperationIntent | undefined;
      if (!op) {
        throw new Error(`Operation "${params.operationId}" not found`);
      }

      if (op.phase === 'dispatching' || op.phase === 'verified') {
        throw new Error(`Conflict: operation "${params.operationId}" is already ${op.phase}`);
      }

      txn.update(opRef, {
        preparedState: { ...(op.preparedState ?? {}), ...params.preparedState },
        phase: 'prepared',
        updatedAt: now,
      });
    });
  }

  async getOperation(accountKey: string, operationId: string): Promise<OperationIntent | null> {
    const key = operationKey(accountKey, operationId);
    const snap = await this.firestore.collection(OPERATIONS_COLLECTION).doc(key).get();
    if (!snap.exists) return null;
    return (snap.data() as OperationIntent) ?? null;
  }

  async acquireCoordinatorLease(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    owner: string,
    ttlMs: number,
    operationId: string,
  ): Promise<AcquireResult> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    return this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(coordRef);
      const now = Date.now();
      const data = snap.exists ? (snap.data() as TicketCoordinator | undefined) : undefined;

      const opSnap = await txn.get(opRef);
      const op = opSnap.data() as OperationIntent | undefined;
      if (!op) {
        throw new Error(
          `Operation "${operationId}" must be prepared before acquiring coordinator lease`,
        );
      }

      const mode =
        op.phase === 'dispatching' || op.phase === 'uncertain' ? 'reconciling' : 'preparing';

      if (data?.activeDispatch && data.activeDispatch.operationId !== operationId) {
        throw new Error(
          `Conflict: ticket ${ticketId} has an unresolved dispatch barrier for operation "${data.activeDispatch.operationId}"; cannot acquire for operation "${operationId}" until reconciled`,
        );
      }

      if (data?.lease && data.lease.expiresAt > now && data.lease.attemptId !== attemptId) {
        return {
          acquired: false,
          claim: { attemptId, fence: data.fence, expiresAt: data.lease.expiresAt, mode },
          operation: op,
        };
      }

      const fence = (data?.fence ?? 0) + 1;
      const expiresAt = now + ttlMs;

      txn.set(
        coordRef,
        {
          accountKey,
          ticketId,
          fence,
          lease: {
            attemptId,
            owner,
            expiresAt,
          },
          activeDispatch: data?.activeDispatch ?? null,
        },
        { merge: true },
      );

      return {
        acquired: true,
        claim: { attemptId, fence, expiresAt, mode },
        operation: op,
      };
    });
  }

  async armDispatch(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    intentSha256: string,
  ): Promise<{ armed: boolean; expiresAt: number }> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    return this.firestore.runTransaction(async (txn) => {
      const coordSnap = await txn.get(coordRef);
      const now = Date.now();
      const data = coordSnap.data() as TicketCoordinator | undefined;

      if (!data?.lease || data.lease.attemptId !== attemptId || data.lease.expiresAt <= now) {
        return { armed: false, expiresAt: 0 };
      }

      const opSnap = await txn.get(opRef);
      const opData = opSnap.data() as OperationIntent | undefined;
      if (!opData || opData.phase !== 'prepared') {
        throw new Error(
          `Conflict: operation "${operationId}" must be in exact "prepared" phase to arm dispatch (current: ${
            opData?.phase ?? 'missing'
          })`,
        );
      }

      txn.update(coordRef, {
        activeDispatch: {
          operationKey: opKey,
          attemptId,
          operationId,
          intentSha256,
          dispatchedAt: now,
        },
      });

      txn.update(opRef, {
        phase: 'dispatching',
        dispatchedAt: now,
        updatedAt: now,
      });

      return { armed: true, expiresAt: data.lease.expiresAt };
    });
  }

  async markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: Record<string, unknown>,
  ): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    await this.firestore.runTransaction(async (txn) => {
      const coordSnap = await txn.get(coordRef);
      const data = coordSnap.data() as TicketCoordinator | undefined;
      if (coordSnap.exists && data?.activeDispatch && data.activeDispatch.operationId === operationId) {
        txn.update(coordRef, { activeDispatch: null });
      }

      const updates: Record<string, unknown> = {
        phase: 'verified',
        completedAt: Date.now(),
        updatedAt: Date.now(),
        receipt,
      };
      txn.update(opRef, updates);
    });
  }

  async markUncertain(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    error: string,
  ): Promise<void> {
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);
    await this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(opRef);
      const data = snap.data() as OperationIntent | undefined;
      if (data && data.phase !== 'verified') {
        txn.update(opRef, {
          phase: 'uncertain',
          error,
          updatedAt: Date.now(),
        });
      }
    });
  }

  async renewLease(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    ttlMs: number,
  ): Promise<{ renewed: boolean; expiresAt: number }> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const docRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    return this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const now = Date.now();
      const data = snap.data() as TicketCoordinator | undefined;
      if (!data?.lease || data.lease.attemptId !== attemptId || data.lease.expiresAt <= now) {
        return { renewed: false, expiresAt: 0 };
      }
      const expiresAt = now + ttlMs;
      txn.update(docRef, { 'lease.expiresAt': expiresAt });
      return { renewed: true, expiresAt };
    });
  }

  async releaseLease(accountKey: string, ticketId: string, attemptId: string): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const docRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    await this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const data = snap.data() as TicketCoordinator | undefined;
      if (data?.lease && data.lease.attemptId === attemptId) {
        txn.update(docRef, { lease: null });
      }
    });
  }

  async inspectCoordinator(accountKey: string, ticketId: string): Promise<TicketCoordinator | null> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const snap = await this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey).get();
    if (!snap.exists) return null;
    return (snap.data() as TicketCoordinator) ?? null;
  }
}

let activeOperationStore: OperationStore | null = null;

export function getOperationStore(): OperationStore {
  if (activeOperationStore) return activeOperationStore;
  try {
    const projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    const fs = new Firestore({ projectId, ignoreUndefinedProperties: true });
    activeOperationStore = new FirestoreOperationStore(fs);
    return activeOperationStore;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new StoreUnavailableError(`Failed to initialize Firestore operation store: ${msg}`);
  }
}

export function setOperationStore(store: OperationStore | null): void {
  activeOperationStore = store;
}
