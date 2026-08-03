import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// Deliberately NO credentials in the environment before importing the modules
// under test. This file is the regression guard for the Cloud Run crash-loop:
// importing the server with missing credentials used to throw during module
// load, so the container exited before it could bind a port and /health could
// never explain why.

const CREDS = ['AUTOTASK_USERNAME', 'AUTOTASK_SECRET', 'AUTOTASK_INTEGRATION_CODE'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of CREDS) {
  saved[k] = process.env[k];
  delete process.env[k];
}

const { missingCredentials, isConfigured, getApi, resetApi } =
  await import('../src/autotask-api.js');
const { createApp, SessionStore, defaultCreateSession, configuredToken } =
  await import('../src/http.js');

afterEach(() => {
  for (const k of CREDS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  resetApi();
});

async function listen(overrides: Record<string, unknown> = {}) {
  const app = createApp({
    staticToken: null,
    googleProvider: null,
    sessions: new SessionStore(),
    limiter: null,
    allowedOrigins: [],
    allowedHosts: [],
    maxBodyBytes: 1024,
    createSession: defaultCreateSession,
    ...overrides,
  } as never);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('credential configuration', () => {
  it('imports cleanly with no credentials set', () => {
    // Reaching this line at all is the assertion: a throwing module-level
    // singleton would have failed the import above.
    expect(typeof missingCredentials).toBe('function');
  });

  it('reports every missing credential by name', () => {
    for (const k of CREDS) delete process.env[k];
    expect(missingCredentials()).toEqual([...CREDS]);
    expect(isConfigured()).toBe(false);
  });

  it('reports only the credentials that are actually absent', () => {
    for (const k of CREDS) delete process.env[k];
    process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
    expect(missingCredentials()).toEqual(['AUTOTASK_SECRET', 'AUTOTASK_INTEGRATION_CODE']);
  });

  it('defers the credential error to first use, not import', () => {
    for (const k of CREDS) delete process.env[k];
    resetApi();
    expect(() => getApi()).toThrow(/AUTOTASK_USERNAME/);
  });

  it('builds the client once credentials appear, without a reimport', () => {
    for (const k of CREDS) delete process.env[k];
    resetApi();
    expect(() => getApi()).toThrow();

    process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
    process.env.AUTOTASK_SECRET = 's';
    process.env.AUTOTASK_INTEGRATION_CODE = 'c';
    resetApi();
    expect(getApi()).toBeDefined();
  });
});

describe('static token configuration', () => {
  it('treats a missing or too-short token as absent', () => {
    const savedToken = process.env.AUTOTASK_HTTP_TOKEN;

    delete process.env.AUTOTASK_HTTP_TOKEN;
    expect(configuredToken()).toBeNull();

    process.env.AUTOTASK_HTTP_TOKEN = 'too-short';
    expect(configuredToken()).toBeNull();

    process.env.AUTOTASK_HTTP_TOKEN = 'a-long-enough-token-1234567890';
    expect(configuredToken()).toBe('a-long-enough-token-1234567890');

    if (savedToken === undefined) delete process.env.AUTOTASK_HTTP_TOKEN;
    else process.env.AUTOTASK_HTTP_TOKEN = savedToken;
  });
});

describe('a completely unconfigured server', () => {
  it('answers /health with 200 and names everything missing', async () => {
    for (const k of CREDS) delete process.env[k];
    const { base, close } = await listen();
    try {
      const resp = await fetch(`${base}/health`);
      // 200, not a failed probe: a crash-looping revision hides the reason.
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(true);
      expect(body.configured).toBe(false);
      expect(body.missingConfig).toEqual([...CREDS, 'AUTOTASK_HTTP_TOKEN or Google sign-in']);
      expect(body.auth).toEqual({ google: false, staticToken: false });
    } finally {
      await close();
    }
  });

  it('refuses /mcp with 503 rather than running open', async () => {
    const { base, close } = await listen();
    try {
      const resp = await fetch(`${base}/mcp`, { method: 'POST' });
      expect(resp.status).toBe(503);
      expect(JSON.stringify(await resp.json())).toContain('not configured');
    } finally {
      await close();
    }
  });

  it('refuses /mcp with 503 even when a caller presents a bearer', async () => {
    // The unconfigured branch must run BEFORE any comparison, so a caller
    // cannot get in by guessing an empty secret.
    const { base, close } = await listen();
    try {
      const resp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' },
      });
      expect(resp.status).toBe(503);
    } finally {
      await close();
    }
  });
});
