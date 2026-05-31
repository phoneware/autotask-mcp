import { z } from 'zod';

// Tools that mutate Autotask data. In read-only mode none of these are
// registered, so a misconfigured agent physically cannot write.
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'create-entity',
  'update-entity',
  'delete-entity',
  'create-ticket',
  'update-ticket',
  'create-company',
  'update-company',
  'create-contact',
  'update-contact',
  'create-time-entry',
  'create-ticket-note',
]);

// Every mutating tool requires an explicit confirm token. Derived from
// DESTRUCTIVE_TOOLS so the two sets can never drift: any tool that can write
// to Autotask is confirm-gated in full mode (and skipped entirely in
// read-only mode). The token forces a deliberate second step from the agent,
// preventing accidental single-call creates/updates/deletes on production data.
export const CONFIRM_REQUIRED_TOOLS: ReadonlySet<string> = DESTRUCTIVE_TOOLS;

/** The token an agent must pass in `confirm` to authorize a destructive tool. */
export function confirmTokenFor(toolName: string): string {
  return toolName.toUpperCase().replace(/-/g, '_');
}

/**
 * Validate an entity name before it is interpolated into a REST path. Autotask
 * entity names are simple identifiers (Tickets, TicketNotes, ConfigurationItems).
 * Rejecting anything else blocks path traversal / path confusion such as
 * "..", "../ThresholdInformation" or "Tickets/../Companies".
 */
export function assertSafeEntityName(value: string, label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a safe Autotask entity name (got: ${JSON.stringify(value)})`);
  }
  return value;
}

/** Validate a value that must be a bare numeric id before it enters a path. */
export function assertSafeNumericId(value: string, label: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a numeric id (got: ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Throw unless the agent supplied the exact confirm token for a destructive
 * tool. Centralizes the gate so it is unit-testable and consistent.
 */
export function assertConfirmToken(
  toolName: string,
  expected: string,
  given: string | undefined,
): void {
  if (given !== expected) {
    throw new Error(
      `Destructive tool "${toolName}" requires confirm: "${expected}" (got: ${
        given ? `"${given}"` : 'missing'
      })`,
    );
  }
}

export function isReadonly(): boolean {
  return (process.env.AUTOTASK_READ_ONLY || '').toLowerCase() === 'true';
}

/** Parse a JSON string argument and validate it against a zod schema. */
export function parseJsonBody<T>(raw: string, schema: z.ZodType<T>, fieldName: string): T {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${fieldName}: ${(e as Error).message}`);
  }
  const result = schema.safeParse(obj);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Validation failed for ${fieldName}: ${issues}`);
  }
  return result.data;
}

// --- Reusable schemas --------------------------------------------------------

/**
 * Autotask query object: a `filter` array plus optional record/field controls.
 * Each filter clause is { op, field, value? } and may nest sub-filters via
 * `items` for AND/OR groups. We validate the shape but stay permissive on
 * field names since they vary per entity.
 */
const filterClauseSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      op: z.string().min(1),
      field: z.string().optional(),
      value: z.unknown().optional(),
      items: z.array(filterClauseSchema).optional(),
      udf: z.boolean().optional(),
    })
    .passthrough(),
);

export const querySchema = z
  .object({
    filter: z.array(filterClauseSchema).min(1),
    MaxRecords: z.number().int().min(1).max(500).optional(),
    IncludeFields: z.array(z.string()).optional(),
  })
  .passthrough();

/** A free-form record body for create/update. Must be a non-empty object. */
export const recordBodySchema = z
  .record(z.string(), z.unknown())
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field required' });

/** Update bodies must carry the record id so Autotask knows what to patch. */
export const updateBodySchema = recordBodySchema.refine(
  (o) => o.id !== undefined && o.id !== null && o.id !== '',
  { message: 'update body must include "id"' },
);
