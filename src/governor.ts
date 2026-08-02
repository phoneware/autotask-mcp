/**
 * Guards the tenant-wide Autotask API budget.
 *
 * Autotask enforces two limits that a hosted, agent-driven MCP trips far more
 * easily than a human-driven integration, and neither is scoped to this server:
 *
 *   - 10,000 external requests per hour, counted per *database* across every
 *     integration. Autotask adds latency at 50% and 75% of the budget, then
 *     suspends API service for the entire tenant once it is exhausted.
 *   - 3 concurrent requests per object endpoint per tracking identifier,
 *     answered with a 429 on breach.
 *
 * Because the hourly budget is shared, an agent loop here degrades (and can
 * suspend) every other Autotask integration Phoneware runs. So the governor
 * keeps our own concurrency at or under Autotask's thread limit, and trips a
 * breaker on the hourly budget while there is still headroom left for the
 * integrations that are not us.
 */

/** Autotask's own per-endpoint thread limit. We never exceed it by default. */
export const AUTOTASK_THREAD_LIMIT = 3;

const DEFAULT_STOP_PCT = 90;
const DEFAULT_WARN_PCT = 75;

/** How long a ThresholdInformation reading stays fresh. */
export const THRESHOLD_CACHE_MS = 60_000;

export interface ThresholdSnapshot {
  /** Requests allowed per timeframe (Autotask reports 10,000). */
  threshold: number;
  /** Requests consumed in the current timeframe, across ALL integrations. */
  used: number;
  /** Percentage of the tenant-wide budget consumed. */
  usedPct: number;
  fetchedAt: number;
}

/** Shape of the useful fields in Autotask's ThresholdInformation response. */
interface ThresholdResponse {
  externalRequestThreshold?: number;
  currentTimeframeRequestCount?: number;
  requestThresholdTimeframe?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Percentage of the hourly budget at which we stop serving Autotask calls. */
export function stopPct(): number {
  return envInt('AUTOTASK_THRESHOLD_STOP_PCT', DEFAULT_STOP_PCT);
}

/** Percentage at which we start warning (Autotask is already adding latency). */
export function warnPct(): number {
  return envInt('AUTOTASK_THRESHOLD_WARN_PCT', DEFAULT_WARN_PCT);
}

/** Max concurrent in-flight requests per object endpoint. */
export function maxConcurrent(): number {
  return envInt('AUTOTASK_MAX_CONCURRENT', AUTOTASK_THREAD_LIMIT);
}

/**
 * Derive the Autotask "object endpoint" a REST path belongs to. Autotask scopes
 * its thread limit to the object, so "V1.0/Tickets/query", "V1.0/Tickets/123"
 * and "V1.0/Tickets/123/Notes" all share one budget. Keying on the first
 * segment after the version deliberately over-approximates child collections
 * (stricter than Autotask, never looser).
 */
export function endpointKey(path: string): string {
  const segments = path.replace(/^\//, '').split('/');
  // Paths are "V1.0/<Object>/...". Drop the version prefix when present.
  const start = /^v\d+(\.\d+)?$/i.test(segments[0] ?? '') ? 1 : 0;
  return (segments[start] ?? 'unknown').toLowerCase();
}

/**
 * Counting semaphore with slot handoff: a released slot passes directly to the
 * next waiter rather than being decremented and re-acquired, so `active` can
 * never drift above the limit under concurrent release.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      // The releasing slot is handed to us, so `active` already accounts for it.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    };
  }
}

/** Thrown when the tenant-wide budget is too depleted to serve more calls. */
export class ThresholdExceededError extends Error {
  constructor(snapshot: ThresholdSnapshot, limit: number) {
    super(
      `Autotask API budget guard tripped: the tenant has used ${snapshot.used}/${snapshot.threshold} ` +
        `requests (${snapshot.usedPct.toFixed(1)}%) this hour, at or above the ${limit}% stop threshold. ` +
        `This limit is shared by every Autotask integration, not just this server, so calls are being ` +
        `refused to avoid suspending API access tenant-wide. Retry once usage drops, or raise ` +
        `AUTOTASK_THRESHOLD_STOP_PCT if this is deliberate.`,
    );
    this.name = 'ThresholdExceededError';
  }
}

export class ApiGovernor {
  private snapshot: ThresholdSnapshot | null = null;
  private inflight: Promise<ThresholdSnapshot | null> | null = null;
  private readonly semaphores = new Map<string, Semaphore>();
  private warned = false;

  /** Most recent budget reading, for /health. Never triggers a fetch. */
  get lastSnapshot(): ThresholdSnapshot | null {
    return this.snapshot;
  }

  /** Drop cached state. Tests use this to isolate cases. */
  reset(): void {
    this.snapshot = null;
    this.inflight = null;
    this.semaphores.clear();
    this.warned = false;
  }

  private semaphoreFor(key: string): Semaphore {
    const limit = maxConcurrent();
    let sem = this.semaphores.get(key);
    // Rebuild when the configured limit changes (env is read at call time).
    if (!sem || sem.limit !== limit) {
      sem = new Semaphore(limit);
      this.semaphores.set(key, sem);
    }
    return sem;
  }

  /**
   * Refresh the cached budget reading if it is stale. Costs one API call per
   * cache window (60 per hour out of 10,000), and coalesces concurrent
   * refreshes so a burst of tool calls triggers a single fetch.
   */
  private async refresh(fetchThreshold: () => Promise<unknown>): Promise<ThresholdSnapshot | null> {
    const now = Date.now();
    if (this.snapshot && now - this.snapshot.fetchedAt < THRESHOLD_CACHE_MS) {
      return this.snapshot;
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const raw = (await fetchThreshold()) as ThresholdResponse;
        const threshold = Number(raw?.externalRequestThreshold);
        const used = Number(raw?.currentTimeframeRequestCount);
        if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(used)) {
          return null;
        }
        this.snapshot = {
          threshold,
          used,
          usedPct: (used / threshold) * 100,
          fetchedAt: Date.now(),
        };
        return this.snapshot;
      } catch {
        // A failed budget check must not take the server down: if we cannot
        // read the threshold we let the call through and rely on Autotask's
        // own 429s. Failing closed here would turn one flaky read into a
        // total outage of the tool surface.
        return null;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  /**
   * Throw if the tenant-wide hourly budget is at or past the stop threshold.
   * Warns once per cache window in the band where Autotask is already adding
   * latency, so a degraded PSA has a visible cause in the logs.
   */
  async assertBudget(fetchThreshold: () => Promise<unknown>): Promise<void> {
    const snap = await this.refresh(fetchThreshold);
    if (!snap) return;

    const stop = stopPct();
    if (snap.usedPct >= stop) {
      throw new ThresholdExceededError(snap, stop);
    }

    const warn = warnPct();
    if (snap.usedPct >= warn && !this.warned) {
      this.warned = true;
      console.error(
        `[autotask-mcp] WARNING: tenant API usage at ${snap.usedPct.toFixed(1)}% ` +
          `(${snap.used}/${snap.threshold}). Autotask is adding latency to every request ` +
          `against this database; calls stop at ${stop}%.`,
      );
    } else if (snap.usedPct < warn) {
      this.warned = false;
    }
  }

  /** Run `fn` holding a concurrency slot for the object endpoint `path` hits. */
  async withSlot<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.semaphoreFor(endpointKey(path)).acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const governor = new ApiGovernor();
