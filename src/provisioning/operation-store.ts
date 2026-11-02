import crypto from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type {
  Actor,
  Claim,
  OperationIntent,
  OperationKind,
  OperationReceipt,
  TicketCoordinator,
  CompanyArchiveBinding,
} from './contracts.js';
import { deriveCanonicalAccountKey, assertAccountWriteAdmitted } from './account.js';
import { sanitizeErrorMessage } from '../safe-errors.js';
import { BINDINGS_COLLECTION } from '../archive/bindings.js';

export const OPERATIONS_COLLECTION = 'provisioning_operations';
export const COORDINATORS_COLLECTION = 'provisioning_coordinators';

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

/**
 * Recursively canonicalize any JSON-compatible value to an unambiguous,
 * key-sorted JSON string without whitespace.
 */
export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}

export function computeIntentSha256(
  ticketId: string,
  kind: string,
  payload: Record<string, unknown>,
): string {
  const canonicalJson = canonicalJsonStringify(payload);
  return crypto.createHash('sha256').update(`${ticketId}:${kind}:${canonicalJson}`).digest('hex');
}

/**
 * Backward-compatible alias for deriveCanonicalAccountKey.
 */
export function deriveAccountKey(effectiveZoneUrl?: string): string {
  return deriveCanonicalAccountKey(undefined, effectiveZoneUrl);
}

export function operationKey(accountKey: string, operationId: string): string {
  return crypto.createHash('sha256').update(`${accountKey}\0${operationId.trim()}`).digest('hex');
}

export function coordinatorDocId(accountKey: string, canonicalTicketId: string): string {
  return `${accountKey}_${canonicalTicketId}`;
}

export interface AcquireResult {
  acquired: boolean;
  alreadyVerified?: boolean;
  claim: Claim;
  operation: OperationIntent;
}

