import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// buildServer imports the tool layer, whose api singleton needs credentials.
vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import { buildServer, handleHttpRequest, tokensMatch } from '../src/server.js';
import { DESTRUCTIVE_TOOLS } from '../src/security.js';

describe('buildServer registration (readonly lock test)', () => {
  const orig = process.env.AUTOTASK_READ_ONLY;
  afterEach(() => {
    process.env.AUTOTASK_READ_ONLY = orig;
  });

  it('full mode registers every tool, skips none', () => {
    delete process.env.AUTOTASK_READ_ONLY;
    const { registeredCount, skipped } = buildServer();
    expect(skipped).toBe(0);
    expect(registeredCount).toBeGreaterThan(0);
  });

  it('readonly mode skips exactly the destructive tools', () => {
    process.env.AUTOTASK_READ_ONLY = 'true';
    const ro = buildServer();
    delete process.env.AUTOTASK_READ_ONLY;
    const full = buildServer();

    // Skipped count must equal the destructive set — this fails the moment a
    // new create-/update-/delete- tool is added without being marked destructive.
    expect(ro.skipped).toBe(DESTRUCTIVE_TOOLS.size);
    expect(full.registeredCount - ro.registeredCount).toBe(DESTRUCTIVE_TOOLS.size);
    expect(ro.registeredCount).toBe(full.registeredCount - DESTRUCTIVE_TOOLS.size);
  });

  it('locks the documented counts: full=29, readonly=18, skipped=11', () => {
    delete process.env.AUTOTASK_READ_ONLY;
    expect(buildServer().registeredCount).toBe(29);
    process.env.AUTOTASK_READ_ONLY = 'true';
    const ro = buildServer();
    expect(ro.registeredCount).toBe(18);
    expect(ro.skipped).toBe(11);
  });
});

// Minimal req/res doubles for the HTTP router.
function mockReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}
function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    ended: false,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk?: string) {
      if (chunk) this.body = chunk;
      this.ended = true;
    },
  };
  return res as typeof res & ServerResponse;
}

describe('handleHttpRequest', () => {
  const TOKEN = 'a-very-long-test-token-1234567890';

  it('serves /health with no auth', () => {
    const res = mockRes();
    const transport = { handleRequest: vi.fn() };
    handleHttpRequest(mockReq('/health'), res, TOKEN, transport);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(transport.handleRequest).not.toHaveBeenCalled();
  });

  it('rejects /mcp without a token (401)', () => {
    const res = mockRes();
    const transport = { handleRequest: vi.fn() };
    handleHttpRequest(mockReq('/mcp'), res, TOKEN, transport);
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(transport.handleRequest).not.toHaveBeenCalled();
  });

  it('rejects /mcp with a wrong token (401)', () => {
    const res = mockRes();
    const transport = { handleRequest: vi.fn() };
    handleHttpRequest(mockReq('/mcp', { authorization: 'Bearer wrong' }), res, TOKEN, transport);
    expect(res.statusCode).toBe(401);
    expect(transport.handleRequest).not.toHaveBeenCalled();
  });

  it('delegates /mcp to the transport with a valid token', () => {
    const res = mockRes();
    const transport = { handleRequest: vi.fn() };
    handleHttpRequest(mockReq('/mcp', { authorization: `Bearer ${TOKEN}` }), res, TOKEN, transport);
    expect(transport.handleRequest).toHaveBeenCalledOnce();
  });

  it('404s unknown paths', () => {
    const res = mockRes();
    handleHttpRequest(mockReq('/nope'), res, TOKEN, { handleRequest: vi.fn() });
    expect(res.statusCode).toBe(404);
  });
});

describe('tokensMatch', () => {
  it('matches equal tokens, rejects different/length-mismatched', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
  });
});
