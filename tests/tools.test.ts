import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseMaxRecords,
  ensureFilter,
  eqClause,
  containsClause,
  anyContainsClause,
  collectClauses,
  isUnfiltered,
  intArg,
  numberArg,
  optionalIntArg,
} from '../src/tools/shared.js';
import { CONFIRM_REQUIRED_TOOLS, DESTRUCTIVE_TOOLS } from '../src/security.js';

// Mock the API module so tool handlers run without real credentials/network.
const query = vi.fn();
const create = vi.fn();
const queryCount = vi.fn();
const getPage = vi.fn();
const getById = vi.fn();
const update = vi.fn();
const deleteById = vi.fn();
vi.mock('../src/autotask-api.js', () => ({
  api: {
    query,
    create,
    queryCount,
    getPage,
    getById,
    update,
    deleteById,
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

  it('intArg rejects non-integers and missing values', () => {
    expect(intArg('companyID', '42')).toBe(42);
    expect(() => intArg('companyID', 'abc')).toThrow(/companyID must be an integer/);
    expect(() => intArg('companyID', '1.5')).toThrow(/must be an integer/);
    expect(() => intArg('companyID', undefined)).toThrow(/companyID is required/);
  });

  it('numberArg accepts decimals, rejects junk', () => {
    expect(numberArg('hoursWorked', '1.5')).toBe(1.5);
    expect(() => numberArg('hoursWorked', 'abc')).toThrow(/must be a number/);
  });

  it('optionalIntArg returns undefined when absent', () => {
    expect(optionalIntArg('x', undefined)).toBeUndefined();
    expect(optionalIntArg('x', '')).toBeUndefined();
    expect(optionalIntArg('x', '7')).toBe(7);
    expect(() => optionalIntArg('x', 'no')).toThrow(/must be an integer/);
  });

  it('anyContainsClause ORs a term across fields', () => {
    expect(anyContainsClause(['a', 'b'], 'x')).toEqual({
      op: 'or',
      items: [
        { op: 'contains', field: 'a', value: 'x' },
        { op: 'contains', field: 'b', value: 'x' },
      ],
    });
    expect(anyContainsClause(['a'], undefined)).toBeNull();
    expect(anyContainsClause(['a'], '')).toBeNull();
  });

  it('isUnfiltered only recognises the fetch-all fallback itself', () => {
    expect(isUnfiltered(collectClauses(null, null))).toBe(true);
    expect(isUnfiltered(collectClauses(eqClause('a', '1')))).toBe(false);
    // A caller-supplied lookalike is a real filter, so shape alone is not enough.
    expect(isUnfiltered([{ op: 'gte', field: 'id', value: 0 }])).toBe(false);
  });
});

describe('security: every mutating tool is confirm-gated', () => {
  it('all create-/update-/delete- tools require confirm and are destructive', async () => {
    const { allTools } = await import('../src/tools/index.js');
    const mutating = allTools.filter((t) => /^(create|update|delete)-/.test(t.name));
    // Sanity: we actually have mutating tools to check.
    expect(mutating.length).toBeGreaterThan(0);
    for (const t of mutating) {
      expect(DESTRUCTIVE_TOOLS.has(t.name), `${t.name} must be in DESTRUCTIVE_TOOLS`).toBe(true);
      expect(
        CONFIRM_REQUIRED_TOOLS.has(t.name),
        `${t.name} must be in CONFIRM_REQUIRED_TOOLS`,
      ).toBe(true);
    }
  });

  it('no read tool is accidentally marked destructive', async () => {
    const { allTools } = await import('../src/tools/index.js');
    for (const t of allTools) {
      if (DESTRUCTIVE_TOOLS.has(t.name)) {
        expect(/^(create|update|delete)-/.test(t.name), `${t.name} flagged destructive`).toBe(true);
      }
    }
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

  // Regression: "open + unassigned" must use notExist + a closed-status denylist,
  // NOT a per-status allowlist. The original bug missed status 13 because the
  // model enumerated "open" statuses and forgot one. With openOnly the filter
  // never enumerates open statuses, so a status-13 unassigned ticket is included.
  it('search-tickets openOnly+unassigned builds notExist + closed-status denylist', async () => {
    const { ticketTools } = await import('../src/tools/tickets.js');
    const search = ticketTools.find((t) => t.name === 'search-tickets')!;
    query.mockResolvedValueOnce({ items: [] });

    await search.handler({ unassigned: 'true', openOnly: 'true', maxRecords: '500' });

    expect(query).toHaveBeenCalledWith('Tickets', {
      filter: [
        { op: 'notExist', field: 'assignedResourceID' },
        { op: 'noteq', field: 'status', value: 5 },
        { op: 'noteq', field: 'status', value: 16 },
      ],
      MaxRecords: 500,
    });

    // No eq-status clause => status 13 (and any other open status) is not excluded.
    const sentFilter = query.mock.calls[0][1].filter as Array<{ op: string; field: string }>;
    expect(sentFilter.some((c) => c.op === 'eq' && c.field === 'status')).toBe(false);
  });

  it('search-tickets honors custom closedStatusIds', async () => {
    const { ticketTools } = await import('../src/tools/tickets.js');
    const search = ticketTools.find((t) => t.name === 'search-tickets')!;
    query.mockResolvedValueOnce({ items: [] });

    await search.handler({ openOnly: 'true', closedStatusIds: '5, 16, 99' });

    expect(query.mock.calls[0][1].filter).toEqual([
      { op: 'noteq', field: 'status', value: 5 },
      { op: 'noteq', field: 'status', value: 16 },
      { op: 'noteq', field: 'status', value: 99 },
    ]);
  });

  it('search-tickets without flags does not inject assignment/status filters', async () => {
    const { ticketTools } = await import('../src/tools/tickets.js');
    const search = ticketTools.find((t) => t.name === 'search-tickets')!;
    query.mockResolvedValueOnce({ items: [] });

    await search.handler({ companyID: '7' });

    expect(query.mock.calls[0][1].filter).toEqual([{ op: 'eq', field: 'companyID', value: '7' }]);
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

describe('generic tools: path-traversal hardening', () => {
  const VALID_QUERY = '{"filter":[{"op":"gte","field":"id","value":0}]}';

  beforeEach(() => {
    query.mockReset();
    queryCount.mockReset();
    create.mockReset();
  });

  it('rejects traversal / unsafe entity names', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const q = genericTools.find((t) => t.name === 'query-entity')!;
    for (const bad of [
      '..',
      '../ThresholdInformation',
      'Tickets/../Companies',
      'Tickets/query',
      '',
    ]) {
      await expect(q.handler({ entity: bad, query: VALID_QUERY })).rejects.toThrow(
        /safe Autotask entity name/,
      );
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unsafe parentEntity and non-numeric parentId', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const q = genericTools.find((t) => t.name === 'query-entity')!;
    await expect(
      q.handler({ entity: 'Notes', query: VALID_QUERY, parentEntity: '..', parentId: '1' }),
    ).rejects.toThrow(/parentEntity must be a safe/);
    await expect(
      q.handler({
        entity: 'Notes',
        query: VALID_QUERY,
        parentEntity: 'Tickets',
        parentId: '../123',
      }),
    ).rejects.toThrow(/parentId must be a numeric id/);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects non-numeric id on get-entity / delete-entity', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const get = genericTools.find((t) => t.name === 'get-entity')!;
    await expect(get.handler({ entity: 'Tickets', id: '../1' })).rejects.toThrow(
      /id must be a numeric id/,
    );
  });

  it('still allows valid entities and parent-scoped child collections', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const q = genericTools.find((t) => t.name === 'query-entity')!;
    query.mockResolvedValue({ items: [] });
    for (const ok of ['Tickets', 'Companies', 'TicketNotes', 'ConfigurationItems']) {
      await q.handler({ entity: ok, query: VALID_QUERY });
    }
    await q.handler({
      entity: 'Notes',
      query: VALID_QUERY,
      parentEntity: 'Tickets',
      parentId: '123',
    });
    expect(query).toHaveBeenLastCalledWith('Tickets/123/Notes', {
      filter: [{ op: 'gte', field: 'id', value: 0 }],
    });
  });
});

describe('contact tools', () => {
  beforeEach(() => {
    query.mockReset();
    create.mockReset();
    update.mockReset();
    getById.mockReset();
  });

  it('search-contacts ORs a name term across first, last and email', async () => {
    const { contactTools } = await import('../src/tools/contacts.js');
    const search = contactTools.find((t) => t.name === 'search-contacts')!;
    query.mockResolvedValueOnce({ items: [] });

    await search.handler({ nameContains: 'Zucker' });

    expect(query).toHaveBeenCalledWith('Contacts', {
      filter: [
        {
          op: 'or',
          items: [
            { op: 'contains', field: 'firstName', value: 'Zucker' },
            { op: 'contains', field: 'lastName', value: 'Zucker' },
            { op: 'contains', field: 'emailAddress', value: 'Zucker' },
          ],
        },
      ],
      MaxRecords: 50,
    });
  });

  it('labels an unfiltered search so it cannot pass for a real result', async () => {
    const { contactTools } = await import('../src/tools/contacts.js');
    const search = contactTools.find((t) => t.name === 'search-contacts')!;

    query.mockResolvedValueOnce({ items: [] });
    const bare = await search.handler({});
    expect(JSON.parse(bare.content[0].text).unfiltered).toBe(true);

    query.mockResolvedValueOnce({ items: [] });
    const scoped = await search.handler({ companyID: '7' });
    expect(JSON.parse(scoped.content[0].text).unfiltered).toBe(false);
  });

  it('create-contact routes to Companies/{companyID}/Contacts and passes title', async () => {
    const { contactTools } = await import('../src/tools/contacts.js');
    const createContact = contactTools.find((t) => t.name === 'create-contact')!;
    create.mockResolvedValueOnce({ itemId: 123 });

    const res = await createContact.handler({
      companyID: '1482',
      firstName: 'Chris',
      lastName: 'Galeotti',
      title: 'Sales Director',
      emailAddress: 'cgaleotti@crexendo.com',
      phone: '(858) 764-5215',
    });

    expect(create).toHaveBeenCalledWith('Companies/1482/Contacts', {
      companyID: 1482,
      firstName: 'Chris',
      lastName: 'Galeotti',
      title: 'Sales Director',
      emailAddress: 'cgaleotti@crexendo.com',
      phone: '(858) 764-5215',
    });
    expect(JSON.parse(res.content[0].text)).toEqual({ itemId: 123 });
  });

  it('update-contact routes to Companies/{companyID}/Contacts when companyID is provided', async () => {
    const { contactTools } = await import('../src/tools/contacts.js');
    const updateContact = contactTools.find((t) => t.name === 'update-contact')!;
    update.mockResolvedValueOnce({ itemId: 456 });

    await updateContact.handler({
      id: '456',
      companyID: '1482',
      title: 'VP of Sales',
    });

    expect(update).toHaveBeenCalledWith('Companies/1482/Contacts', {
      id: 456,
      title: 'VP of Sales',
    });
    expect(getById).not.toHaveBeenCalled();
  });

  it('update-contact looks up companyID when omitted from args', async () => {
    const { contactTools } = await import('../src/tools/contacts.js');
    const updateContact = contactTools.find((t) => t.name === 'update-contact')!;
    getById.mockResolvedValueOnce({ item: { id: 456, companyID: 1482 } });
    update.mockResolvedValueOnce({ itemId: 456 });

    await updateContact.handler({
      id: '456',
      title: 'VP of Sales',
    });

    expect(getById).toHaveBeenCalledWith('Contacts', '456');
    expect(update).toHaveBeenCalledWith('Companies/1482/Contacts', {
      id: 456,
      title: 'VP of Sales',
    });
  });
});

describe('generic tools: Contacts auto-routing', () => {
  beforeEach(() => {
    create.mockReset();
    update.mockReset();
    deleteById.mockReset();
    getById.mockReset();
  });

  it('create-entity auto-routes Contacts to Companies/{companyID}/Contacts when companyID in fields', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const createEntity = genericTools.find((t) => t.name === 'create-entity')!;
    create.mockResolvedValueOnce({ itemId: 789 });

    await createEntity.handler({
      entity: 'Contacts',
      fields: JSON.stringify({ companyID: 1482, firstName: 'Jon', lastName: 'Almond' }),
    });

    expect(create).toHaveBeenCalledWith('Companies/1482/Contacts', {
      companyID: 1482,
      firstName: 'Jon',
      lastName: 'Almond',
    });
  });

  it('create-entity throws clear error when Contacts lacks companyID and parent props', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const createEntity = genericTools.find((t) => t.name === 'create-entity')!;

    await expect(
      createEntity.handler({
        entity: 'Contacts',
        fields: JSON.stringify({ firstName: 'Jon', lastName: 'Almond' }),
      }),
    ).rejects.toThrow(/Contacts in Autotask must be created under a company/);
    expect(create).not.toHaveBeenCalled();
  });

  it('update-entity auto-routes Contacts using companyID from fields or getById lookup', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const updateEntity = genericTools.find((t) => t.name === 'update-entity')!;
    update.mockResolvedValueOnce({ itemId: 123 });

    // with companyID in fields:
    await updateEntity.handler({
      entity: 'Contacts',
      fields: JSON.stringify({ id: 123, companyID: 1482, title: 'Engineer' }),
    });
    expect(update).toHaveBeenCalledWith('Companies/1482/Contacts', {
      id: 123,
      companyID: 1482,
      title: 'Engineer',
    });
    expect(getById).not.toHaveBeenCalled();

    // without companyID in fields:
    getById.mockResolvedValueOnce({ item: { id: 123, companyID: 1482 } });
    update.mockResolvedValueOnce({ itemId: 123 });
    await updateEntity.handler({
      entity: 'Contacts',
      fields: JSON.stringify({ id: 123, title: 'Lead Engineer' }),
    });
    expect(getById).toHaveBeenCalledWith('Contacts', '123');
    expect(update).toHaveBeenCalledWith('Companies/1482/Contacts', {
      id: 123,
      title: 'Lead Engineer',
    });
  });

  it('delete-entity auto-routes Contacts to Companies/{companyID}/Contacts/{id}', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const deleteEntity = genericTools.find((t) => t.name === 'delete-entity')!;
    getById.mockResolvedValueOnce({ item: { id: 123, companyID: 1482 } });
    deleteById.mockResolvedValueOnce({ success: true });

    await deleteEntity.handler({
      entity: 'Contacts',
      id: '123',
    });

    expect(getById).toHaveBeenCalledWith('Contacts', '123');
    expect(deleteById).toHaveBeenCalledWith('Companies/1482/Contacts', '123');
  });
});

describe('generic tools: spec-driven child collection auto-routing', () => {
  beforeEach(() => {
    create.mockReset();
    update.mockReset();
    deleteById.mockReset();
    getById.mockReset();
  });

  it('create-entity auto-routes TicketCharges to Tickets/{ticketID}/Charges with ticketID in fields', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const createEntity = genericTools.find((t) => t.name === 'create-entity')!;
    create.mockResolvedValueOnce({ itemId: 2712 });

    await createEntity.handler({
      entity: 'TicketCharges',
      fields: JSON.stringify({ ticketID: 23836, name: 'Labor', chargeType: 1 }),
    });

    expect(create).toHaveBeenCalledWith('Tickets/23836/Charges', {
      ticketID: 23836,
      name: 'Labor',
      chargeType: 1,
    });
  });

  it('create-entity throws clear error when TicketCharges lacks ticketID and parent props', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const createEntity = genericTools.find((t) => t.name === 'create-entity')!;

    await expect(
      createEntity.handler({
        entity: 'TicketCharges',
        fields: JSON.stringify({ name: 'Labor', chargeType: 1 }),
      }),
    ).rejects.toThrow(/TicketCharges in Autotask must be created under a ticket/);
    expect(create).not.toHaveBeenCalled();
  });

  it('update-entity auto-routes TicketCharges using ticketID from lookup', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const updateEntity = genericTools.find((t) => t.name === 'update-entity')!;
    getById.mockResolvedValueOnce({ item: { id: 2712, ticketID: 23836 } });
    update.mockResolvedValueOnce({ itemId: 2712 });

    await updateEntity.handler({
      entity: 'TicketCharges',
      fields: JSON.stringify({ id: 2712, status: 8 }),
    });

    expect(getById).toHaveBeenCalledWith('TicketCharges', '2712');
    expect(update).toHaveBeenCalledWith('Tickets/23836/Charges', {
      id: 2712,
      status: 8,
    });
  });

  it('update-entity with explicit parentEntity and parentId routes directly', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const updateEntity = genericTools.find((t) => t.name === 'update-entity')!;
    update.mockResolvedValueOnce({ itemId: 2712 });

    await updateEntity.handler({
      entity: 'TicketCharges',
      parentEntity: 'Tickets',
      parentId: '23836',
      fields: JSON.stringify({ id: 2712, status: 8 }),
    });

    expect(getById).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('Tickets/23836/Charges', {
      id: 2712,
      status: 8,
    });
  });

  it('delete-entity auto-routes TicketCharges to Tickets/{ticketID}/Charges/{id}', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const deleteEntity = genericTools.find((t) => t.name === 'delete-entity')!;
    getById.mockResolvedValueOnce({ item: { id: 2712, ticketID: 23836 } });
    deleteById.mockResolvedValueOnce({ success: true });

    await deleteEntity.handler({
      entity: 'TicketCharges',
      id: '2712',
    });

    expect(getById).toHaveBeenCalledWith('TicketCharges', '2712');
    expect(deleteById).toHaveBeenCalledWith('Tickets/23836/Charges', '2712');
  });

  it('returns an error naming valid routes when no route exists for the method', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const deleteEntity = genericTools.find((t) => t.name === 'delete-entity')!;

    await expect(
      deleteEntity.handler({
        entity: 'BillingCodes',
        id: '123',
      }),
    ).rejects.toThrow(/No DELETE route exists for entity "BillingCodes"/);
  });
});

describe('generic tools: pagination', () => {
  it('get-next-page passes the url verbatim and the parsed query model', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const next = genericTools.find((t) => t.name === 'get-next-page')!;
    getPage.mockResolvedValueOnce({ items: [] });

    const url =
      'https://webservices2.autotask.net/atservicesrest/V1.0/Companies/query/next?paging=x';
    const query = '{"filter":[{"op":"eq","field":"id","value":1}],"MaxRecords":1}';
    await next.handler({ nextPageUrl: url, query });

    expect(getPage).toHaveBeenCalledWith(url, JSON.parse(query));
  });

  it('get-next-page rejects a query that is not valid JSON', async () => {
    const { genericTools } = await import('../src/tools/generic.js');
    const next = genericTools.find((t) => t.name === 'get-next-page')!;
    getPage.mockReset();

    await expect(next.handler({ nextPageUrl: 'https://x/', query: 'not json' })).rejects.toThrow();
    expect(getPage).not.toHaveBeenCalled();
  });
});