export interface ArmDispatchOptions {
  preparedSha256?: string;
  requestSha256?: string;
  policyFingerprint?: string;
  requiredBindingId?: string;
  expectedPolicyRevision?: number;
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
    options?: ArmDispatchOptions,
  ): Promise<{ armed: boolean; dispatchId?: string; expiresAt: number }>;

  markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt | Record<string, unknown>,
    dispatchId?: string,
  ): Promise<void>;

  markObservationOnly(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt | Record<string, unknown>,
  ): Promise<void>;

  markUncertain(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    error: string,
    dispatchId?: string,
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

    if (existing) {
      if (
        existing.intentSha256 !== params.intentSha256 ||
        existing.ticketId !== params.ticketId ||
        existing.kind !== params.kind
      ) {
        throw new Error(
          `Conflict: operationId "${params.operationId}" was already prepared with different immutable intent`,
        );
      }
      return { ...existing };
    }

    const now = Date.now();
    const op: OperationIntent = {
      version: 2,
      accountKey: params.accountKey,
      operationId: params.operationId,
      operationKey: key,
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

    this.operations.set(key, op);
    return { ...op };
  }

  async savePreparedState(params: {
    accountKey: string;
    ticketId: string;
    operationId: string;
    claim: Claim;
    preparedState: Record<string, unknown>;
  }): Promise<void> {
    const now = Date.now();
    const coordKey = coordinatorDocId(params.accountKey, params.ticketId);
    const coord = this.coordinators.get(coordKey);

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

    if (params.claim.mode === 'reconciling') {
      throw new Error(
        `Conflict: cannot commit preparation in reconciling recovery mode for operation "${params.operationId}"`,
      );
    }

    const key = operationKey(params.accountKey, params.operationId);
    const op = this.operations.get(key);
    if (!op) {
      throw new Error(`Operation "${params.operationId}" not found`);
    }

    if (op.phase !== 'preparing' && op.phase !== 'prepared') {
      throw new Error(`Conflict: operation "${params.operationId}" is already ${op.phase}; preparation refused`);
    }

    if (op.preparedState) {
      const existingJson = canonicalJsonStringify(op.preparedState);
      const incomingJson = canonicalJsonStringify(params.preparedState);
      if (existingJson !== incomingJson) {
        throw new Error(
          `Conflict: operation "${params.operationId}" already has immutable preparation committed; replacement refused`,
        );
      }
    }

    op.preparedState = { ...params.preparedState };
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

    const claim: Claim = {
      accountKey,
      ticketId,
      operationKey: opKey,
      intentSha256: op.intentSha256,
      attemptId,
      fence: coord.fence,
      mode,
      expiresAt: coord.lease?.expiresAt ?? 0,
    };

    if (op.phase === 'verified') {
      return {
        acquired: false,
        alreadyVerified: true,
        claim,
        operation: { ...op },
      };
    }

    if (coord.activeDispatch && coord.activeDispatch.operationId !== operationId) {
      throw new Error(
        `Conflict: ticket ${ticketId} has an unresolved dispatch barrier for operation "${coord.activeDispatch.operationId}"; cannot acquire for operation "${operationId}" until reconciled`,
      );
    }

    if (coord.lease && coord.lease.expiresAt > now && coord.lease.attemptId !== attemptId) {
      return {
        acquired: false,
        claim,
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

    claim.fence = fence;
    claim.expiresAt = expiresAt;

    return {
      acquired: true,
      claim,
      operation: { ...op },
    };
  }

  async armDispatch(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    intentSha256: string,
    options?: ArmDispatchOptions,
  ): Promise<{ armed: boolean; dispatchId?: string; expiresAt: number }> {
    const now = Date.now();
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);
    if (!coord || !coord.lease || coord.lease.attemptId !== attemptId || coord.lease.expiresAt <= now) {
      return { armed: false, expiresAt: 0 };
    }

    if (coord.activeDispatch && coord.activeDispatch.operationId !== operationId) {
      throw new Error(
        `Conflict: ticket ${ticketId} already has an active dispatch barrier for operation "${coord.activeDispatch.operationId}"`,
      );
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

    if (op.intentSha256 !== intentSha256) {
      throw new Error(
        `Conflict: intentSha256 mismatch when arming operation "${operationId}"`,
      );
    }

    const dispatchId = crypto.randomUUID();
    coord.activeDispatch = {
      dispatchId,
      operationKey: opKey,
      attemptId,
      operationId,
      intentSha256,
      preparedSha256: options?.preparedSha256,
      requestSha256: options?.requestSha256,
      policyFingerprint: options?.policyFingerprint,
      dispatchedAt: now,
    };

    op.phase = 'dispatching';
    op.dispatchedAt = now;
    op.updatedAt = now;

    return { armed: true, dispatchId, expiresAt: coord.lease.expiresAt };
  }

  async markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt | Record<string, unknown>,
    dispatchId?: string,
  ): Promise<void> {
    const now = Date.now();
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);

    if (
      !coord ||
      !coord.lease ||
      coord.lease.attemptId !== attemptId ||
      coord.lease.expiresAt <= now
    ) {
      throw new Error(
        `Conflict: cannot mark verified; lease for ticket ${ticketId} expired or not owned by attempt ${attemptId}`,
      );
    }

    if (coord.activeDispatch) {
      if (coord.activeDispatch.operationId !== operationId) {
        throw new Error(
          `Conflict: active dispatch barrier belongs to operation "${coord.activeDispatch.operationId}", not "${operationId}"`,
        );
      }
      if (dispatchId && coord.activeDispatch.dispatchId && coord.activeDispatch.dispatchId !== dispatchId) {
        throw new Error('Conflict: dispatchId mismatch during finalization');
      }
      coord.activeDispatch = null;
    }

    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (!op) {
      throw new Error(`Operation "${operationId}" not found`);
    }

    if (op.phase !== 'dispatching' && op.phase !== 'uncertain') {
      throw new Error(`Conflict: cannot finalize operation in phase "${op.phase}"`);
    }

    op.phase = 'verified';
    op.completedAt = now;
    op.updatedAt = now;
    op.receipt = receipt;
  }

  async markObservationOnly(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt | Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);

    if (
      !coord ||
      !coord.lease ||
      coord.lease.attemptId !== attemptId ||
      coord.lease.expiresAt <= now
    ) {
      throw new Error(`Conflict: lease expired or not owned by attempt ${attemptId}`);
    }

    if (coord.activeDispatch) {
      throw new Error(
        `Conflict: cannot record observation-only while active dispatch barrier is present for "${coord.activeDispatch.operationId}"`,
      );
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
    _dispatchId?: string,
  ): Promise<void> {
    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (op && op.phase !== 'verified') {
      op.phase = 'uncertain';
      op.updatedAt = Date.now();
      op.error = sanitizeErrorMessage(error);
    }
    // Note: coord.activeDispatch barrier remains intact!
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
    if (!coord || !coord.lease || coord.lease.attemptId !== attemptId || coord.lease.expiresAt <= now) {
      return { renewed: false, expiresAt: 0 };
    }
    const expiresAt = now + ttlMs;
    coord.lease.expiresAt = expiresAt;
    return { renewed: true, expiresAt };
  }

  async releaseLease(accountKey: string, ticketId: string, attemptId: string): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);
    if (coord && coord.lease?.attemptId === attemptId) {
      coord.lease = null;
    }
  }

  async inspectCoordinator(accountKey: string, ticketId: string): Promise<TicketCoordinator | null> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coord = this.coordinators.get(coordKey);
    return coord ? { ...coord } : null;
  }
}

