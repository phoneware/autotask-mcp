import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

// The tool layer's api singleton needs credentials at import time.
vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createRouter,
  defaultCreateSession,
  RateLimiter,
  SessionStore,
  bearerFrom,
  clientKey,
  isHostAllowed,
  isOriginAllowed,
  parsePath,
  readJsonBody,
  tokensMatch,
  type RouterDeps,
} from '../src/http.js';

const TOKEN = 'a-very-long-test-token-1234567890';

// --- pure helpers ------------------------------------------------------------

describe('http helpers', () => {
  it('parsePath strips the query string', () => {
    expect(parsePath('/health')).toBe('/health');
    expect(parsePath('/health?probe=1')).toBe('/health');
    expect(parsePath('/mcp?x=1&y=2')).toBe('/mcp');
    expect(parsePath(undefined)).toBe('');
  });

  it('bearerFrom extracts only well-formed Bearer headers', () => {
    expect(bearerFrom({ authorization: 'Bearer abc' })).toBe('abc');
    expect(bearerFrom({ authorization: 'Basic abc' })).toBe('');
    expect(bearerFrom({})).toBe('');
  });

  it('tokensMatch is exact and length-safe', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('', '')).toBe(true);
  });

  it('isOriginAllowed denies every browser origin when no allowlist is set', () => {
    // Our real clients send no Origin at all; an unset allowlist must not become
    // an open door for browser-driven DNS rebinding.
    expect(isOriginAllowed(undefined, [])).toBe(true);
    expect(isOriginAllowed('https://evil.example', [])).toBe(false);
    expect(isOriginAllowed('https://ok.example', ['https://ok.example'])).toBe(true);
    expect(isOriginAllowed('https://evil.example', ['https://ok.example'])).toBe(false);
  });

  it('isHostAllowed enforces only when configured, and ignores the port', () => {
    expect(isHostAllowed('anything', [])).toBe(true);
    expect(isHostAllowed('mcp.autotask.phoneware.cloud', ['mcp.autotask.phoneware.cloud'])).toBe(
      true,
    );
    expect(
      isHostAllowed('mcp.autotask.phoneware.cloud:443', ['mcp.autotask.phoneware.cloud']),
    ).toBe(true);
    expect(isHostAllowed('evil.example', ['mcp.autotask.phoneware.cloud'])).toBe(false);
    expect(isHostAllowed(undefined, ['mcp.autotask.phoneware.cloud'])).toBe(false);
  });

  it('clientKey prefers the first x-forwarded-for hop', () => {
    expect(clientKey(mockReq('/', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientKey(mockReq('/'))).toBe('127.0.0.1');
  });
});

describe('readJsonBody', () => {
  it('parses JSON and returns undefined for an empty body', async () => {
    await expect(readJsonBody(streamReq('{"a":1}'), 1024)).resolves.toEqual({ a: 1 });
    await expect(readJsonBody(streamReq(''), 1024)).resolves.toBeUndefined();
  });

  it('rejects malformed JSON with a 400 and oversized bodies with a 413', async () => {
    await expect(readJsonBody(streamReq('{nope'), 1024)).rejects.toMatchObject({ statusCode: 400 });
    await expect(readJsonBody(streamReq('x'.repeat(50)), 10)).rejects.toMatchObject({
      statusCode: 413,
    });
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit inside a window, then blocks', () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.check('a', 0)).toBe(true);
    expect(rl.check('a', 0)).toBe(true);
    expect(rl.check('a', 0)).toBe(true);
    expect(rl.check('a', 0)).toBe(false);
    // A different client has its own bucket.
    expect(rl.check('b', 0)).toBe(true);
    // The window rolls over.
    expect(rl.check('a', 1001)).toBe(true);
  });
});

describe('SessionStore', () => {
  it('reaps only sessions idle past the TTL', async () => {
    const store = new SessionStore(10, 1000);
    const closed: string[] = [];
    const fake = (id: string, lastSeen: number) =>
      ({
        id,
        lastSeen,
        server: {} as never,
        transport: {
          close: async () => {
            closed.push(id);
          },
        } as never,
      }) as never;

    store.set(fake('fresh', 900));
    store.set(fake('stale', 0));
    expect(store.size).toBe(2);

    const reaped = await store.reap(1500);
    expect(reaped).toBe(1);
    expect(closed).toEqual(['stale']);
    expect(store.get('fresh', 1500)).toBeDefined();
    expect(store.get('stale')).toBeUndefined();
  });

  it('reports full at capacity, and get() refreshes lastSeen', () => {
    const store = new SessionStore(1, 1000);
    expect(store.full).toBe(false);
    const session = { id: 'a', lastSeen: 0, server: {} as never, transport: {} as never };
    store.set(session as never);
    expect(store.full).toBe(true);
    store.get('a', 500);
    expect(session.lastSeen).toBe(500);
  });
});

// --- router ------------------------------------------------------------------

function mockReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    url,
    headers,
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function streamReq(
  body: string,
  headers: Record<string, string> = {},
  method = 'POST',
): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  req.url = '/mcp';
  req.method = method;
  req.headers = headers;
  (req as { socket?: unknown }).socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    headersSent: false,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk?: string) {
      if (chunk) this.body = chunk;
      this.headersSent = true;
    },
  };
  return res as typeof res & ServerResponse;
}

