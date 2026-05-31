import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';

// Credentials must exist before autotask-api's singleton constructs at import.
vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
});

import { AutotaskApi } from '../src/autotask-api.js';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/**
 * A real (loopback) mock Autotask REST server. Lets us exercise the full HTTP
 * path — headers, URL construction, status handling, redaction — against an
 * actual socket rather than a fetch stub.
 */
let server: Server;
let baseUrl: string;
const recorded: Recorded[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: '{}' };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      recorded.push({
        method: req.method || '',
        url: req.url || '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      res.statusCode = nextResponse.status;
      res.setHeader('content-type', 'application/json');
      res.end(nextResponse.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/`;
  process.env.AUTOTASK_API_URL = baseUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('integration: real mock Autotask server', () => {
  it('query-entity hits /V1.0/{Entity}/query with the three auth headers and JSON body', async () => {
    recorded.length = 0;
    nextResponse = { status: 200, body: JSON.stringify({ items: [{ id: 1 }], pageDetails: {} }) };
    const api = new AutotaskApi();

    const result = (await api.query('Tickets', {
      filter: [{ op: 'eq', field: 'id', value: 1 }],
    })) as { items: unknown[] };

    expect(result.items).toHaveLength(1);
    const rec = recorded[0];
    expect(rec.method).toBe('POST');
    expect(rec.url).toBe('/V1.0/Tickets/query');
    expect(rec.headers['apiintegrationcode']).toBe('INTCODE123');
    expect(rec.headers['username']).toBe('apiuser@example.com');
    expect(rec.headers['secret']).toBe('super-secret-value');
    expect(JSON.parse(rec.body)).toEqual({ filter: [{ op: 'eq', field: 'id', value: 1 }] });
  });

  it('create returns the parsed JSON response', async () => {
    recorded.length = 0;
    nextResponse = { status: 200, body: JSON.stringify({ itemId: 42 }) };
    const api = new AutotaskApi();
    const out = (await api.create('Tickets', { title: 'x' })) as { itemId: number };
    expect(out.itemId).toBe(42);
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].url).toBe('/V1.0/Tickets');
  });

  it('redacts secrets in error bodies (500)', async () => {
    nextResponse = { status: 500, body: '{"Secret":"leaked-value","message":"boom"}' };
    const api = new AutotaskApi();
    let err: Error | undefined;
    try {
      await api.create('Tickets', { title: 'x' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/500/);
    expect(err!.message).not.toContain('leaked-value');
    expect(err!.message).toContain('[REDACTED]');
  });
});