export class FirestoreOperationStore implements OperationStore {
  private readonly firestore: Firestore;

  constructor(firestore?: Firestore) {
    this.firestore =
      firestore ||
      new Firestore({
        projectId: process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
        ignoreUndefinedProperties: true,
      });
  }

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
    await assertAccountWriteAdmitted(this.firestore, params.accountKey);

    const key = operationKey(params.accountKey, params.operationId);
    const docRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(key);

    return this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      if (snap.exists) {
        const existing = snap.data() as OperationIntent;
        if (
          existing.intentSha256 !== params.intentSha256 ||
          existing.ticketId !== params.ticketId ||
          existing.kind !== params.kind
        ) {
          throw new Error(
            `Conflict: operationId "${params.operationId}" was already prepared with different immutable intent`,
          );
        }
        return existing;
      }

      const now = Date.now();
      const op: OperationIntent = {
        version: 2,
        accountKey: params.accountKey,
        operationId: params.operationId,
        operationKey: key,
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

      txn.set(docRef, op);
      return op;
    });
  }

  async savePreparedState(params: {
    accountKey: string;
    ticketId: string;
    operationId: string;
    claim: Claim;
    preparedState: Record<string, unknown>;
  }): Promise<void> {
    if (params.claim.mode === 'reconciling') {
      throw new Error(
        `Conflict: cannot commit preparation in reconciling recovery mode for operation "${params.operationId}"`,
      );
    }

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

      if (op.phase !== 'preparing' && op.phase !== 'prepared') {
        throw new Error(`Conflict: operation "${params.operationId}" is already ${op.phase}; preparation refused`);
      }

      if (op.preparedState) {
        const existingJson = canonicalJsonStringify(op.preparedState);
        const incomingJson = canonicalJsonStringify(params.preparedState);
        if (existingJson !== incomingJson) {
          throw new Error(
            `Conflict: operation "${params.operationId}" already has immutable preparation committed; replacement refused`,
          );
        }
      }

      txn.update(opRef, {
        preparedState: { ...params.preparedState },
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

      const claim: Claim = {
        accountKey,
        ticketId,
        operationKey: opKey,
        intentSha256: op.intentSha256,
        attemptId,
        fence: data?.fence ?? 0,
        mode,
        expiresAt: data?.lease?.expiresAt ?? 0,
      };

      if (op.phase === 'verified') {
        return {
          acquired: false,
          alreadyVerified: true,
          claim,
          operation: op,
        };
      }

      if (data?.activeDispatch && data.activeDispatch.operationId !== operationId) {
        throw new Error(
          `Conflict: ticket ${ticketId} has an unresolved dispatch barrier for operation "${data.activeDispatch.operationId}"; cannot acquire for operation "${operationId}" until reconciled`,
        );
      }

      if (data?.lease && data.lease.expiresAt > now && data.lease.attemptId !== attemptId) {
        return {
          acquired: false,
          claim,
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

      claim.fence = fence;
      claim.expiresAt = expiresAt;

      return {
        acquired: true,
        claim,
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
    options?: ArmDispatchOptions,
  ): Promise<{ armed: boolean; dispatchId?: string; expiresAt: number }> {
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

      if (data.activeDispatch && data.activeDispatch.operationId !== operationId) {
        throw new Error(
          `Conflict: ticket ${ticketId} already has an active dispatch barrier for operation "${data.activeDispatch.operationId}"`,
        );
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

      if (opData.intentSha256 !== intentSha256) {
        throw new Error(
          `Conflict: intentSha256 mismatch when arming operation "${operationId}"`,
        );
      }

      // Re-verify authoritative policy in the arming transaction if required
      if (options?.requiredBindingId) {
        const bindingRef = this.firestore.collection(BINDINGS_COLLECTION).doc(options.requiredBindingId);
        const bindingSnap = await txn.get(bindingRef);
        if (!bindingSnap.exists) {
          throw new Error(`Conflict: required binding "${options.requiredBindingId}" not found during arming`);
        }
        const binding = bindingSnap.data() as CompanyArchiveBinding;
        if (binding.disabled) {
          throw new Error(`Conflict: required binding "${options.requiredBindingId}" is disabled`);
        }
        if (
          options.expectedPolicyRevision !== undefined &&
          binding.version !== options.expectedPolicyRevision
        ) {
          throw new Error(
            `Conflict: binding revision changed during arming (expected: ${options.expectedPolicyRevision}, current: ${binding.version})`,
          );
        }
      }

      const dispatchId = crypto.randomUUID();
      txn.update(coordRef, {
        activeDispatch: {
          dispatchId,
          operationKey: opKey,
          attemptId,
          operationId,
          intentSha256,
          preparedSha256: options?.preparedSha256,
          requestSha256: options?.requestSha256,
          policyFingerprint: options?.policyFingerprint,
          dispatchedAt: now,
        },
      });

      txn.update(opRef, {
        phase: 'dispatching',
        dispatchedAt: now,
        updatedAt: now,
      });

      return { armed: true, dispatchId, expiresAt: data.lease.expiresAt };
    });
  }

  async markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt | Record<string, unknown>,
    dispatchId?: string,
  ): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    await this.firestore.runTransaction(async (txn) => {
      const coordSnap = await txn.get(coordRef);
      const data = coordSnap.data() as TicketCoordinator | undefined;
      const now = Date.now();

      if (
        !data ||
        !data.lease ||
        data.lease.attemptId !== attemptId ||
        data.lease.expiresAt <= now
      ) {
        throw new Error(
          `Conflict: cannot mark verified; lease for ticket ${ticketId} expired or not owned by attempt ${attemptId}`,
        );
      }

      if (coordSnap.exists && data?.activeDispatch) {
        if (data.activeDispatch.operationId !== operationId) {
          throw new Error(
            `Conflict: active dispatch barrier belongs to operation "${data.activeDispatch.operationId}", not "${operationId}"`,
          );
        }
        if (dispatchId && data.activeDispatch.dispatchId && data.activeDispatch.dispatchId !== dispatchId) {
          throw new Error('Conflict: dispatchId mismatch during finalization');
        }
        txn.update(coordRef, { activeDispatch: null });
      }

      const opSnap = await txn.get(opRef);
      const op = opSnap.data() as OperationIntent | undefined;
      if (!op) {
        throw new Error(`Operation "${operationId}" not found`);
      }

      if (op.phase !== 'dispatching' && op.phase !== 'uncertain') {
        throw new Error(`Conflict: cannot finalize operation in phase "${op.phase}"`);
      }

      const updates: Record<string, unknown> = {
        phase: 'verified',
        completedAt: now,
        updatedAt: now,
        receipt,
      };
      txn.update(opRef, updates);
    });
  }

  async markObservationOnly(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt | Record<string, unknown>,
  ): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    await this.firestore.runTransaction(async (txn) => {
      const coordSnap = await txn.get(coordRef);
      const now = Date.now();
      const coord = coordSnap.data() as TicketCoordinator | undefined;

      if (
        !coord ||
        !coord.lease ||
        coord.lease.attemptId !== attemptId ||
        coord.lease.expiresAt <= now
      ) {
        throw new Error(`Conflict: lease expired or not owned by attempt ${attemptId}`);
      }

      if (coord.activeDispatch) {
        throw new Error(
          `Conflict: cannot record observation-only while active dispatch barrier is present for "${coord.activeDispatch.operationId}"`,
        );
      }

      txn.update(opRef, {
        phase: 'verified',
        completedAt: now,
        updatedAt: now,
        receipt,
      });
    });
  }

  async markUncertain(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    error: string,
    _dispatchId?: string,
  ): Promise<void> {
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);
    await this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(opRef);
      const data = snap.data() as OperationIntent | undefined;
      if (data && data.phase !== 'verified') {
        txn.update(opRef, {
          phase: 'uncertain',
          updatedAt: Date.now(),
          error: sanitizeErrorMessage(error),
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
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);

    return this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(coordRef);
      const now = Date.now();
      const data = snap.data() as TicketCoordinator | undefined;

      if (!data?.lease || data.lease.attemptId !== attemptId || data.lease.expiresAt <= now) {
        return { renewed: false, expiresAt: 0 };
      }

      const expiresAt = now + ttlMs;
      txn.update(coordRef, {
        'lease.expiresAt': expiresAt,
      });

      return { renewed: true, expiresAt };
    });
  }

  async releaseLease(accountKey: string, ticketId: string, attemptId: string): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);

    try {
      await this.firestore.runTransaction(async (txn) => {
        const snap = await txn.get(coordRef);
        const data = snap.data() as TicketCoordinator | undefined;
        if (data?.lease?.attemptId === attemptId) {
          txn.update(coordRef, { lease: null });
        }
      });
    } catch {
      // Best-effort release
    }
  }

  async inspectCoordinator(accountKey: string, ticketId: string): Promise<TicketCoordinator | null> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const snap = await this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey).get();
    if (!snap.exists) return null;
    return (snap.data() as TicketCoordinator) ?? null;
  }
}

let globalOperationStore: OperationStore | null = null;

export function getOperationStore(): OperationStore {
  if (!globalOperationStore) {
    globalOperationStore = new FirestoreOperationStore();
  }
  return globalOperationStore;
}

export function setOperationStore(store: OperationStore | null): void {
  globalOperationStore = store;
}
