import crypto from 'node:crypto';
import type {
  Actor,
  Claim,
  OperationIntent,
  OperationKind,
  OperationReceipt,
  PreparedRequest,
} from './contracts.js';
import {
  canonicalizeNumericId,
  deriveAccountKey,
  getOperationStore,
  computeIntentSha256,
  type OperationStore,
  type ArmDispatchOptions,
  type ObservationOnlyOptions,
} from './operation-store.js';
import {
  issueDispatchPermit,
  type DispatchPermitToken,
} from './dispatch.js';

export interface TicketOperationInput {
  ticketId: string;
  actor: Actor;
  operationId: string;
  kind: OperationKind;
  payload: Record<string, unknown>;
  targetId?: string;
  effectiveZoneUrl?: string;
  store?: OperationStore;
  ttlMs?: number;
}

export class TicketCoordinatorSession {
  readonly accountKey: string;
  readonly ticketId: string;
  readonly targetId?: string;
  readonly actor: Actor;
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly payload: Record<string, unknown>;
  readonly intentSha256: string;
  readonly attemptId: string;
  private readonly store: OperationStore;
  private readonly ttlMs: number;
  private claim: Claim | null = null;
  private renewalTimer: NodeJS.Timeout | null = null;
  private lost = false;
  private armed = false;
  private dispatchId?: string;
  private currentPermitToken?: DispatchPermitToken;
  private operation: OperationIntent | null = null;

  constructor(params: TicketOperationInput) {
    const rawEmail = (params.actor?.email || '').trim().toLowerCase();
    if (!rawEmail) {
      throw new Error('Actor must have a verified non-empty email address');
    }
    const rawResourceId = params.actor?.resourceId;
    if (typeof rawResourceId !== 'number' || !Number.isSafeInteger(rawResourceId) || rawResourceId <= 0) {
      throw new Error(`Actor resourceId must be a positive safe integer (got: ${JSON.stringify(rawResourceId)})`);
    }

    this.actor = {
      email: rawEmail,
      resourceId: rawResourceId,
    };
    this.ticketId = canonicalizeNumericId(params.ticketId, 'ticketId');
    this.targetId = params.targetId;
    this.accountKey = deriveAccountKey(params.effectiveZoneUrl);
    this.operationId = params.operationId;
    this.kind = params.kind;
    this.payload = params.payload;
    this.store = params.store ?? getOperationStore();
    this.ttlMs = params.ttlMs ?? 15000;
    this.attemptId = crypto.randomUUID();

    this.intentSha256 = computeIntentSha256(
      this.ticketId,
      this.kind,
      this.payload,
      this.actor,
      this.targetId,
    );
  }
  getOperation(): OperationIntent | null {
    return this.operation;
  }

  getClaim(): Claim | null {
    return this.claim;
  }

  isArmed(): boolean {
    return this.armed;
  }

  getDispatchId(): string | undefined {
    return this.dispatchId;
  }

  getPermitToken(): DispatchPermitToken | undefined {
    return this.currentPermitToken;
  }

