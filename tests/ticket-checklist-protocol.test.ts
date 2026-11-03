import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import { resetApi, clearMetadataCache } from '../src/autotask-api.js';
import { governor } from '../src/governor.js';

// Synthetic test credentials — must be hoisted before imports construct singletons.
const SYNTHETIC_USER = 'protocol-tester@phoneware.us';
const SYNTHETIC_SECRET = 'synth-secret-key-1234567890';
const SYNTHETIC_INTEG_CODE = 'SYNTH-INTEG-CODE-XYZ-123';

const { savedEnv } = vi.hoisted(() => {
  const saved: Record<string, string | undefined> = {
    AUTOTASK_USERNAME: process.env.AUTOTASK_USERNAME,
    AUTOTASK_SECRET: process.env.AUTOTASK_SECRET,
    AUTOTASK_INTEGRATION_CODE: process.env.AUTOTASK_INTEGRATION_CODE,
    AUTOTASK_API_URL: process.env.AUTOTASK_API_URL,
    AUTOTASK_READ_ONLY: process.env.AUTOTASK_READ_ONLY,
    MCP_CONFIRM_DESTRUCTIVE: process.env.MCP_CONFIRM_DESTRUCTIVE,
  };
  process.env.AUTOTASK_USERNAME = 'protocol-tester@phoneware.us';
  process.env.AUTOTASK_SECRET = 'synth-secret-key-1234567890';
  process.env.AUTOTASK_INTEGRATION_CODE = 'SYNTH-INTEG-CODE-XYZ-123';
  delete process.env.AUTOTASK_READ_ONLY;
  delete process.env.MCP_CONFIRM_DESTRUCTIVE;
  return { savedEnv: saved };
});

interface FakeChecklistItem {
  id: number;
  ticketID: number;
  isCompleted: boolean | string | null;
  itemName?: string;
  position?: number | null;
  completedDateTime?: string | null;
  completedByResourceID?: number | null;
  [key: string]: unknown;
}

interface RecordedHttpRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  rawBody: string;
  body: unknown;
  timestamp: number;
}

interface ServerFaultHooks {
  onPreReadGet?: (
    ticketId: string,
    itemId: string,
    req: IncomingMessage,
  ) =>
    | { status: number; body: unknown }
    | null
    | Promise<{ status: number; body: unknown } | null>;
  onPatch?: (
    ticketId: string,
    body: unknown,
    req: IncomingMessage,
    res: ServerResponse,
  ) =>
    | {
      status?: number;
      body?: unknown;
      dropSocket?: boolean;
      mutateState?: boolean;
    }
    | null
    | Promise<{
      status?: number;
      body?: unknown;
      dropSocket?: boolean;
      mutateState?: boolean;
    } | null>;
  beforePatchResponse?: (
    ticketId: string,
    itemId: string,
    item: FakeChecklistItem,
  ) => Promise<void> | void;
  onReadbackGet?: (
    ticketId: string,
    itemId: string,
    req: IncomingMessage,
  ) =>
    | { status: number; body: unknown }
    | null
    | Promise<{ status: number; body: unknown } | null>;
}

function parseJsonBody(req: IncomingMessage): Promise<{ raw: string; json: unknown }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let json: unknown = null;
      if (raw) {
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
      }
      resolve({ raw, json });
    });
  });
}

