import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ApiGovernor,
  Semaphore,
  ThresholdExceededError,
  endpointKey,
  governor,
  AUTOTASK_THREAD_LIMIT,
} from '../src/governor.js';

const ENV_KEYS = [
  'AUTOTASK_THRESHOLD_STOP_PCT',
  'AUTOTASK_THRESHOLD_WARN_PCT',
  'AUTOTASK_MAX_CONCURRENT',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  governor.reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.restoreAllMocks();
});

function threshold(used: number, limit = 10_000) {
  return { externalRequestThreshold: limit, currentTimeframeRequestCount: used };
}

describe('endpointKey', () => {
  it('keys on the object endpoint, ignoring the version and sub-paths', () => {
    expect(endpointKey('V1.0/Tickets/query')).toBe('tickets');
    expect(endpointKey('V1.0/Tickets/123')).toBe('tickets');
    // Child collections deliberately share the parent's budget: stricter than
    // Autotask, never looser.
    expect(endpointKey('V1.0/Tickets/123/Notes')).toBe('tickets');
    expect(endpointKey('/V1.0/Companies/query/count')).toBe('companies');
    expect(endpointKey('V1.0/ThresholdInformation')).toBe('thresholdinformation');
  });
});

describe('Semaphore', () => {
  it('never exceeds its limit and hands slots to waiters in order', async () => {
    const sem = new Semaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();
    expect(sem.inFlight).toBe(2);

    let third = false;
    const pending = sem.acquire().then((r) => {
      third = true;
      return r;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(sem.queued).toBe(1);

    release1();
    const release3 = await pending;
    expect(third).toBe(true);
    // Handing the slot over must not inflate the in-flight count.
    expect(sem.inFlight).toBe(2);

    release2();
    release3();
    expect(sem.inFlight).toBe(0);
  });

  it('ignores a double release', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inFlight).toBe(0);
  });
});

describe('ApiGovernor concurrency', () => {
  it('caps in-flight calls per endpoint at Autotask thread limit', async () => {
    const g = new ApiGovernor();
    let active = 0;
    let peak = 0;
    const task = () =>
      g.withSlot('V1.0/Tickets/query', async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });

    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBeLessThanOrEqual(AUTOTASK_THREAD_LIMIT);
    expect(peak).toBeGreaterThan(1);
  });

  it('budgets different endpoints independently', async () => {
    const g = new ApiGovernor();
    let ticketsActive = 0;
    let together = 0;

    await Promise.all([
      g.withSlot('V1.0/Tickets/query', async () => {
        ticketsActive++;
        await new Promise((r) => setTimeout(r, 10));
        ticketsActive--;
      }),
      g.withSlot('V1.0/Companies/query', async () => {
        together = ticketsActive;
        await new Promise((r) => setTimeout(r, 1));
      }),
    ]);

    // Companies ran while Tickets was in flight: separate endpoint, separate slot.
    expect(together).toBe(1);
  });

  it('releases the slot when the call throws', async () => {
    const g = new ApiGovernor();
    await expect(
      g.withSlot('V1.0/Tickets/query', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A leaked slot would make this hang rather than resolve.
    await expect(g.withSlot('V1.0/Tickets/query', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('ApiGovernor budget breaker', () => {
  it('allows calls with headroom', async () => {
    const g = new ApiGovernor();
    await expect(g.assertBudget(async () => threshold(1000))).resolves.toBeUndefined();
    expect(g.lastSnapshot?.usedPct).toBeCloseTo(10);
  });

  it('refuses calls at or above the stop threshold', async () => {
    const g = new ApiGovernor();
    await expect(g.assertBudget(async () => threshold(9500))).rejects.toBeInstanceOf(
      ThresholdExceededError,
    );
  });

  it('honors a configured stop percentage', async () => {
    process.env.AUTOTASK_THRESHOLD_STOP_PCT = '50';
    const g = new ApiGovernor();
    await expect(g.assertBudget(async () => threshold(6000))).rejects.toBeInstanceOf(
      ThresholdExceededError,
    );
  });

  it('warns once in the latency band without blocking', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = new ApiGovernor();
    await expect(g.assertBudget(async () => threshold(8000))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('80.0%');
  });

  it('caches the reading, so a burst of calls costs one probe', async () => {
    const g = new ApiGovernor();
    const probe = vi.fn(async () => threshold(100));
    await Promise.all(Array.from({ length: 20 }, () => g.assertBudget(probe)));
    expect(probe).toHaveBeenCalledOnce();
  });

  it('fails open when the probe errors, rather than taking the tool surface down', async () => {
    const g = new ApiGovernor();
    await expect(
      g.assertBudget(async () => {
        throw new Error('threshold endpoint down');
      }),
    ).resolves.toBeUndefined();
  });

  it('fails open on a malformed threshold payload', async () => {
    const g = new ApiGovernor();
    await expect(g.assertBudget(async () => ({ nonsense: true }))).resolves.toBeUndefined();
    expect(g.lastSnapshot).toBeNull();
  });
});
