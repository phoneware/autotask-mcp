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

export interface FilterClause {
  op: string;
  field: string;
  value?: unknown;
}

/**
 * Autotask /query requires at least one filter clause. When a convenience tool
 * is called with no filters we fall back to "id >= 0" which matches every
 * record (the standard Autotask "fetch all" idiom).
 */
export function ensureFilter(clauses: FilterClause[]): FilterClause[] {
  if (clauses.length > 0) return clauses;
  return [{ op: 'gte', field: 'id', value: 0 }];
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

export function collectClauses(...clauses: Array<FilterClause | null>): FilterClause[] {
  return ensureFilter(clauses.filter((c): c is FilterClause => c !== null));
}
