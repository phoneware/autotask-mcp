import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseMaxRecords,
  ensureFilter,
  eqClause,
  containsClause,
  collectClauses,
} from '../src/tools/shared.js';

// Mock the API module so tool handlers run without real credentials/network.
const query = vi.fn();
const create = vi.fn();
const queryCount = vi.fn();
vi.mock('../src/autotask-api.js', () => ({
  api: {
    query,
    create,
    queryCount,
    getById: vi.fn(),
    update: vi.fn(),
    deleteById: vi.fn(),
    entityFields: vi.fn(),
    version: vi.fn(),
    thresholdInformation: vi.fn(),
  },
}));

describe('shared helpers', () => {
  it('parseMaxRecords clamps and falls back', () => {
    expect(parseMaxRecords(undefined)).toBe(50);
    expect(parseMaxRecords('10')).toBe(10);
    expect(parseMaxRecords('99999')).toBe(500);
    expect(parseMaxRecords('-5')).toBe(50);
    expect(parseMaxRecords('abc')).toBe(50);
  });

  it('ensureFilter adds the fetch-all clause when empty', () => {
    expect(ensureFilter([])).toEqual([{ op: 'gte', field: 'id', value: 0 }]);
    const given = [{ op: 'eq', field: 'id', value: 1 }];
    expect(ensureFilter(given)).toBe(given);
  });

  it('eqClause / containsClause skip empty values', () => {
    expect(eqClause('status', undefined)).toBeNull();
    expect(eqClause('status', '')).toBeNull();
    expect(eqClause('status', '1')).toEqual({ op: 'eq', field: 'status', value: '1' });
    expect(containsClause('title', 'foo')).toEqual({
      op: 'contains',
      field: 'title',
      value: 'foo',
    });
  });

  it('collectClauses drops nulls and falls back to fetch-all', () => {
    expect(collectClauses(null, null)).toEqual([{ op: 'gte', field: 'id', value: 0 }]);
    expect(collectClauses(eqClause('a', '1'), null)).toEqual([
      { op: 'eq', field: 'a', value: '1' },
    ]);
  });
});

describe('ticket tools', () => {
  beforeEach(() => {
    query.mockReset();
    create.mockReset();
  });

  it('search-tickets builds an ANDed filter from provided args', async () => {
    const { ticketTools } = await import('../src/tools/tickets.js');
    const search = ticketTools.find((t) => t.name === 'search-tickets')!;
    query.mockResolvedValueOnce({ items: [] });

    await search.handler({ companyID: '7', titleContains: 'vpn', maxRecords: '5' });

    expect(query).toHaveBeenCalledWith('Tickets', {
      filter: [
        { op: 'eq', field: 'companyID', value: '7' },
        { op: 'contains', field: 'title', value: 'vpn' },
      ],
      MaxRecords: 5,
    });
  });

  it('create-ticket coerces numeric fields', async () => {
    const { ticketTools } = await import('../src/tools/tickets.js');
    const createTicket = ticketTools.find((t) => t.name === 'create-ticket')!;
    create.mockResolvedValueOnce({ itemId: 1 });

    await createTicket.handler({ title: 'Help', companyID: '42', status: '1' });

    expect(create).toHaveBeenCalledWith('Tickets', { title: 'Help', companyID: 42, status: 1 });
  });
});

describe('generic tools', () => {
  beforeEach(() => {
    query.mockReset();
    create.mockReset();
    queryCount.mockReset();
  });

  it('query-entity scopes to a parent child-collection path', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const queryEntity = genericTools.find((t) => t.name === 'query-entity')!;
    query.mockResolvedValueOnce({ items: [] });

    await queryEntity.handler({
      entity: 'Notes',
      query: '{"filter":[{"op":"gte","field":"id","value":0}]}',
      parentEntity: 'Tickets',
      parentId: '123',
    });

    expect(query).toHaveBeenCalledWith('Tickets/123/Notes', {
      filter: [{ op: 'gte', field: 'id', value: 0 }],
    });
  });

  it('rejects a half-specified parent scope', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const getEntity = genericTools.find((t) => t.name === 'get-entity')!;
    await expect(
      getEntity.handler({ entity: 'Notes', id: '1', parentEntity: 'Tickets' }),
    ).rejects.toThrow(/parentEntity and parentId must be provided together/);
  });

  it('count-entity calls queryCount', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const count = genericTools.find((t) => t.name === 'count-entity')!;
    queryCount.mockResolvedValueOnce({ queryCount: 3 });

    await count.handler({
      entity: 'Tickets',
      query: '{"filter":[{"op":"gte","field":"id","value":0}]}',
    });

    expect(queryCount).toHaveBeenCalledWith('Tickets', {
      filter: [{ op: 'gte', field: 'id', value: 0 }],
    });
  });
});
