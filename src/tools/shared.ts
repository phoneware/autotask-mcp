import { ToolResponse } from '../types.js';

/** Wrap any value as a pretty-printed JSON text tool response. */
export function jsonResponse(data: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Parse an optional positive integer arg, clamped to [1, max]. */
export function parseMaxRecords(raw: string | undefined, fallback = 50, max = 500): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Parse a required integer arg, rejecting non-numeric input. Tool args arrive
 * as strings; without this an agent passing "abc" would silently become NaN and
 * then `null` in the JSON payload, sending garbage to Autotask.
 */
export function intArg(name: string, raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    throw new Error(`${name} is required`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer (got "${raw}")`);
  }
  return n;
}

/** Parse a required finite number arg (allows decimals, e.g. hoursWorked). */
export function numberArg(name: string, raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    throw new Error(`${name} is required`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number (got "${raw}")`);
  }
  return n;
}

/** Like intArg but for optional args: returns undefined when absent. */
export function optionalIntArg(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  return intArg(name, raw);
}

export interface FilterClause {
  op: string;
  field?: string;
  value?: unknown;
  items?: FilterClause[];
}

/**
 * The Autotask "match every record" idiom. Identity matters: `isUnfiltered`
 * compares by reference, so a caller-supplied clause that happens to look the
 * same is still a real filter.
 */
export const MATCH_ALL: FilterClause = { op: 'gte', field: 'id', value: 0 };

/**
 * Autotask /query requires at least one filter clause. When a convenience tool
 * is called with no filters we fall back to "id >= 0" which matches every
 * record (the standard Autotask "fetch all" idiom).
 */
export function ensureFilter(clauses: FilterClause[]): FilterClause[] {
  if (clauses.length > 0) return clauses;
  return [MATCH_ALL];
}

/**
 * True when the filter is only the fetch-all fallback, i.e. the caller supplied
 * nothing to search on.
 */
export function isUnfiltered(filter: FilterClause[]): boolean {
  return filter.length === 1 && filter[0] === MATCH_ALL;
}

/**
 * Build a filter clause for an optional exact-match string arg. Returns null
 * when the arg is absent so callers can `.filter(Boolean)` it away.
 */
export function eqClause(field: string, value: string | undefined): FilterClause | null {
  if (value === undefined || value === '') return null;
  return { op: 'eq', field, value };
}

/** Build a "contains" clause for free-text search on a field. */
export function containsClause(field: string, value: string | undefined): FilterClause | null {
  if (value === undefined || value === '') return null;
  return { op: 'contains', field, value };
}

/**
 * OR-group of `contains` clauses across several fields, for a single free-text
 * term that could match any of them.
 */
export function anyContainsClause(
  fields: string[],
  value: string | undefined,
): FilterClause | null {
  if (value === undefined || value === '') return null;
  return { op: 'or', items: fields.map((field) => ({ op: 'contains', field, value })) };
}

export function collectClauses(...clauses: Array<FilterClause | null>): FilterClause[] {
  return ensureFilter(clauses.filter((c): c is FilterClause => c !== null));
}

/**
 * A search result plus the filter that produced it. `unfiltered: true` means no
 * criteria were supplied and Autotask returned an arbitrary first page: the
 * shape that previously read like a real search result.
 */
export function searchResponse(filter: FilterClause[], result: unknown): ToolResponse {
  const body =
    result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : { result };
  return jsonResponse({ filter, unfiltered: isUnfiltered(filter), ...body });
}

/**
 * Default Autotask Ticket status picklist codes considered "closed/done".
 * Picklists vary per instance, so this is overridable per call or via the
 * AUTOTASK_CLOSED_STATUS_IDS env var (comma-separated).
 */
export const DEFAULT_CLOSED_STATUS_IDS = [5, 16];

/** Resolve the closed-status id list: explicit arg > env > built-in default. */
export function resolveClosedStatusIds(raw?: string): number[] {
  const source = raw && raw.trim() !== '' ? raw : process.env.AUTOTASK_CLOSED_STATUS_IDS;
  if (!source) return DEFAULT_CLOSED_STATUS_IDS;
  const ids = source
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  return ids.length > 0 ? ids : DEFAULT_CLOSED_STATUS_IDS;
}

/** `true`/`false` string flag → boolean (anything else = false). */
export function boolFlag(value: string | undefined): boolean {
  return value === 'true';
}
