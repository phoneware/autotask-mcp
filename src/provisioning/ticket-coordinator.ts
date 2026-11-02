import crypto from 'node:crypto';
import type {
  Actor,
  Claim,
  OperationIntent,
  OperationKind,
} from './contracts.js';
import {
  canonicalizeNumericId,
  deriveAccountKey,
  getOperationStore,
  type OperationStore,
} from './operation-store.js';

export class TicketCoordinatorSession {
  readonly accountKey: string;
  readonly ticketId: string;
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
  private operation: OperationIntent | null = null;

  constructor(params: {
    ticketId: string;
    actor: Actor;
    operationId: string;
    kind: OperationKind;
    payload: Record<string, unknown>;
    store?: OperationStore;
    ttlMs?: number;
  }) {
    this.accountKey = deriveAccountKey();
    this.ticketId = canonicalizeNumericId(params.ticketId, 'ticketId');
    this.actor = params.actor;
    this.operationId = params.operationId;
    this.kind = params.kind;
    this.payload = params.payload;
    this.store = params.store ?? getOperationStore();
    this.ttlMs = params.ttlMs ?? 15000;
    this.attemptId = crypto.randomUUID();

    const canonicalJson = JSON.stringify(this.payload, Object.keys(this.payload).sort());
    this.intentSha256 = crypto
      .createHash('sha256')
      .update(`${this.ticketId}:${this.kind}:${canonicalJson}`)
      .digest('hex');
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

  async prepareAndAcquire(maxWaitMs = 15000): Promise<{ alreadyVerified: boolean; isRecovery: boolean }> {
    // 1. Transactionally register/validate operation intent
    this.operation = await this.store.prepareOperation({
      accountKey: this.accountKey,
      operationId: this.operationId,
      actor: this.actor,
      kind: this.kind,
      ticketId: this.ticketId,
      intentSha256: this.intentSha256,
      payload: this.payload,
    });

    if (this.operation.phase === 'verified') {
      return { alreadyVerified: true, isRecovery: false };
    }

    // 2. Acquire coordinator lease and return fresh operation snapshot under the claim
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

      if (res.acquired) {
        this.claim = res.claim;
        this.operation = res.operation;
        this.startHeartbeat();
        const isRecovery = res.claim.mode === 'reconciling';
        return { alreadyVerified: this.operation.phase === 'verified', isRecovery };
      }

      if (Date.now() - start > maxWaitMs) {
        throw new Error(
          `Conflict: timeout acquiring coordinator lease for ticket ${this.ticketId}; write refused (held until ${new Date(
            res.claim.expiresAt,
          ).toISOString()})`,
        );
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  async commitPreparation(preparedState: Record<string, unknown>): Promise<void> {
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
    });
    if (this.operation) {
      this.operation.preparedState = { ...(this.operation.preparedState ?? {}), ...preparedState };
      this.operation.phase = 'prepared';
    }
  }

  async armDispatch(): Promise<void> {
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
    );

    if (!res.armed) {
      this.lost = true;
      throw new Error(
        `Conflict: could not arm dispatch barrier for ticket ${this.ticketId} under operation "${this.operationId}"; lease expired or lost`,
      );
    }
    this.armed = true;
  }

  async markVerified(receipt: Record<string, unknown>): Promise<void> {
    await this.store.markVerified(
      this.accountKey,
      this.ticketId,
      this.attemptId,
      this.operationId,
      receipt,
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
    );
    // Active dispatch remains sticky on coordinator!
  }

  private startHeartbeat(): void {
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
      // Ignore release errors
    }
  }
}
