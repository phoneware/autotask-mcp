import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
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
  createApp,
  defaultCreateSession,
  missingConfig,
  RateLimiter,
  SessionStore,
  bearerFrom,
  clientKey,
  isHostAllowed,
  isOriginAllowed,
  tokensMatch,
  type AppOptions,
} from '../src/http.js';

const TOKEN = 'a-very-long-test-token-1234567890';

// --- pure helpers ------------------------------------------------------------

describe('http helpers', () => {
  it('bearerFrom extracts only well-formed Bearer headers', () => {
    expect(bearerFrom({ authorization: 'Bearer abc' } as never)).toBe('abc');
    expect(bearerFrom({ authorization: 'Basic abc' } as never)).toBe('');
    expect(bearerFrom({} as never)).toBe('');
  });

  it('tokensMatch is exact and length-safe', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
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
    expect(isHostAllowed('mcp.example.com', ['mcp.example.com'])).toBe(true);
    expect(isHostAllowed('mcp.example.com:443', ['mcp.example.com'])).toBe(true);
    expect(isHostAllowed('evil.example', ['mcp.example.com'])).toBe(false);
    expect(isHostAllowed(undefined, ['mcp.example.com'])).toBe(false);
  });

  it('clientKey prefers the first x-forwarded-for hop', () => {
    expect(
      clientKey({
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
        socket: { remoteAddress: '9.9.9.9' },
      } as never),
    ).toBe('1.2.3.4');
    expect(clientKey({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never)).toBe(
      '127.0.0.1',
    );
  });

  it('missingConfig flags the absence of any auth method', () => {
    expect(missingConfig({ staticToken: null, googleProvider: null })).toContain(
      'AUTOTASK_HTTP_TOKEN or Google sign-in',
    );
    expect(missingConfig({ staticToken: TOKEN, googleProvider: null })).not.toContain(
      'AUTOTASK_HTTP_TOKEN or Google sign-in',
    );
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit inside a window, then blocks', () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.check('a', 0)).toBe(true);
    expect(rl.check('a', 0)).toBe(true);
    expect(rl.check('a', 0)).toBe(true);
    expect(rl.check('a', 0)).toBe(false);
    expect(rl.check('b', 0)).toBe(true);
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

// --- a real bound app --------------------------------------------------------

function options(overrides: Partial<AppOptions> = {}): AppOptions {
  return {
    staticToken: TOKEN,
    googleProvider: null,
    sessions: new SessionStore(),
    limiter: null,
    allowedOrigins: [],
    allowedHosts: [],
    maxBodyBytes: 1024 * 1024,
    createSession: defaultCreateSession,
    ...overrides,
  };
}

async function listen(opts: AppOptions): Promise<{ base: string; server: Server }> {
  const app = createApp(opts);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('routing and auth', () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    ({ base, server } = await listen(options()));
  });
  afterAll(() => close(server));

  it('serves /health unauthenticated, with a query string, reporting auth modes', async () => {
    const resp = await fetch(`${base}/health?probe=1`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.auth).toEqual({ google: false, staticToken: true });
  });

  it('401s /mcp with no token, a wrong token, and a wrong scheme', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer nope' },
      { authorization: TOKEN },
    ] as Record<string, string>[]) {
      const resp = await fetch(`${base}/mcp`, { method: 'POST', headers });
      expect(resp.status).toBe(401);
      expect(resp.headers.get('www-authenticate')).toContain('Bearer');
    }
  });

  it('404s unknown paths', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('404s a POST carrying an unknown session id', async () => {
    const resp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'mcp-session-id': 'does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(resp.status).toBe(404);
    expect(JSON.stringify(await resp.json())).toContain('Session not found');
  });
});

describe('origin, CORS and limits', () => {
  it('rejects a disallowed Origin and a disallowed Host', async () => {
    const { base, server } = await listen(options({ allowedHosts: ['good.example'] }));
    try {
      const origin = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
      expect(origin.status).toBe(403);
      const host = await fetch(`${base}/health`, { headers: { host: 'evil.example' } });
      expect(host.status).toBe(403);
    } finally {
      await close(server);
    }
  });

  it('echoes CORS and exposes Mcp-Session-Id for an allowlisted origin', async () => {
    const { base, server } = await listen(options({ allowedOrigins: ['https://ok.example'] }));
    try {
      const resp = await fetch(`${base}/health`, { headers: { origin: 'https://ok.example' } });
      expect(resp.headers.get('access-control-allow-origin')).toBe('https://ok.example');
      expect(resp.headers.get('access-control-expose-headers')).toBe('Mcp-Session-Id');

      const preflight = await fetch(`${base}/mcp`, {
        method: 'OPTIONS',
        headers: { origin: 'https://ok.example' },
      });
      expect(preflight.status).toBe(204);
    } finally {
      await close(server);
    }
  });

  it('429s past the rate limit', async () => {
    const { base, server } = await listen(options({ limiter: new RateLimiter(1, 60_000) }));
    try {
      const first = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(first.status).not.toBe(429);
      const second = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBe('60');
    } finally {
      await close(server);
    }
  });

  it('503s a new initialize once at session capacity', async () => {
    const sessions = new SessionStore(1, 60_000);
    sessions.set({
      id: 'taken',
      lastSeen: Date.now(),
      server: {} as never,
      transport: {} as never,
    });
    const { base, server } = await listen(options({ sessions }));
    try {
      const resp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'x', version: '1' },
          },
        }),
      });
      expect(resp.status).toBe(503);
    } finally {
      await close(server);
    }
  });
});

// --- end to end over a real socket ------------------------------------------

describe('end-to-end MCP over HTTP', () => {
  let base: string;
  let server: Server;
  const sessions = new SessionStore();

  beforeAll(async () => {
    ({ base, server } = await listen(options({ sessions })));
  });

  afterAll(async () => {
    await sessions.closeAll();
    await close(server);
  });

  async function connect() {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
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

    expect(a.transport.sessionId).toBeTruthy();
    expect(b.transport.sessionId).toBeTruthy();
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);

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
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
