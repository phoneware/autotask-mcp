import crypto from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type {
  Actor,
  OperationIntent,
  OperationKind,
  OperationPhase,
  TicketCoordinator,
} from './contracts.js';

export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

export function deriveAccountKey(): string {
  const username = (process.env.AUTOTASK_USERNAME || '').toLowerCase().trim();
  const url = (process.env.AUTOTASK_API_URL || '').toLowerCase().trim();
  return crypto.createHash('sha256').update(`${username}\0${url}`).digest('hex').slice(0, 16);
}

export function operationKey(accountKey: string, operationId: string): string {
  return crypto.createHash('sha256').update(`${accountKey}\0${operationId.trim()}`).digest('hex');
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

  getOperation(accountKey: string, operationId: string): Promise<OperationIntent | null>;

  acquireCoordinatorLease(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    owner: string,
    ttlMs: number,
    operationId: string,
  ): Promise<{ acquired: boolean; fence: number; expiresAt: number }>;

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
    receipt?: Record<string, unknown>,
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
      if (existing.actor.email !== params.actor.email) {
        throw new Error(
          `Conflict: operationId "${params.operationId}" was previously prepared by another actor (${existing.actor.email}); write refused`,
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
      phase: 'prepared',
      createdAt: now,
      updatedAt: now,
    };

    this.operations.set(key, intent);
    return { ...intent };
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
  ): Promise<{ acquired: boolean; fence: number; expiresAt: number }> {
    const now = Date.now();
    let coord = this.coordinators.get(ticketId);
    if (!coord) {
      coord = { accountKey, ticketId, fence: 0, lease: null, activeDispatch: null };
      this.coordinators.set(ticketId, coord);
    }

    // Sticky dispatch barrier check
    if (coord.activeDispatch) {
      if (coord.activeDispatch.operationId !== operationId) {
        throw new Error(
          `Conflict: ticket ${ticketId} has an unresolved dispatch barrier for operation "${coord.activeDispatch.operationId}"; cannot acquire for operation "${operationId}" until reconciled`,
        );
      }
    }

    // Check active preparation lease
    if (coord.lease && coord.lease.expiresAt > now && coord.lease.attemptId !== attemptId) {
      return { acquired: false, fence: coord.fence, expiresAt: coord.lease.expiresAt };
    }

    const fence = coord.fence + 1;
    const expiresAt = now + ttlMs;
    coord.fence = fence;
    coord.lease = {
      attemptId,
      owner,
      expiresAt,
    };

    return { acquired: true, fence, expiresAt };
  }

  async armDispatch(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    intentSha256: string,
  ): Promise<{ armed: boolean; expiresAt: number }> {
    const now = Date.now();
    const coord = this.coordinators.get(ticketId);
    if (!coord || !coord.lease || coord.lease.attemptId !== attemptId || coord.lease.expiresAt <= now) {
      return { armed: false, expiresAt: 0 };
    }

    const opKey = operationKey(accountKey, operationId);
    coord.activeDispatch = {
      operationKey: opKey,
      attemptId,
      operationId,
      intentSha256,
      dispatchedAt: now,
    };

    const op = this.operations.get(opKey);
    if (op) {
      op.phase = 'dispatching';
      op.dispatchedAt = now;
      op.updatedAt = now;
    }

    return { armed: true, expiresAt: coord.lease.expiresAt };
  }

  async markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt?: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();
    const coord = this.coordinators.get(ticketId);
    if (coord && coord.activeDispatch?.attemptId === attemptId) {
      coord.activeDispatch = null;
    }

    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (op) {
      op.phase = 'verified';
      op.completedAt = now;
      op.updatedAt = now;
      if (receipt) op.receipt = receipt;
    }
  }

  async markUncertain(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    error: string,
  ): Promise<void> {
    const now = Date.now();
    // Do NOT clear activeDispatch! It remains sticky.
    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (op) {
      op.phase = 'uncertain';
      op.updatedAt = now;
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
    const coord = this.coordinators.get(ticketId);
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
    const coord = this.coordinators.get(ticketId);
    if (coord && coord.lease && coord.lease.attemptId === attemptId) {
      coord.lease = null;
    }
  }

  async inspectCoordinator(accountKey: string, ticketId: string): Promise<TicketCoordinator | null> {
    const coord = this.coordinators.get(ticketId);
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
        if (existing.actor.email !== params.actor.email) {
          throw new Error(
            `Conflict: operationId "${params.operationId}" was previously prepared by another actor (${existing.actor.email}); write refused`,
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
        phase: 'prepared',
        createdAt: now,
        updatedAt: now,
      };

      txn.set(docRef, intent);
      return intent;
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
  ): Promise<{ acquired: boolean; fence: number; expiresAt: number }> {
    const docRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(ticketId);

    return this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const now = Date.now();
      const data = snap.exists ? (snap.data() as TicketCoordinator | undefined) : undefined;

      if (data?.activeDispatch) {
        if (data.activeDispatch.operationId !== operationId) {
          throw new Error(
            `Conflict: ticket ${ticketId} has an unresolved dispatch barrier for operation "${data.activeDispatch.operationId}"; cannot acquire for operation "${operationId}" until reconciled`,
          );
        }
      }

      if (data?.lease && data.lease.expiresAt > now && data.lease.attemptId !== attemptId) {
        return { acquired: false, fence: data.fence, expiresAt: data.lease.expiresAt };
      }

      const fence = (data?.fence ?? 0) + 1;
      const expiresAt = now + ttlMs;

      txn.set(
        docRef,
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

      return { acquired: true, fence, expiresAt };
    });
  }

  async armDispatch(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    intentSha256: string,
  ): Promise<{ armed: boolean; expiresAt: number }> {
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(ticketId);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    return this.firestore.runTransaction(async (txn) => {
      const coordSnap = await txn.get(coordRef);
      const now = Date.now();
      const data = coordSnap.data() as TicketCoordinator | undefined;

      if (!data?.lease || data.lease.attemptId !== attemptId || data.lease.expiresAt <= now) {
        return { armed: false, expiresAt: 0 };
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
    receipt?: Record<string, unknown>,
  ): Promise<void> {
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(ticketId);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    await this.firestore.runTransaction(async (txn) => {
      const coordSnap = await txn.get(coordRef);
      const data = coordSnap.data() as TicketCoordinator | undefined;
      if (data?.activeDispatch && data.activeDispatch.attemptId === attemptId) {
        txn.update(coordRef, { activeDispatch: null });
      }

      const updates: Record<string, unknown> = {
        phase: 'verified',
        completedAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (receipt) updates.receipt = receipt;
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
      txn.update(opRef, {
        phase: 'uncertain',
        error,
        updatedAt: Date.now(),
      });
    });
  }

  async renewLease(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    ttlMs: number,
  ): Promise<{ renewed: boolean; expiresAt: number }> {
    const docRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(ticketId);
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
    const docRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(ticketId);
    await this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const data = snap.data() as TicketCoordinator | undefined;
      if (data?.lease && data.lease.attemptId === attemptId) {
        txn.update(docRef, { lease: null });
      }
    });
  }

  async inspectCoordinator(accountKey: string, ticketId: string): Promise<TicketCoordinator | null> {
    const snap = await this.firestore.collection(COORDINATORS_COLLECTION).doc(ticketId).get();
    if (!snap.exists) return null;
    return (snap.data() as TicketCoordinator) ?? null;
  }
}

let activeOperationStore: OperationStore | null = null;

export function getOperationStore(): OperationStore {
  if (activeOperationStore) return activeOperationStore;
  const projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) {
    try {
      const fs = new Firestore({ projectId, ignoreUndefinedProperties: true });
      activeOperationStore = new FirestoreOperationStore(fs);
      return activeOperationStore;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new StoreUnavailableError(`Failed to connect to Firestore operation store: ${msg}`);
    }
  }

  // Fails closed on hosted mutation path: Firestore required
  throw new StoreUnavailableError(
    'Durable operation store unavailable: Firestore configuration required for mutating operations. ' +
      'Set FIRESTORE_PROJECT_ID or GOOGLE_CLOUD_PROJECT, or inject an explicit test store via setOperationStore().',
  );
}

export function setOperationStore(store: OperationStore | null): void {
  activeOperationStore = store;
}