  async prepareAndAcquire(
    maxWaitMs = 15000,
  ): Promise<{ alreadyVerified: boolean; isRecovery: boolean }> {
    // 1. Register/validate operation intent
    this.operation = await this.store.prepareOperation({
      accountKey: this.accountKey,
      operationId: this.operationId,
      actor: this.actor,
      kind: this.kind,
      ticketId: this.ticketId,
      targetId: this.targetId,
      intentSha256: this.intentSha256,
      payload: this.payload,
    });

    if (this.operation.phase === 'verified') {
      return { alreadyVerified: true, isRecovery: false };
    }

    // 2. Acquire coordinator lease
    const start = Date.now();
    while (true) {
      const res = await this.store.acquireCoordinatorLease(
        this.accountKey,
        this.ticketId,
        this.attemptId,
        this.actor.email,
        this.ttlMs,
        this.operationId,
      );

      if (res.alreadyVerified) {
        this.claim = res.claim;
        this.operation = res.operation;
        return { alreadyVerified: true, isRecovery: false };
      }

      if (res.acquired) {
        this.claim = res.claim;
        this.operation = res.operation;
        const isRecovery = res.claim.mode === 'reconciling';
        if (this.operation.phase !== 'verified') {
          this.startHeartbeat();
        }
        return { alreadyVerified: this.operation.phase === 'verified', isRecovery };
      }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(
          `Conflict: timeout acquiring coordinator lease for ticket ${this.ticketId}; write refused (held until ${new Date(
            res.claim.expiresAt,
          ).toISOString()})`,
        );
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 100);
      await promise;
    }
  }

  async commitPreparation(
    preparedState: Record<string, unknown>,
    preparedRequest?: PreparedRequest,
  ): Promise<void> {
    if (!this.claim || !this.isFencedAndValid()) {
      throw new Error(
        `Conflict: claim expired or lost before committing preparation for ticket ${this.ticketId}`,
      );
    }
    await this.store.savePreparedState({
      accountKey: this.accountKey,
      ticketId: this.ticketId,
      operationId: this.operationId,
      claim: this.claim,
      preparedState,
      preparedRequest,
    });
    if (this.operation) {
      this.operation.preparedState = { ...(this.operation.preparedState ?? {}), ...preparedState };
      if (preparedRequest) {
        this.operation.preparedRequest = preparedRequest;
      }
      this.operation.phase = 'prepared';
    }
  }

  async armDispatch(
    options?: ArmDispatchOptions & {
      provider?: 'autotask' | 'google-drive';
      canonicalRoute?: string;
      method?: string;
      exactBodyDigest?: string;
    },
  ): Promise<{ armed: boolean; dispatchId?: string; permitToken?: DispatchPermitToken }> {
    if (!this.claim || !this.isFencedAndValid()) {
      throw new Error(
        `Conflict: coordinator lease expired before arming dispatch on ticket ${this.ticketId}; write refused`,
      );
    }

    const res = await this.store.armDispatch(
      this.accountKey,
      this.ticketId,
      this.attemptId,
      this.operationId,
      this.intentSha256,
      options,
    );

    if (!res.armed) {
      this.lost = true;
      throw new Error(
        `Conflict: could not arm dispatch barrier for ticket ${this.ticketId} under operation "${this.operationId}"; lease expired or lost`,
      );
    }

    this.armed = true;
    this.dispatchId = res.dispatchId;

    if (options?.provider && options?.canonicalRoute && options?.method && options?.exactBodyDigest) {
      this.currentPermitToken = issueDispatchPermit({
        dispatchId: res.dispatchId || crypto.randomUUID(),
        provider: options.provider,
        accountKey: this.accountKey,
        target: this.ticketId,
        method: options.method,
        route: options.canonicalRoute,
        exactBodyDigest: options.exactBodyDigest,
        policyFingerprint: options.policyFingerprint,
        issuedAt: Date.now(),
      });
    }

    return { armed: true, dispatchId: this.dispatchId, permitToken: this.currentPermitToken };
  }

  async markVerified(receipt: OperationReceipt): Promise<void> {
    await this.store.markVerified(
      this.accountKey,
      this.ticketId,
      this.attemptId,
      this.operationId,
      receipt,
      this.dispatchId,
    );
    this.armed = false;
  }

  async markObservationOnly(
    receipt: OperationReceipt,
    options?: ObservationOnlyOptions,
  ): Promise<void> {
    await this.store.markObservationOnly(
      this.accountKey,
      this.ticketId,
      this.attemptId,
      this.operationId,
      receipt,
      options,
    );
    this.armed = false;
  }

  async markUncertain(error: string): Promise<void> {
    await this.store.markUncertain(
      this.accountKey,
      this.ticketId,
      this.attemptId,
      this.operationId,
      error,
      this.dispatchId,
    );
  }

  private startHeartbeat(): void {
    if (this.renewalTimer) return;
    const intervalMs = Math.max(1000, Math.floor(this.ttlMs / 3));
    this.renewalTimer = setInterval(async () => {
      try {
        const res = await this.store.renewLease(
          this.accountKey,
          this.ticketId,
          this.attemptId,
          this.ttlMs,
        );
        if (!res.renewed) {
          this.lost = true;
          this.stopHeartbeat();
        } else if (this.claim) {
          this.claim.expiresAt = res.expiresAt;
        }
      } catch {
        this.lost = true;
        this.stopHeartbeat();
      }
    }, intervalMs);
    this.renewalTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  isFencedAndValid(): boolean {
    if (this.lost || !this.claim) return false;
    if (Date.now() >= this.claim.expiresAt) return false;
    return true;
  }

  forceExpire(): void {
    this.lost = true;
    if (this.claim) this.claim.expiresAt = Date.now() - 1000;
    this.stopHeartbeat();
  }

  async release(): Promise<void> {
    this.stopHeartbeat();
    try {
      await this.store.releaseLease(this.accountKey, this.ticketId, this.attemptId);
    } catch {
      // Best-effort release
    }
  }
}

/**
 * Scoped operation lifecycle wrapper (Contract 3.3).
 * Encloses lease acquisition, heartbeat startup, operation execution,
 * and guaranteed cleanup on every exit path.
 */
export async function withTicketOperation<T>(
  input: TicketOperationInput,
  callback: (session: TicketCoordinatorSession) => Promise<T>,
  maxWaitMs = 15000,
): Promise<T> {
  const session = new TicketCoordinatorSession(input);
  await session.prepareAndAcquire(maxWaitMs);
  try {
    return await callback(session);
  } finally {
    await session.release();
  }
}
