import crypto from 'node:crypto';
import { Firestore, type DocumentSnapshot } from '@google-cloud/firestore';
import type {
  Actor,
  Claim,
  OperationIntent,
  OperationKind,
  OperationReceipt,
  TicketCoordinator,
  CompanyArchiveBinding,
  PreparedRequest,
  DispatchIdentity,
} from './contracts.js';
import { deriveCanonicalAccountKey, assertAccountWriteAdmitted } from './account.js';
import { sanitizeErrorMessage } from '../safe-errors.js';
import { BINDINGS_COLLECTION } from '../archive/bindings.js';
import { REQUIREMENTS_COLLECTION, type ChecklistTaskRequirement } from './requirements.js';
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
  if (str.length > 1 && str.startsWith('0')) {
    throw new Error(
      `${label} must be a canonical numeric integer without leading zeros (got: ${JSON.stringify(raw)})`,
    );
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
  actor?: Actor,
  targetId?: string,
): string {
  const canonicalJson = canonicalJsonStringify(payload);
  const actorStr = actor ? `${actor.email.toLowerCase()}:${actor.resourceId}:` : '';
  const targetStr = targetId ? `${targetId}:` : '';
  return crypto
    .createHash('sha256')
    .update(`${ticketId}:${targetStr}${kind}:${actorStr}${canonicalJson}`)
    .digest('hex');
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
  requiredRequirementId?: string;
  expectedRequirementRevision?: number;
  requiredEvidenceOpKey?: string;
}

