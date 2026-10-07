import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OPERATIONS,
  CHILD_COLLECTIONS,
  findOperation,
  OPERATION_REGISTRY,
} from '../src/generated/registry.js';
import { EXCLUDED_OPERATIONS, AUTH_HEADER_PARAMS } from '../scripts/generate-registry.js';
import { allTools } from '../src/tools/index.js';
import { searchApiTool, callApiTool } from '../src/tools/meta.js';
import { ticketChargeTools } from '../src/tools/ticket-charges.js';
import {
  getPromotedToolNames,
  recordCallApiInvocation,
  _resetUsageStoreForTests,
  InMemoryUsageStore,
} from '../src/tools/promotion/index.js';
import { elicitConfirmation, setActiveServer } from '../src/tools/elicitation.js';
import { getApi } from '../src/autotask-api.js';
interface SwaggerSpec {
  paths: Record<
    string,
    Record<string, { operationId?: string; parameters?: Array<{ name: string; in: string }> }>
  >;
}

const spec = JSON.parse(readFileSync('spec/autotask-swagger-v1.json', 'utf8')) as SwaggerSpec;

describe('spec-conformance: registry integrity', () => {
  beforeAll(() => {
    process.env.AUTOTASK_USERNAME = 'test@example.com';
    process.env.AUTOTASK_SECRET = 'test-secret';
    process.env.AUTOTASK_INTEGRATION_CODE = 'TEST_INT';
    process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
  });

  it('every operation in the registry matches a real path and method in Swagger spec', () => {
    for (const op of OPERATIONS) {
      const pathItem = spec.paths[op.pathTemplate];
      expect(
        pathItem,
        `Path ${op.pathTemplate} not found in spec for ${op.operationId}`,
      ).toBeDefined();
      const specOp = pathItem[op.method.toLowerCase()];
      expect(
        specOp,
        `Method ${op.method} not found on ${op.pathTemplate} for ${op.operationId}`,
      ).toBeDefined();
    }
  });

  it('no operation contains stripped auth header parameters', () => {
    for (const op of OPERATIONS) {
      for (const p of op.parameters) {
        expect(
          AUTH_HEADER_PARAMS[p.name],
          `Auth header param ${p.name} was not stripped from ${op.operationId}`,
        ).toBeUndefined();
      }
    }
  });

  it('excluded credential and infra operations never enter the registry', () => {
    for (const excludedId of Object.keys(EXCLUDED_OPERATIONS)) {
      expect(
        findOperation(excludedId),
        `Excluded operation ${excludedId} should not be in registry`,
      ).toBeUndefined();
      expect(OPERATION_REGISTRY.has(excludedId)).toBe(false);
    }
  });

  it('every child collection in CHILD_COLLECTIONS maps to a valid spec path', () => {
    for (const coll of CHILD_COLLECTIONS) {
      const collectionPath = `/V1.0/${coll.parentEntity}/{parentId}/${coll.childAlias}`;
      const pathItem = spec.paths[collectionPath];
      expect(pathItem, `Child collection path ${collectionPath} missing from spec`).toBeDefined();
    }
  });
});

describe('spec-conformance: search_api and call_api', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('search_api("ticket charge") returns child-collection operations', async () => {
    const res = await searchApiTool.handler({ query: 'ticket charge' });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.total).toBeGreaterThan(0);
    const opIds = parsed.matches.map((m: { operationId: string }) => m.operationId);
    expect(opIds).toContain('TicketChargesChild_PatchEntity');
    expect(opIds).toContain('TicketChargesChild_Query');
    expect(opIds).toContain('TicketChargesChild_CreateEntity');
  });

  it('call_api on a write operation without confirm token is refused', async () => {
    await expect(
      callApiTool.handler({
        tool_name: 'TicketChargesChild_PatchEntity',
        args: JSON.stringify({ parentId: 23836, id: 2712, status: 8 }),
      }),
    ).rejects.toThrow(/requires confirm: "TICKETCHARGESCHILD_PATCHENTITY"/);
  });

  it('call_api on a read operation does not require confirm token', async () => {
    const testApi = getApi();
    const reqSpy = vi.spyOn(testApi, 'request').mockResolvedValueOnce({ items: [] });
    const res = await callApiTool.handler({
      tool_name: 'TicketChargesChild_Query',
      args: JSON.stringify({ parentId: 23836 }),
    });
    expect(reqSpy).toHaveBeenCalledWith('GET', '/V1.0/Tickets/23836/Charges', undefined);
    expect(res.content[0].text).toContain('items');
  });
});

