import { describe, it, expect, afterEach } from 'vitest';
import {
  confirmTokenFor,
  isReadonly,
  parseJsonBody,
  querySchema,
  recordBodySchema,
  updateBodySchema,
  DESTRUCTIVE_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
} from '../src/security.js';

describe('confirmTokenFor', () => {
  it('uppercases and replaces dashes', () => {
    expect(confirmTokenFor('delete-entity')).toBe('DELETE_ENTITY');
    expect(confirmTokenFor('create-ticket')).toBe('CREATE_TICKET');
  });
});

describe('isReadonly', () => {
  const orig = process.env.AUTOTASK_READ_ONLY;
  afterEach(() => {
    process.env.AUTOTASK_READ_ONLY = orig;
  });
  it('is true only for "true" (case-insensitive)', () => {
    process.env.AUTOTASK_READ_ONLY = 'true';
    expect(isReadonly()).toBe(true);
    process.env.AUTOTASK_READ_ONLY = 'TRUE';
    expect(isReadonly()).toBe(true);
    process.env.AUTOTASK_READ_ONLY = 'false';
    expect(isReadonly()).toBe(false);
    delete process.env.AUTOTASK_READ_ONLY;
    expect(isReadonly()).toBe(false);
  });
});

describe('confirm/destructive sets', () => {
  it('every confirm-required tool is also destructive', () => {
    for (const t of CONFIRM_REQUIRED_TOOLS) {
      expect(DESTRUCTIVE_TOOLS.has(t)).toBe(true);
    }
  });
});

describe('parseJsonBody', () => {
  it('parses and validates a valid query', () => {
    const out = parseJsonBody(
      '{"filter":[{"op":"eq","field":"id","value":1}]}',
      querySchema,
      'query',
    );
    expect(out.filter).toHaveLength(1);
  });
  it('throws on invalid JSON', () => {
    expect(() => parseJsonBody('{bad', querySchema, 'query')).toThrow(/Invalid JSON in query/);
  });
  it('throws on schema violation (empty filter)', () => {
    expect(() => parseJsonBody('{"filter":[]}', querySchema, 'query')).toThrow(
      /Validation failed for query/,
    );
  });
});

describe('querySchema', () => {
  it('rejects MaxRecords above 500', () => {
    expect(
      querySchema.safeParse({ filter: [{ op: 'gte', field: 'id', value: 0 }], MaxRecords: 999 })
        .success,
    ).toBe(false);
  });
  it('allows nested AND/OR groups', () => {
    const ok = querySchema.safeParse({
      filter: [{ op: 'and', items: [{ op: 'eq', field: 'status', value: 1 }] }],
    });
    expect(ok.success).toBe(true);
  });
});

describe('recordBodySchema / updateBodySchema', () => {
  it('recordBody rejects empty object', () => {
    expect(recordBodySchema.safeParse({}).success).toBe(false);
  });
  it('updateBody requires id', () => {
    expect(updateBodySchema.safeParse({ status: 5 }).success).toBe(false);
    expect(updateBodySchema.safeParse({ id: 5, status: 5 }).success).toBe(true);
  });
});
