import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Set credentials before the module's singleton constructs at import time.
vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import { AutotaskApi, redactSecrets } from '../src/autotask-api.js';

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('redactSecrets', () => {
  it('redacts secret/password/token values', () => {
    const out = redactSecrets('{"Secret":"abc123","password":"hunter2","token":"xyz"}');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('xyz');
    expect(out).toContain('[REDACTED]');
  });
  it('truncates very long text', () => {
    const out = redactSecrets('x'.repeat(1000));
    expect(out.length).toBeLessThan(600);
    expect(out).toContain('truncated');
  });
});

describe('AutotaskApi', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects the zone when AUTOTASK_API_URL is not pinned', async () => {
    const saved = process.env.AUTOTASK_API_URL;
    delete process.env.AUTOTASK_API_URL;
    fetchMock
      .mockResolvedValueOnce(jsonResp({ url: 'https://webservices5.autotask.net/atservicesrest/' }))
      .mockResolvedValueOnce(jsonResp({ version: '1.0' }));
    const api = new AutotaskApi();
    await api.version();
    expect(fetchMock.mock.calls[0][0]).toContain('zoneInformation?user=apiuser%40example.com');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://webservices5.autotask.net/atservicesrest/V1.0/Version',
    );
    process.env.AUTOTASK_API_URL = saved;
  });

  it('uses pinned base URL and sends the three auth headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ items: [], pageDetails: {} }));
    const api = new AutotaskApi();
    await api.query('Tickets', { filter: [{ op: 'gte', field: 'id', value: 0 }] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://webservices2.autotask.net/atservicesrest/V1.0/Tickets/query');
    expect(opts.method).toBe('POST');
    expect(opts.headers.ApiIntegrationCode).toBe('INTCODE123');
    expect(opts.headers.UserName).toBe('apiuser@example.com');
    expect(opts.headers.Secret).toBe('super-secret-value');
  });

  it('builds get-by-id path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ item: { id: 5 } }));
    const api = new AutotaskApi();
    await api.getById('Companies', '5');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://webservices2.autotask.net/atservicesrest/V1.0/Companies/5',
    );
  });

  it('retries on 429 honoring Retry-After then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(jsonResp({ ok: true }));
    const api = new AutotaskApi();
    const out = await api.thresholdInformation();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ ok: true });
  });

  it('does not retry POST on 500 and throws redacted error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"Secret":"leak"}', { status: 500 }));
    const api = new AutotaskApi();
    await expect(api.create('Tickets', { title: 'x' })).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats 204 as success', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new AutotaskApi();
    expect(await api.deleteById('Tickets', '9')).toEqual({ success: true });
  });

  it('keeps slashes in child-collection paths (per-segment encoding)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ itemId: 1 }));
    const api = new AutotaskApi();
    await api.create('Tickets/123/Notes', { description: 'x' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://webservices2.autotask.net/atservicesrest/V1.0/Tickets/123/Notes',
    );
  });

  it('builds query/count and Version paths', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ queryCount: 7 }))
      .mockResolvedValueOnce(jsonResp({ version: '1.0' }));
    const api = new AutotaskApi();
    await api.queryCount('Tickets', { filter: [{ op: 'gte', field: 'id', value: 0 }] });
    await api.version();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://webservices2.autotask.net/atservicesrest/V1.0/Tickets/query/count',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://webservices2.autotask.net/atservicesrest/V1.0/Version',
    );
  });
});
