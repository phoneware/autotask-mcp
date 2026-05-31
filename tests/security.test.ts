import { describe, it, expect, afterEach } from 'vitest';
import {
  confirmTokenFor,
  assertConfirmToken,
  assertSafeEntityName,
  assertSafeNumericId,
  isReadonly,
  parseJsonBody,
  querySchema,
  recordBodySchema,
  updateBodySchema,
  DESTRUCTIVE_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
} from '../src/security.js';

describe('assertSafeEntityName', () => {
  it('accepts bare identifiers', () => {
    for (const ok of ['Tickets', 'TicketNotes', 'ConfigurationItems', 'A1_b']) {
      expect(assertSafeEntityName(ok, 'entity')).toBe(ok);
    }
  });
  it('rejects traversal / path injection / empty', () => {
    for (const bad of [
      '',
      '..',
      '../X',
      'Tickets/../Companies',
      'Tickets/query',
      'a b',
      '1Tickets',
      'Tickets/123/Notes',
    ]) {
      expect(() => assertSafeEntityName(bad, 'entity')).toThrow(/safe Autotask entity name/);
    }
  });
});

describe('assertSafeNumericId', () => {
  it('accepts digit strings', () => {
    expect(assertSafeNumericId('123', 'id')).toBe('123');
  });
  it('rejects non-numeric / traversal', () => {
    for (const bad of ['', '../1', '1.5', '1a', 'abc', '-1']) {
      expect(() => assertSafeNumericId(bad, 'id')).toThrow(/numeric id/);
    }
  });
});

describe('confirmTokenFor', () => {
  it('uppercases and replaces dashes', () => {
    expect(confirmTokenFor('delete-entity')).toBe('DELETE_ENTITY');
    expect(confirmTokenFor('create-ticket')).toBe('CREATE_TICKET');
  });
});

describe('assertConfirmToken', () => {
  it('passes when the token matches', () => {
    expect(() =>
      assertConfirmToken('create-ticket', 'CREATE_TICKET', 'CREATE_TICKET'),
    ).not.toThrow();
  });
  it('throws when the token is missing', () => {
    expect(() => assertConfirmToken('create-ticket', 'CREATE_TICKET', undefined)).toThrow(
      /requires confirm: "CREATE_TICKET".*missing/,
    );
  });
  it('throws when the token is wrong', () => {
    expect(() => assertConfirmToken('create-ticket', 'CREATE_TICKET', 'nope')).toThrow(
      /requires confirm: "CREATE_TICKET".*"nope"/,
    );
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