describe('spec-conformance: cancel-ticket-charge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('cancel-ticket-charge sets status 8 and reads record back on success', async () => {
    const cancelTool = ticketChargeTools.find((t) => t.name === 'cancel-ticket-charge')!;
    const testApi = getApi();
    vi.spyOn(testApi, 'getById').mockResolvedValueOnce({
      item: { id: 2712, ticketID: 23836, status: 8 },
    });
    const updateSpy = vi.spyOn(testApi, 'update').mockResolvedValueOnce({ itemId: 2712 });

    const res = await cancelTool.handler({ id: '2712', ticketId: '23836' });
    expect(updateSpy).toHaveBeenCalledWith('Tickets/23836/Charges', { id: 2712, status: 8 });
    const body = JSON.parse(res.content[0].text);
    expect(body.cancelled).toBe(true);
    expect(body.currentRecord.item.status).toBe(8);
  });

  it('cancel-ticket-charge surfaces refusal verbatim and reads record back on error', async () => {
    const cancelTool = ticketChargeTools.find((t) => t.name === 'cancel-ticket-charge')!;
    const testApi = getApi();
    vi.spyOn(testApi, 'update').mockRejectedValueOnce(
      new Error('Autotask API error (500): Charge is already billed'),
    );
    vi.spyOn(testApi, 'getById').mockResolvedValueOnce({
      item: { id: 2712, ticketID: 23836, status: 3 },
    });

    const res = await cancelTool.handler({ id: '2712', ticketId: '23836' });
    const body = JSON.parse(res.content[0].text);
    expect(body.cancelled).toBe(false);
    expect(body.refusal).toContain('Charge is already billed');
    expect(body.currentRecord.item.status).toBe(3);
  });
});

describe('spec-conformance: tool annotations and titles', () => {
  it('every tool carries title and complete annotations', () => {
    for (const tool of allTools) {
      expect(tool.title, `Tool ${tool.name} missing title`).toBeDefined();
      expect(tool.annotations, `Tool ${tool.name} missing annotations`).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint).toBe('boolean');
      expect(typeof tool.annotations?.idempotentHint).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint).toBe('boolean');
    }
  });
});

describe('spec-conformance: promotion and elicitation', () => {
  beforeEach(() => {
    _resetUsageStoreForTests(new InMemoryUsageStore());
    setActiveServer(null);
  });

  it('promotes tools after repeated call_api invocations crossing threshold', async () => {
    const user = 'testuser@phoneware.us';
    const toolName = 'TicketChargesChild_Query';

    expect(await getPromotedToolNames(user)).toEqual([]);

    await recordCallApiInvocation(user, toolName);
    expect(await getPromotedToolNames(user)).toEqual([]);

    await recordCallApiInvocation(user, toolName);
    expect(await getPromotedToolNames(user)).toEqual([]);

    const third = await recordCallApiInvocation(user, toolName);
    expect(third.promoted).toBe(true);
    expect(await getPromotedToolNames(user)).toEqual([toolName]);
  });

  it('elicitConfirmation fails closed when client does not support elicitation', async () => {
    await expect(
      elicitConfirmation('delete-entity', { entity: 'Tickets', id: '123' }),
    ).rejects.toThrow(/does not support confirmation prompts/);
  });
});