function extractToolText(res: { content?: unknown }): string {
  if (
    res &&
    typeof res === 'object' &&
    'content' in res &&
    Array.isArray(res.content) &&
    res.content.length > 0
  ) {
    const block = res.content[0];
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}

function extractToolJson(res: { content?: unknown }): Record<string, unknown> {
  const text = extractToolText(res);
  if (!text) {
    throw new Error('Tool response content contained no text payload');
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in tool response, got: ${text}`);
  }
  return parsed as Record<string, unknown>;
}

describe('set-ticket-checklist-item MCP protocol & wire integration', () => {
  let fakeServer: Server;
  let baseUrl: string;
  const recordedRequests: RecordedHttpRequest[] = [];
  let patchCallCount = 0;
  let faultHooks: ServerFaultHooks = {};
  const fakeStore = new Map<string, FakeChecklistItem>();

  function itemKey(ticketId: number | string, itemId: number | string): string {
    return `${ticketId}:${itemId}`;
  }

  function getChecklistOperations(): RecordedHttpRequest[] {
    return recordedRequests.filter(
      (r) => r.url.includes('/ChecklistItems') && !r.url.includes('/entityInformation'),
    );
  }

  beforeAll(async () => {
    fakeServer = createServer(async (req, res) => {
      const { raw, json } = await parseJsonBody(req);
      const url = req.url || '';
      const method = (req.method || '').toUpperCase();

      recordedRequests.push({
        method,
        url,
        headers: req.headers,
        rawBody: raw,
        body: json,
        timestamp: Date.now(),
      });

      // Strict synthetic credential check on every request
      const integ = req.headers['apiintegrationcode'];
      const user = req.headers['username'];
      const sec = req.headers['secret'];
      if (
        integ !== SYNTHETIC_INTEG_CODE ||
        user !== SYNTHETIC_USER ||
        sec !== SYNTHETIC_SECRET
      ) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'Unauthorized: synthetic credentials invalid' }));
        return;
      }

      // Autotask ThresholdInformation
      if (
        method === 'GET' &&
        (url.endsWith('/V1.0/ThresholdInformation') || url.endsWith('/ThresholdInformation'))
      ) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            externalRequestThreshold: 10000,
            currentTimeframeRequestCount: 0,
          }),
        );
        return;
      }

      // Metadata: entityInformation/fields
      if (method === 'GET' && url.includes('/entityInformation/fields')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            fields: [
              { name: 'id', isReadOnly: true, isRequired: false },
              { name: 'ticketID', isReadOnly: false, isRequired: true },
              { name: 'isCompleted', isReadOnly: false, isRequired: false },
              { name: 'itemName', isReadOnly: false, isRequired: false },
              { name: 'position', isReadOnly: false, isRequired: false },
              { name: 'completedDateTime', isReadOnly: false, isRequired: false },
              { name: 'completedByResourceID', isReadOnly: false, isRequired: false },
            ],
          }),
        );
        return;
      }

      // Metadata: entityInformation/userDefinedFields
      if (method === 'GET' && url.includes('/entityInformation/userDefinedFields')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ fields: [] }));
        return;
      }

      // Single checklist item GET: /V1.0/Tickets/{ticketId}/ChecklistItems/{itemId}
      const singleItemMatch = url.match(/\/V1\.0\/Tickets\/([^/]+)\/ChecklistItems\/([^/]+)$/i);
      if (method === 'GET' && singleItemMatch) {
        const ticketId = singleItemMatch[1];
        const itemId = singleItemMatch[2];

        if (patchCallCount === 0) {
          // Pre-read GET
          if (faultHooks.onPreReadGet) {
            const override = await faultHooks.onPreReadGet(ticketId, itemId, req);
            if (override) {
              res.statusCode = override.status;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(override.body));
              return;
            }
          }
        } else {
          // Readback GET (post-write)
          if (faultHooks.onReadbackGet) {
            const override = await faultHooks.onReadbackGet(ticketId, itemId, req);
            if (override) {
              res.statusCode = override.status;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(override.body));
              return;
            }
          }
        }

        const existing = fakeStore.get(itemKey(ticketId, itemId));
        if (!existing) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              message: `Checklist item ${itemId} not found on ticket ${ticketId}`,
            }),
          );
          return;
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ item: existing }));
        return;
      }

      // Checklist item collection PATCH: /V1.0/Tickets/{ticketId}/ChecklistItems
      const patchCollectionMatch = url.match(/\/V1\.0\/Tickets\/([^/]+)\/ChecklistItems$/i);
      if (method === 'PATCH' && patchCollectionMatch) {
        const ticketId = patchCollectionMatch[1];
        patchCallCount++;

        const patchBody =
          json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
        const patchId =
          patchBody && (typeof patchBody.id === 'number' || typeof patchBody.id === 'string')
            ? String(patchBody.id)
            : undefined;
        const patchCompleted =
          patchBody && typeof patchBody.isCompleted === 'boolean'
            ? patchBody.isCompleted
            : undefined;

        if (faultHooks.onPatch) {
          const override = await faultHooks.onPatch(ticketId, json, req, res);
          if (override) {
            if (override.mutateState && patchId !== undefined && patchCompleted !== undefined) {
              const existing = fakeStore.get(itemKey(ticketId, patchId));
              if (existing) {
                existing.isCompleted = patchCompleted;
                existing.completedDateTime = patchCompleted ? '2026-11-02T16:00:00Z' : null;
                existing.completedByResourceID = patchCompleted ? 77 : null;
                fakeStore.set(itemKey(ticketId, patchId), existing);
              }
            }
            if (override.dropSocket) {
              req.socket.destroy();
              return;
            }
            if (override.status) {
              res.statusCode = override.status;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(override.body ?? { message: 'Injected Autotask error' }));
              return;
            }
          }
        }

        if (!patchBody || patchId === undefined || patchCompleted === undefined) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ message: 'Missing id or isCompleted in PATCH payload' }));
          return;
        }

        const existing = fakeStore.get(itemKey(ticketId, patchId));
        if (!existing) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              message: `Checklist item ${patchId} not found on ticket ${ticketId}`,
            }),
          );
          return;
        }

        // Apply mutation to stateful store
        existing.isCompleted = patchCompleted;
        existing.completedDateTime = patchCompleted ? '2026-11-02T16:00:00Z' : null;
        existing.completedByResourceID = patchCompleted ? 77 : null;
        fakeStore.set(itemKey(ticketId, patchId), existing);
        if (faultHooks.beforePatchResponse) {
          await faultHooks.beforePatchResponse(ticketId, patchId, existing);
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ itemId: Number(patchId) }));
        return;
      }

      // Unrecognized routes
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: `Unrecognized synthetic route: ${method} ${url}` }));
    });

    await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
    const port = (fakeServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/`;
    process.env.AUTOTASK_API_URL = baseUrl;
    resetApi();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
    resetApi();
    clearMetadataCache();
    governor.reset();

    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  beforeEach(() => {
    recordedRequests.length = 0;
    patchCallCount = 0;
    faultHooks = {};
    fakeStore.clear();
    resetApi();
    clearMetadataCache();
    governor.reset();
  });

  async function createSession() {
    const { server: mcpServer } = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'protocol-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    return {
      client,
      mcpServer,
      async close() {
        await client.close().catch(() => { });
        await mcpServer.close().catch(() => { });
      },
    };
  }

  describe('Suite 1: Protocol registration and confirmation enforcement', () => {
    it('registers set-ticket-checklist-item tool with confirmation requirement in inputSchema', async () => {
      const session = await createSession();
      try {
        const toolsList = await session.client.listTools();
        const tool = toolsList.tools.find((t) => t.name === 'set-ticket-checklist-item');
        expect(tool).toBeDefined();
        expect(tool?.description).toContain('SET_TICKET_CHECKLIST_ITEM');

        const schema = tool?.inputSchema as {
          type?: string;
          properties?: Record<string, unknown>;
          required?: string[];
        };
        expect(schema).toBeDefined();
        expect(schema.type).toBe('object');
        expect(schema.properties).toBeDefined();
        expect(typeof schema.properties).toBe('object');
        expect(schema.properties).toHaveProperty('ticketID');
        expect(schema.properties).toHaveProperty('checklistItemID');
        expect(schema.properties).toHaveProperty('completed');
        expect(schema.properties).toHaveProperty('confirm');

        expect(schema.required).toBeDefined();
        expect(Array.isArray(schema.required)).toBe(true);
        expect(schema.required).toContain('ticketID');
        expect(schema.required).toContain('checklistItemID');
        expect(schema.required).toContain('completed');
        expect(schema.required).toContain('confirm');
      } finally {
        await session.close();
      }
    });

    it('refuses execution when confirm token is omitted (zero HTTP requests issued)', async () => {
      fakeStore.set(itemKey(8001, 5001), {
        id: 5001,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Deploy LTE backup',
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5001',
            completed: 'true',
          },
        });

        expect(res.isError).toBe(true);
        expect(recordedRequests).toHaveLength(0);
        expect(fakeStore.get(itemKey(8001, 5001))?.isCompleted).toBe(false);
      } finally {
        await session.close();
      }
    });

    it('refuses execution when confirm token is invalid (zero HTTP requests issued)', async () => {
      fakeStore.set(itemKey(8001, 5001), {
        id: 5001,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Deploy LTE backup',
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5001',
            completed: 'true',
            confirm: 'INCORRECT_TOKEN',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(
          /requires confirm: "SET_TICKET_CHECKLIST_ITEM" \(got: "INCORRECT_TOKEN"\)/,
        );
        expect(recordedRequests).toHaveLength(0);
        expect(fakeStore.get(itemKey(8001, 5001))?.isCompleted).toBe(false);
      } finally {
        await session.close();
      }
    });
  });

  describe('Suite 2: Positive state transitions (GET -> PATCH -> GET)', () => {
    it('executes false -> true: pre-read GET, exactly one PATCH, and readback GET with secret masking', async () => {
      fakeStore.set(itemKey(8001, 5001), {
        id: 5001,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Configure Wi-Fi passphrase: SuperSecretKey999 on AP',
        position: 1,
        completedDateTime: null,
        completedByResourceID: null,
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5001',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBeFalsy();
        const parsed = extractToolJson(res);
        expect(parsed.ticketID).toBe(8001);
        expect(parsed.checklistItemID).toBe(5001);
        expect(parsed.isCompleted).toBe(true);
        expect(parsed.updated).toBe(true);
        expect(parsed.already_in_state).toBe(false);
        expect(parsed.itemName).toBe('Configure Wi-Fi passphrase: [REDACTED] on AP');

        // Check state in fake store
        const itemInStore = fakeStore.get(itemKey(8001, 5001));
        expect(itemInStore).toBeDefined();
        expect(itemInStore?.isCompleted).toBe(true);
        expect(itemInStore?.completedDateTime).toBe('2026-11-02T16:00:00Z');
        expect(itemInStore?.completedByResourceID).toBe(77);

        // Verify request order on checklist endpoints: GET -> PATCH -> GET
        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);

        const [preRead, patch, readback] = checklistOps;
        expect(preRead.method).toBe('GET');
        expect(preRead.url).toBe('/V1.0/Tickets/8001/ChecklistItems/5001');

        expect(patch.method).toBe('PATCH');
        expect(patch.url).toBe('/V1.0/Tickets/8001/ChecklistItems');
        expect(patch.body).toEqual({ id: 5001, isCompleted: true });

        expect(readback.method).toBe('GET');
        expect(readback.url).toBe('/V1.0/Tickets/8001/ChecklistItems/5001');

        expect(preRead.timestamp).toBeLessThanOrEqual(patch.timestamp);
        expect(patch.timestamp).toBeLessThanOrEqual(readback.timestamp);

        // All calls authenticate with synthetic credentials
        for (const op of checklistOps) {
          expect(op.headers['apiintegrationcode']).toBe(SYNTHETIC_INTEG_CODE);
          expect(op.headers['username']).toBe(SYNTHETIC_USER);
          expect(op.headers['secret']).toBe(SYNTHETIC_SECRET);
        }
      } finally {
        await session.close();
      }
    });

    it('executes true -> false: pre-read GET, exactly one PATCH, and readback GET', async () => {
      fakeStore.set(itemKey(8001, 5002), {
        id: 5002,
        ticketID: 8001,
        isCompleted: true,
        itemName: 'Verify DHCP pool reservation',
        position: 2,
        completedDateTime: '2026-11-01T12:00:00Z',
        completedByResourceID: 42,
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5002',
            completed: 'false',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBeFalsy();
        const parsed = extractToolJson(res);
        expect(parsed.isCompleted).toBe(false);
        expect(parsed.updated).toBe(true);
        expect(parsed.already_in_state).toBe(false);

        // Store updated
        const itemInStore = fakeStore.get(itemKey(8001, 5002));
        expect(itemInStore).toBeDefined();
        expect(itemInStore?.isCompleted).toBe(false);
        expect(itemInStore?.completedDateTime).toBeNull();
        expect(itemInStore?.completedByResourceID).toBeNull();

        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);
        expect(checklistOps[0].method).toBe('GET');
        expect(checklistOps[1].method).toBe('PATCH');
        expect(checklistOps[1].body).toEqual({ id: 5002, isCompleted: false });
        expect(checklistOps[2].method).toBe('GET');
      } finally {
        await session.close();
      }
    });
  });

  describe('Suite 3: Idempotent no-op transitions (ZERO PATCH)', () => {
    it('already false -> requested false: returns idempotent success without issuing PATCH', async () => {
      fakeStore.set(itemKey(8001, 5003), {
        id: 5003,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Mount rack bracket',
        position: 3,
        completedDateTime: null,
        completedByResourceID: null,
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5003',
            completed: 'false',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBeFalsy();
        const parsed = extractToolJson(res);
        expect(parsed.isCompleted).toBe(false);
        expect(parsed.already_in_state).toBe(true);
        expect(parsed.updated).toBe(false);

        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(1);
        expect(checklistOps[0].method).toBe('GET');
        expect(checklistOps[0].url).toBe('/V1.0/Tickets/8001/ChecklistItems/5003');

        // Zero PATCH requests sent
        expect(recordedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
        expect(fakeStore.get(itemKey(8001, 5003))?.isCompleted).toBe(false);
      } finally {
        await session.close();
      }
    });

    it('already true -> requested true: returns idempotent success without issuing PATCH', async () => {
      fakeStore.set(itemKey(8001, 5004), {
        id: 5004,
        ticketID: 8001,
        isCompleted: true,
        itemName: 'Label patch cables',
        position: 4,
        completedDateTime: '2026-10-30T10:00:00Z',
        completedByResourceID: 15,
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5004',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBeFalsy();
        const parsed = extractToolJson(res);
        expect(parsed.isCompleted).toBe(true);
        expect(parsed.already_in_state).toBe(true);
        expect(parsed.updated).toBe(false);

        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(1);
        expect(checklistOps[0].method).toBe('GET');

        // Zero PATCH requests sent
        expect(recordedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
        expect(fakeStore.get(itemKey(8001, 5004))?.isCompleted).toBe(true);
      } finally {
        await session.close();
      }
    });
  });

  describe('Suite 4: Pre-read validation rejections (ZERO writes / ZERO PATCH)', () => {
    it('missing/non-existent checklist item returns 404 and refuses write without PATCH', async () => {
      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '9999',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(/Checklist item 9999 not found on ticket 8001/);

        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(1);
        expect(checklistOps[0].method).toBe('GET');
        expect(recordedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
      } finally {
        await session.close();
      }
    });

    it('foreign parent ticketID in pre-read record refuses write without PATCH', async () => {
      fakeStore.set(itemKey(8001, 5005), {
        id: 5005,
        ticketID: 9999, // foreign parent!
        isCompleted: false,
        itemName: 'Provision SIM',
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5005',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(
          /Parent mismatch: checklist item 5005 belongs to ticketID 9999, not 8001; write refused/,
        );

        expect(recordedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
        expect(fakeStore.get(itemKey(8001, 5005))?.isCompleted).toBe(false);
      } finally {
        await session.close();
      }
    });

    it('mismatched item ID in pre-read record refuses write without PATCH', async () => {
      fakeStore.set(itemKey(8001, 5006), {
        id: 8888, // mismatched record ID!
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Provision SIM',
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5006',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(
          /Item mismatch: requested checklist item 5006 but record returned id 8888; write refused/,
        );

        expect(recordedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
      } finally {
        await session.close();
      }
    });

    it('non-boolean isCompleted string in pre-read record refuses write without PATCH', async () => {
      fakeStore.set(itemKey(8001, 5007), {
        id: 5007,
        ticketID: 8001,
        isCompleted: 'false', // string instead of boolean!
        itemName: 'Provision SIM',
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5007',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(/isCompleted is not a boolean \("false"\); write refused/);

        expect(recordedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
      } finally {
        await session.close();
      }
    });
  });

  describe('Suite 5: Post-read verification failures (occur AFTER exactly one completed PATCH)', () => {
    it('fails verification when post-write readback returns mismatched item ID', async () => {
      fakeStore.set(itemKey(8001, 5010), {
        id: 5010,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Deploy B One',
      });

      faultHooks.onReadbackGet = () => ({
        status: 200,
        body: {
          item: {
            id: 9999, // mismatched read-back id!
            ticketID: 8001,
            isCompleted: true,
            itemName: 'Deploy B One',
          },
        },
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5010',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(
          /Verification failed: read-back checklist item id 9999 did not match requested 5010/,
        );

        // Exactly one PATCH was executed before readback failed
        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH', 'GET']);
        expect(checklistOps[1].body).toEqual({ id: 5010, isCompleted: true });

        // Store was mutated by PATCH
        expect(fakeStore.get(itemKey(8001, 5010))?.isCompleted).toBe(true);
      } finally {
        await session.close();
      }
    });

    it('fails verification when post-write readback returns mismatched parent ticketID', async () => {
      fakeStore.set(itemKey(8001, 5011), {
        id: 5011,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Deploy B One',
      });

      faultHooks.onReadbackGet = () => ({
        status: 200,
        body: {
          item: {
            id: 5011,
            ticketID: 7777, // mismatched parent!
            isCompleted: true,
            itemName: 'Deploy B One',
          },
        },
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5011',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(
          /Verification failed: read-back checklist item 5011 belongs to ticketID 7777, not 8001/,
        );

        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH', 'GET']);
      } finally {
        await session.close();
      }
    });

    it('fails verification when post-write readback returns non-boolean isCompleted', async () => {
      fakeStore.set(itemKey(8001, 5012), {
        id: 5012,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Deploy B One',
      });

      faultHooks.onReadbackGet = () => ({
        status: 200,
        body: {
          item: {
            id: 5012,
            ticketID: 8001,
            isCompleted: 'true', // string, not boolean!
            itemName: 'Deploy B One',
          },
        },
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5012',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(
          /Verification failed: checklist item 5012 read-back isCompleted is not a boolean \("true"\)/,
        );

        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH', 'GET']);
      } finally {
        await session.close();
      }
    });

    it('fails verification when post-write readback returns unchanged boolean state', async () => {
      fakeStore.set(itemKey(8001, 5013), {
        id: 5013,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Deploy B One',
      });

      faultHooks.onReadbackGet = () => ({
        status: 200,
        body: {
          item: {
            id: 5013,
            ticketID: 8001,
            isCompleted: false, // unchanged!
            itemName: 'Deploy B One',
          },
        },
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5013',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(
          /Verification failed: checklist item 5013 isCompleted did not match requested state true \(actual: false\)/,
        );

        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH', 'GET']);
      } finally {
        await session.close();
      }
    });

    it('fails verification when post-write readback returns empty record', async () => {
      fakeStore.set(itemKey(8001, 5014), {
        id: 5014,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Deploy B One',
      });

      faultHooks.onReadbackGet = () => ({
        status: 200,
        body: { item: {} },
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5014',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(
          /Verification failed: checklist item 5014 not found on ticket 8001 after update/,
        );

        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH', 'GET']);
      } finally {
        await session.close();
      }
    });
  });

  describe('Suite 6: Partial failures, interleaving, and failure semantics', () => {
    it('handles applied PATCH with dropped 500 response: mutates upstream state, never retries PATCH, never readbacks', async () => {
      fakeStore.set(itemKey(8001, 5020), {
        id: 5020,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Activate SIM B',
      });

      // Inject server error after mutating state
      faultHooks.onPatch = () => ({
        mutateState: true,
        status: 500,
        body: { message: 'Database deadlock during transaction commit' },
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5020',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toContain('Autotask API error (500)');
        expect(text).toContain('Database deadlock');

        // Upstream state WAS mutated before the failure
        expect(fakeStore.get(itemKey(8001, 5020))?.isCompleted).toBe(true);

        // Crucial: exactly ONE PATCH was attempted. AutotaskApi does NOT retry 5xx on PATCH!
        const patchRequests = recordedRequests.filter((r) => r.method === 'PATCH');
        expect(patchRequests).toHaveLength(1);

        // Readback GET was never issued because api.update threw
        const checklistOps = getChecklistOperations();
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH']);
      } finally {
        await session.close();
      }
    });

    it('handles applied PATCH followed by socket drop: reports network error, preserves mutation, does not retry', async () => {
      fakeStore.set(itemKey(8001, 5021), {
        id: 5021,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Activate SIM C',
      });

      faultHooks.onPatch = () => ({
        mutateState: true,
        dropSocket: true,
      });

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5021',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toMatch(/fetch failed|other side closed|socket|ECONNRESET/i);

        // Store was mutated
        expect(fakeStore.get(itemKey(8001, 5021))?.isCompleted).toBe(true);

        // Exactly one PATCH sent, zero readbacks
        expect(recordedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
        const checklistOps = getChecklistOperations();
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH']);
      } finally {
        await session.close();
      }
    });

    it('detects competing write occurring between PATCH and readback verification', async () => {
      fakeStore.set(itemKey(8001, 5022), {
        id: 5022,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Configure VLAN',
      });

      // Model an independently applied competing mutation to the underlying fake store
      // occurring between PATCH and readback GET. The fake server serves the live fakeStore
      // record on readback rather than returning a mocked response.
      faultHooks.onReadbackGet = () => {
        fakeStore.set(itemKey(8001, 5022), {
          id: 5022,
          ticketID: 8001,
          isCompleted: false, // competing write reverted state!
          itemName: 'Configure VLAN',
          completedDateTime: null,
          completedByResourceID: 999,
        });
        return null; // Return null so fakeServer serves the live record from fakeStore
      };

      const session = await createSession();
      try {
        const res = await session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5022',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        expect(res.isError).toBe(true);
        const text = extractToolText(res);
        expect(text).toContain(
          'Verification failed: checklist item 5022 isCompleted did not match requested state true',
        );

        // Protocol sequence completed: GET -> PATCH -> GET
        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH', 'GET']);

        // Assert exact resulting state in the fake store matches the independent competing write
        const stored = fakeStore.get(itemKey(8001, 5022));
        expect(stored).toEqual({
          id: 5022,
          ticketID: 8001,
          isCompleted: false,
          itemName: 'Configure VLAN',
          completedDateTime: null,
          completedByResourceID: 999,
        });
      } finally {
        await session.close();
      }
    });

    it('proves strict request ordering: readback GET is never executed before PATCH completes', async () => {
      fakeStore.set(itemKey(8001, 5023), {
        id: 5023,
        ticketID: 8001,
        isCompleted: false,
        itemName: 'Verify BGP peering',
      });

      const orderLog: string[] = [];
      let patchResponseCompleted = false;
      let readbackGetCallsWhilePatchHeld = 0;

      let notifyPatchArrived: () => void = () => { };
      const patchArrivedPromise = new Promise<void>((resolve) => {
        notifyPatchArrived = resolve;
      });

      let releasePatchBarrier: () => void = () => { };
      const patchBarrierPromise = new Promise<void>((resolve) => {
        releasePatchBarrier = resolve;
      });


      // Install listeners first
      faultHooks.onPreReadGet = () => {
        orderLog.push('pre-read-get');
        return null;
      };

      faultHooks.beforePatchResponse = async (ticketId, itemId) => {
        orderLog.push('patch-mutate');
        // Stateful mutation must already be applied to fakeStore
        expect(fakeStore.get(itemKey(ticketId, itemId))?.isCompleted).toBe(true);

        // Notify test driver that PATCH has arrived and applied its mutation
        notifyPatchArrived();

        // Hold PATCH response open until test driver explicitly releases it
        await patchBarrierPromise;

        orderLog.push('patch-complete');
        patchResponseCompleted = true;
      };

      faultHooks.onReadbackGet = () => {
        if (!patchResponseCompleted) {
          readbackGetCallsWhilePatchHeld++;
        }
        orderLog.push('readback-get');
        return null;
      };

      const session = await createSession();
      try {
        const callPromise = session.client.callTool({
          name: 'set-ticket-checklist-item',
          arguments: {
            ticketID: '8001',
            checklistItemID: '5023',
            completed: 'true',
            confirm: 'SET_TICKET_CHECKLIST_ITEM',
          },
        });

        // 1. Await explicit observed PATCH arrival before checking zero readback
        await patchArrivedPromise;

        // 2. While the PATCH response is held open, verify NO readback GET has arrived
        expect(readbackGetCallsWhilePatchHeld).toBe(0);
        const inFlightOps = getChecklistOperations();
        expect(inFlightOps.map((o) => o.method)).toEqual(['GET', 'PATCH']);

        // 3. Release the barrier so PATCH response completes
        releasePatchBarrier();

        // 4. Await tool call completion
        const res = await callPromise;
        expect(res.isError).toBeFalsy();

        // 5. Assert that no readback was initiated while PATCH was held
        expect(readbackGetCallsWhilePatchHeld).toBe(0);

        // 6. Assert strict completion ordering: pre-read GET -> PATCH mutate -> PATCH complete -> readback GET
        expect(orderLog).toEqual([
          'pre-read-get',
          'patch-mutate',
          'patch-complete',
          'readback-get',
        ]);

        // Protocol sequence completed: GET -> PATCH -> GET
        const checklistOps = getChecklistOperations();
        expect(checklistOps).toHaveLength(3);
        expect(checklistOps.map((o) => o.method)).toEqual(['GET', 'PATCH', 'GET']);
      } finally {
        releasePatchBarrier();
        await session.close();
      }
    });
  });
});