function deps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    token: TOKEN,
    sessions: new SessionStore(),
    limiter: null,
    allowedOrigins: [],
    allowedHosts: [],
    maxBodyBytes: 1024 * 1024,
    createSession: () => {
      throw new Error('not used');
    },
    ...overrides,
  };
}

describe('router', () => {
  it('serves /health unauthenticated, including with a query string', async () => {
    const res = mockRes();
    await createRouter(deps())(mockReq('/health?probe=1'), res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('sessions', 0);
    expect(body).toHaveProperty('mode');
  });

  it('401s /mcp with no token, a wrong token, and a wrong scheme', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: TOKEN }]) {
      const res = mockRes();
      await createRouter(deps())(mockReq('/mcp', headers), res);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Bearer');
    }
  });

  it('404s unknown paths', async () => {
    const res = mockRes();
    await createRouter(deps())(mockReq('/nope'), res);
    expect(res.statusCode).toBe(404);
  });

  it('405s an unsupported method on /mcp', async () => {
    const res = mockRes();
    const req = mockReq('/mcp', { authorization: `Bearer ${TOKEN}` });
    (req as { method: string }).method = 'PUT';
    await createRouter(deps())(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toContain('POST');
  });

  it('rejects a disallowed Origin and a disallowed Host before auth', async () => {
    const originRes = mockRes();
    await createRouter(deps())(mockReq('/health', { origin: 'https://evil.example' }), originRes);
    expect(originRes.statusCode).toBe(403);

    const hostRes = mockRes();
    await createRouter(deps({ allowedHosts: ['good.example'] }))(
      mockReq('/health', { host: 'evil.example' }),
      hostRes,
    );
    expect(hostRes.statusCode).toBe(403);
  });

  it('echoes CORS headers and exposes Mcp-Session-Id for an allowlisted origin', async () => {
    const res = mockRes();
    await createRouter(deps({ allowedOrigins: ['https://ok.example'] }))(
      mockReq('/health', { origin: 'https://ok.example' }),
      res,
    );
    expect(res.headers['access-control-allow-origin']).toBe('https://ok.example');
    expect(res.headers['access-control-expose-headers']).toBe('Mcp-Session-Id');
  });

  it('answers preflight with 204', async () => {
    const res = mockRes();
    const req = mockReq('/mcp', { origin: 'https://ok.example' });
    (req as { method: string }).method = 'OPTIONS';
    await createRouter(deps({ allowedOrigins: ['https://ok.example'] }))(req, res);
    expect(res.statusCode).toBe(204);
  });

  it('429s past the rate limit, and does so without touching the session store', async () => {
    const router = createRouter(deps({ limiter: new RateLimiter(1, 60_000) }));
    const first = mockRes();
    await router(mockReq('/mcp', { authorization: `Bearer ${TOKEN}` }), first);
    expect(first.statusCode).not.toBe(429);

    const second = mockRes();
    await router(mockReq('/mcp', { authorization: `Bearer ${TOKEN}` }), second);
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('60');
  });

  it('404s a POST that carries an unknown session id', async () => {
    const res = mockRes();
    const req = streamReq(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }), {
      authorization: `Bearer ${TOKEN}`,
      'mcp-session-id': 'does-not-exist',
    });
    await createRouter(deps())(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Session not found');
  });

  it('503s a new initialize once at session capacity', async () => {
    const sessions = new SessionStore(1, 60_000);
    sessions.set({
      id: 'taken',
      lastSeen: Date.now(),
      server: {} as never,
      transport: {} as never,
    });
    const res = mockRes();
    const req = streamReq(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        },
      }),
      { authorization: `Bearer ${TOKEN}` },
    );
    await createRouter(deps({ sessions }))(req, res);
    expect(res.statusCode).toBe(503);
  });
});

// --- end to end over a real socket ------------------------------------------

describe('end-to-end MCP over HTTP', () => {
  let server: Server;
  let url: string;
  const sessions = new SessionStore();

  beforeAll(async () => {
    const router = createRouter(
      deps({ sessions, createSession: defaultCreateSession, allowedOrigins: [] }),
    );
    server = createServer((req, res) => {
      void router(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await sessions.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function connect() {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    return { client, transport };
  }

  it('completes a real initialize + tools/list handshake', async () => {
    const { client, transport } = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain('search-tickets');
    await transport.terminateSession();
    await client.close();
  });

  it('serves two concurrent clients with independent sessions', async () => {
    // The regression test for the single-shared-transport bug: before the
    // session store, the second client's initialize returned 400 "Server
    // already initialized" and only the first client could ever connect.
    const a = await connect();
    const b = await connect();

    const idA = a.transport.sessionId;
    const idB = b.transport.sessionId;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);

    // Both remain independently usable.
    const [toolsA, toolsB] = await Promise.all([a.client.listTools(), b.client.listTools()]);
    expect(toolsA.tools.length).toBe(toolsB.tools.length);

    // Terminating one leaves the other working.
    await a.transport.terminateSession();
    await a.client.close();
    await expect(b.client.listTools()).resolves.toBeDefined();

    await b.transport.terminateSession();
    await b.client.close();
  });

  it('rejects an unauthenticated client', async () => {
    const client = new Client({ name: 'anon', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
