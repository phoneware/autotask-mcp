/**
 * Per-user tool promotion logic.
 *
 * Reads user call_api usage from the usage store and returns operations
 * that have reached the promotion threshold within the decay window.
 */
import {
  getUsageStore,
  _resetUsageStoreForTests,
  InMemoryUsageStore,
  FirestoreUsageStore,
  type UsageRecord,
  type UsageStore,
} from './usage-store.js';

export {
  getUsageStore,
  _resetUsageStoreForTests,
  InMemoryUsageStore,
  FirestoreUsageStore,
  type UsageRecord,
  type UsageStore,
};

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_DAYS = 14;

function promotionEnabled(): boolean {
  return process.env.MCP_DISABLE_PROMOTION !== 'true';
}

function getThreshold(): number {
  const raw = process.env.MCP_PROMOTE_THRESHOLD;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD;
}

function getWindowMs(): number {
  const raw = process.env.MCP_PROMOTE_WINDOW_DAYS;
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_DAYS;
  return Math.round(days * 24 * 60 * 60 * 1000);
}

/**
 * Returns names of operations that crossed the promotion threshold.
 */
export async function getPromotedToolNames(userKey: string | undefined): Promise<string[]> {
  if (!userKey || !promotionEnabled()) return [];
  const threshold = getThreshold();
  const cutoff = Date.now() - getWindowMs();

  try {
    const usage = await getUsageStore().getUserUsage(userKey);
    const names: string[] = [];
    for (const [name, rec] of usage) {
      if (rec.count >= threshold && rec.lastUsed >= cutoff) {
        names.push(name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Record a call_api invocation. Returns whether this call promoted the operation.
 */
export async function recordCallApiInvocation(
  userKey: string | undefined,
  toolName: string,
): Promise<{ promoted: boolean }> {
  if (!userKey || !promotionEnabled()) return { promoted: false };
  const store = getUsageStore();
  try {
    await store.recordCall(userKey, toolName);
    const usage = await store.getUserUsage(userKey);
    const rec = usage.get(toolName);
    const threshold = getThreshold();
    return { promoted: rec?.count === threshold };
  } catch {
    return { promoted: false };
  }
}