export interface ObservationOnlyOptions {
  requiredRequirementId?: string;
  expectedRequirementRevision?: number;
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
    preparedRequest?: PreparedRequest;
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
    receipt: OperationReceipt,
    dispatchId?: string,
  ): Promise<void>;

  markObservationOnly(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt,
    options?: ObservationOnlyOptions,
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
        existing.kind !== params.kind ||
        (params.targetId && existing.targetId !== params.targetId) ||
        existing.actor?.email?.toLowerCase() !== params.actor.email.toLowerCase() ||
        existing.actor?.resourceId !== params.actor.resourceId
      ) {
        throw new Error(
          `Conflict: operationId "${params.operationId}" was already prepared with different immutable intent, target, or actor`,
        );
      }
      return { ...existing };
    }

    const now = Date.now();
    const op: OperationIntent = {
      version: 3,
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
    preparedRequest?: PreparedRequest;
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

    if (op.preparedRequest && params.preparedRequest) {
      const existingReq = canonicalJsonStringify(op.preparedRequest);
      const incomingReq = canonicalJsonStringify(params.preparedRequest);
      if (existingReq !== incomingReq) {
        throw new Error(
          `Conflict: operation "${params.operationId}" already has immutable preparedRequest committed; replacement refused`,
        );
      }
    }

    op.preparedState = { ...params.preparedState };
    if (params.preparedRequest) {
      op.preparedRequest = params.preparedRequest;
    }
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
    const dispatchIdentity: DispatchIdentity = {
      dispatchId,
      operationKey: opKey,
      intentSha256,
      preparedSha256: options?.preparedSha256 ?? op.preparedRequest?.preparedSha256 ?? '',
      requestSha256: options?.requestSha256 ?? '',
      policyFingerprint: options?.policyFingerprint,
      originalAttemptId: attemptId,
      originalFence: coord.fence,
      armedAt: now,
    };

    coord.activeDispatch = {
      ...dispatchIdentity,
      operationId,
      dispatchedAt: now,
    };

    op.phase = 'dispatching';
    op.dispatch = dispatchIdentity;
    op.dispatchedAt = now;
    op.updatedAt = now;

    return { armed: true, dispatchId, expiresAt: coord.lease.expiresAt };
  }

  async markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt,
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

    if (dispatchId && op.dispatch && op.dispatch.dispatchId !== dispatchId) {
      throw new Error('Conflict: operation dispatchId mismatch during finalization');
    }

    if (receipt.kind && receipt.kind !== op.kind) {
      throw new Error(`Conflict: receipt kind "${receipt.kind}" does not match operation kind "${op.kind}"`);
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
    receipt: OperationReceipt,
    _options?: ObservationOnlyOptions,
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
    if (!op) {
      throw new Error(`Operation "${operationId}" not found`);
    }

    if (op.phase !== 'preparing' && op.phase !== 'prepared') {
      throw new Error(`Conflict: cannot record observation-only for operation in phase "${op.phase}"`);
    }

    if (op.dispatch) {
      throw new Error('Conflict: operation already has a dispatch record; observation-only refused');
    }

    op.phase = 'verified';
    op.completedAt = now;
    op.updatedAt = now;
    op.receipt = receipt;
  }

  async markUncertain(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    error: string,
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
      throw new Error(`Conflict: lease expired or not owned by attempt ${attemptId}`);
    }

    if (coord.activeDispatch) {
      if (coord.activeDispatch.operationId !== operationId) {
        throw new Error(
          `Conflict: active dispatch barrier belongs to operation "${coord.activeDispatch.operationId}", not "${operationId}"`,
        );
      }
      if (dispatchId && coord.activeDispatch.dispatchId && coord.activeDispatch.dispatchId !== dispatchId) {
        throw new Error('Conflict: dispatchId mismatch when marking uncertain');
      }
    }

    const opKey = operationKey(accountKey, operationId);
    const op = this.operations.get(opKey);
    if (!op) {
      throw new Error(`Operation "${operationId}" not found`);
    }

    if (op.ticketId !== ticketId) {
      throw new Error(`Conflict: operation ticketId mismatch (${op.ticketId} vs ${ticketId})`);
    }

    if (op.phase !== 'dispatching' && op.phase !== 'uncertain') {
      throw new Error(`Conflict: cannot mark operation uncertain from phase "${op.phase}"`);
    }

    op.phase = 'uncertain';
    op.updatedAt = now;
    op.error = sanitizeErrorMessage(error);
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
          existing.kind !== params.kind ||
          (params.targetId && existing.targetId !== params.targetId) ||
          existing.actor?.email?.toLowerCase() !== params.actor.email.toLowerCase() ||
          existing.actor?.resourceId !== params.actor.resourceId
        ) {
          throw new Error(
            `Conflict: operationId "${params.operationId}" was already prepared with different immutable intent, target, or actor`,
          );
        }
        return existing;
      }

      const now = Date.now();
      const op: OperationIntent = {
        version: 3,
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
    preparedRequest?: PreparedRequest;
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
      const opSnap = await txn.get(opRef);
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

      const op = opSnap.data() as OperationIntent | undefined;
      if (!op) {
        throw new Error(`Operation "${params.operationId}" not found`);
      }

      if (op.phase !== 'preparing' && op.phase !== 'prepared') {
        throw new Error(
          `Conflict: operation "${params.operationId}" is already ${op.phase}; preparation refused`,
        );
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

      if (op.preparedRequest && params.preparedRequest) {
        const existingReq = canonicalJsonStringify(op.preparedRequest);
        const incomingReq = canonicalJsonStringify(params.preparedRequest);
        if (existingReq !== incomingReq) {
          throw new Error(
            `Conflict: operation "${params.operationId}" already has immutable preparedRequest committed; replacement refused`,
          );
        }
      }

      const updates: Record<string, unknown> = {
        preparedState: { ...params.preparedState },
        phase: 'prepared',
        updatedAt: now,
      };
      if (params.preparedRequest) {
        updates.preparedRequest = params.preparedRequest;
      }
      txn.update(opRef, updates);
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
      // ALL READS FIRST
      const coordSnap = await txn.get(coordRef);
      const opSnap = await txn.get(opRef);
      let bindingSnap: DocumentSnapshot | null = null;
      let reqSnap: DocumentSnapshot | null = null;
      let evOpSnap: DocumentSnapshot | null = null;

      if (options?.requiredBindingId) {
        const bindingRef = this.firestore.collection(BINDINGS_COLLECTION).doc(options.requiredBindingId);
        bindingSnap = await txn.get(bindingRef);
      }
      if (options?.requiredRequirementId) {
        const reqRef = this.firestore.collection(REQUIREMENTS_COLLECTION).doc(options.requiredRequirementId);
        reqSnap = await txn.get(reqRef);
      }
      if (options?.requiredEvidenceOpKey) {
        const evRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(options.requiredEvidenceOpKey);
        evOpSnap = await txn.get(evRef);
      }

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

      if (bindingSnap) {
        if (!bindingSnap.exists) {
          throw new Error(`Conflict: required binding "${options!.requiredBindingId}" not found during arming`);
        }
        const binding = bindingSnap.data() as CompanyArchiveBinding;
        if (binding.disabled) {
          throw new Error(`Conflict: required binding "${options!.requiredBindingId}" is disabled`);
        }
        if (options!.expectedPolicyRevision !== undefined && binding.version !== options!.expectedPolicyRevision) {
          throw new Error(
            `Conflict: binding revision changed during arming (expected: ${options!.expectedPolicyRevision}, current: ${binding.version})`,
          );
        }
      }

      if (reqSnap) {
        if (!reqSnap.exists) {
          throw new Error(`Conflict: required requirement "${options!.requiredRequirementId}" not found during arming`);
        }
        const req = reqSnap.data() as ChecklistTaskRequirement;
        if (req.disabled) {
          throw new Error(`Conflict: required requirement "${options!.requiredRequirementId}" is disabled`);
        }
        if (options!.expectedRequirementRevision !== undefined && req.version !== options!.expectedRequirementRevision) {
          throw new Error(
            `Conflict: requirement revision changed during arming (expected: ${options!.expectedRequirementRevision}, current: ${req.version})`,
          );
        }
      }

      if (evOpSnap) {
        if (!evOpSnap.exists) {
          throw new Error(`Conflict: required evidence operation "${options!.requiredEvidenceOpKey}" not found during arming`);
        }
        const ev = evOpSnap.data() as OperationIntent;
        if (ev.phase !== 'verified') {
          throw new Error(`Conflict: required evidence operation "${options!.requiredEvidenceOpKey}" is not verified`);
        }
      }

      const dispatchId = crypto.randomUUID();
      const dispatchIdentity: DispatchIdentity = {
        dispatchId,
        operationKey: opKey,
        intentSha256,
        preparedSha256: options?.preparedSha256 ?? opData.preparedRequest?.preparedSha256 ?? '',
        requestSha256: options?.requestSha256 ?? '',
        policyFingerprint: options?.policyFingerprint,
        originalAttemptId: attemptId,
        originalFence: data.fence,
        armedAt: now,
      };

      txn.update(coordRef, {
        activeDispatch: {
          ...dispatchIdentity,
          operationId,
          dispatchedAt: now,
        },
      });

      txn.update(opRef, {
        phase: 'dispatching',
        dispatch: dispatchIdentity,
        dispatchedAt: now,
        updatedAt: now,
      });

      return { armed: true, dispatchId, expiresAt: data.lease.expiresAt };
    });

  async markVerified(
    accountKey: string,
    ticketId: string,
    attemptId: string,
    operationId: string,
    receipt: OperationReceipt,
    dispatchId?: string,
  ): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    await this.firestore.runTransaction(async (txn) => {
      // ALL READS FIRST
      const coordSnap = await txn.get(coordRef);
      const opSnap = await txn.get(opRef);

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
      }

      const op = opSnap.data() as OperationIntent | undefined;
      if (!op) {
        throw new Error(`Operation "${operationId}" not found`);
      }

      if (op.phase !== 'dispatching' && op.phase !== 'uncertain') {
        throw new Error(`Conflict: cannot finalize operation in phase "${op.phase}"`);
      }

      if (dispatchId && op.dispatch && op.dispatch.dispatchId !== dispatchId) {
        throw new Error('Conflict: operation dispatchId mismatch during finalization');
      }

      if (receipt.kind && receipt.kind !== op.kind) {
        throw new Error(`Conflict: receipt kind "${receipt.kind}" does not match operation kind "${op.kind}"`);
      }

      // NOW ALL WRITES QUEUED
      if (coordSnap.exists && data?.activeDispatch) {
        txn.update(coordRef, { activeDispatch: null });
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
    receipt: OperationReceipt,
    options?: ObservationOnlyOptions,
  ): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    await this.firestore.runTransaction(async (txn) => {
      // ALL READS FIRST
      const coordSnap = await txn.get(coordRef);
      const opSnap = await txn.get(opRef);
      let reqSnap: DocumentSnapshot | null = null;
      if (options?.requiredRequirementId) {
        const reqRef = this.firestore.collection(REQUIREMENTS_COLLECTION).doc(options.requiredRequirementId);
        reqSnap = await txn.get(reqRef);
      }

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

      const op = opSnap.data() as OperationIntent | undefined;
      if (!op) {
        throw new Error(`Operation "${operationId}" not found`);
      }

      if (op.phase !== 'preparing' && op.phase !== 'prepared') {
        throw new Error(`Conflict: cannot record observation-only for operation in phase "${op.phase}"`);
      }

      if (op.dispatch) {
        throw new Error('Conflict: operation already has a dispatch record; observation-only refused');
      }

      if (reqSnap) {
        if (!reqSnap.exists) {
          throw new Error('Conflict: required requirement not found during observation-only finalization');
        }
        const req = reqSnap.data() as ChecklistTaskRequirement;
        if (req.disabled) {
          throw new Error('Conflict: required requirement is disabled');
        }
        if (options!.expectedRequirementRevision !== undefined && req.version !== options!.expectedRequirementRevision) {
          throw new Error('Conflict: requirement revision changed during observation-only finalization');
        }
      }

      // NOW QUEUE WRITES
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
    dispatchId?: string,
  ): Promise<void> {
    const coordKey = coordinatorDocId(accountKey, ticketId);
    const coordRef = this.firestore.collection(COORDINATORS_COLLECTION).doc(coordKey);
    const opKey = operationKey(accountKey, operationId);
    const opRef = this.firestore.collection(OPERATIONS_COLLECTION).doc(opKey);

    await this.firestore.runTransaction(async (txn) => {
      // ALL READS FIRST
      const coordSnap = await txn.get(coordRef);
      const opSnap = await txn.get(opRef);

      const coord = coordSnap.data() as TicketCoordinator | undefined;
      const now = Date.now();

      if (
        !coord ||
        !coord.lease ||
        coord.lease.attemptId !== attemptId ||
        coord.lease.expiresAt <= now
      ) {
        throw new Error(`Conflict: lease expired or not owned by attempt ${attemptId}`);
      }

      if (coord.activeDispatch) {
        if (coord.activeDispatch.operationId !== operationId) {
          throw new Error(
            `Conflict: active dispatch barrier belongs to "${coord.activeDispatch.operationId}", not "${operationId}"`,
          );
        }
        if (dispatchId && coord.activeDispatch.dispatchId && coord.activeDispatch.dispatchId !== dispatchId) {
          throw new Error('Conflict: dispatchId mismatch when marking uncertain');
        }
      }

      const op = opSnap.data() as OperationIntent | undefined;
      if (!op) {
        throw new Error(`Operation "${operationId}" not found`);
      }

      if (op.ticketId !== ticketId) {
        throw new Error(`Conflict: operation ticketId mismatch (${op.ticketId} vs ${ticketId})`);
      }

      if (op.phase !== 'dispatching' && op.phase !== 'uncertain') {
        throw new Error(`Conflict: cannot mark operation uncertain from phase "${op.phase}"`);
      }

      // NOW QUEUE WRITE (coord.activeDispatch barrier remains intact!)
      txn.update(opRef, {
        phase: 'uncertain',
        updatedAt: now,
        error: sanitizeErrorMessage(error),
      });
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
