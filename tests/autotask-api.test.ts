import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Set credentials before the module's singleton constructs at import time.
vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import { AutotaskApi, redactSecrets } from '../src/autotask-api.js';
import { governor } from '../src/governor.js';
import { withCaller } from '../src/auth/context.js';

/**
 * Every API call now passes the budget governor, which probes
 * ThresholdInformation when its reading is stale. These tests assert on exact
 * fetch call sequences, so prime the governor with a healthy reading first:
 * the guard stays fully active, it just already knows the budget and does not
 * spend a call re-checking it.
 */
async function primeGovernor(): Promise<void> {
  governor.reset();
  await governor.assertBudget(async () => ({
    externalRequestThreshold: 10_000,
    currentTimeframeRequestCount: 0,
  }));
}

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
  it('redacts the exact current secret value even in free text', () => {
    // AUTOTASK_SECRET is set to "super-secret-value" by the hoisted env above.
    const out = redactSecrets('Auth failed: invalid secret super-secret-value at edge');
    expect(out).not.toContain('super-secret-value');
    expect(out).toContain('[REDACTED]');
  });
});

describe('AutotaskApi', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await primeGovernor();
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

  // The live API taught both halves of this: a GET returns 405, and a bodyless
  // POST returns 500 "Parameter name: queryModel". Asserting the method and the
  // body is the only thing standing between us and shipping either again.
  it('getPage POSTs the original query model to a nextPageUrl under the zone base', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ items: [{ id: 2 }] }));
    const api = new AutotaskApi();
    const url =
      'https://webservices2.autotask.net/atservicesrest/V1.0/Companies/query/next?paging=%7B%22pageSize%22%3A1%7D';
    const model = {
      filter: [{ op: 'contains', field: 'companyName', value: 'Zucker' }],
      MaxRecords: 1,
    };
    await api.getPage(url, model);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [called, opts] = fetchMock.mock.calls[0];
    expect(called).toBe(url);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(model);
    expect(opts.headers.ApiIntegrationCode).toBe('INTCODE123');
    expect(opts.headers.UserName).toBe('apiuser@example.com');
    expect(opts.headers.Secret).toBe('super-secret-value');
  });

  it('getPage refuses a url outside the zone base', async () => {
    const api = new AutotaskApi();
    await expect(api.getPage('https://evil.example.com/V1.0/Companies/query', {})).rejects.toThrow(
      /must start with/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A paging cursor is a read wearing POST. Impersonating it makes Autotask
  // judge the impersonated resource's rights on a query, which it refuses with
  // "does not have the adequate permissions to query this entity type".
  it('getPage does not impersonate: a paging cursor is a read, not a create', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ items: [{ id: 2 }] }));
    const api = new AutotaskApi();
    const url =
      'https://webservices2.autotask.net/atservicesrest/V1.0/Companies/query/next?paging=%7B%22pageSize%22%3A1%7D';
    await withCaller(
      { email: 'jason@example.com', resourceId: 29682893, capabilities: ['read'] },
      () => api.getPage(url, { filter: [{ op: 'gte', field: 'id', value: 0 }], MaxRecords: 1 }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.ImpersonationResourceId).toBeUndefined();
  });

  describe('impersonation fallback', () => {
    const caller = {
      email: 'jason@example.com',
      resourceId: 29682893,
      capabilities: ['read', 'create', 'update', 'delete'] as const,
    };

    it('retries a refused impersonated create without the attribution header', async () => {
      // Autotask refuses to attribute the create, then accepts it unattributed.
      fetchMock
        .mockResolvedValueOnce(
          jsonResp(
            {
              errors: [
                'The logged in Resource does not have the adequate permissions to create this entity type.',
              ],
            },
            500,
          ),
        )
        .mockResolvedValueOnce(jsonResp({ itemId: 12345 }));

      const api = new AutotaskApi();
      const out = await withCaller({ ...caller, capabilities: [...caller.capabilities] }, () =>
        api.create('Tickets', { title: 'Porting 4 tns', companyID: 1016 }),
      );

      expect(out).toEqual({ itemId: 12345 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // first attempt carries the byline, the retry does not
      expect(fetchMock.mock.calls[0][1].headers.ImpersonationResourceId).toBe('29682893');
      expect(fetchMock.mock.calls[1][1].headers.ImpersonationResourceId).toBeUndefined();
      // the record itself is unchanged between attempts
      expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    });

    it('does not retry a create that failed for any other reason', async () => {
      fetchMock.mockResolvedValueOnce(jsonResp({ errors: ['Ticket: Queue ID is required.'] }, 500));

      const api = new AutotaskApi();
      await expect(
        withCaller({ ...caller, capabilities: [...caller.capabilities] }, () =>
          api.create('Tickets', { title: 'x', companyID: 1016 }),
        ),
      ).rejects.toThrow(/Queue ID is required/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not loop when the unattributed retry is refused too', async () => {
      const refusal = () =>
        jsonResp(
          { errors: ['The logged in Resource does not have the adequate permissions to create.'] },
          500,
        );
      fetchMock.mockResolvedValueOnce(refusal()).mockResolvedValueOnce(refusal());

      const api = new AutotaskApi();
      await expect(
        withCaller({ ...caller, capabilities: [...caller.capabilities] }, () =>
          api.create('Tickets', { title: 'x', companyID: 1016 }),
        ),
      ).rejects.toThrow(/adequate permissions/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('leaves an unattributed create alone: nothing to fall back to', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResp(
          { errors: ['The logged in Resource does not have the adequate permissions to create.'] },
          500,
        ),
      );

      const api = new AutotaskApi();
      await expect(api.create('Tickets', { title: 'x', companyID: 1016 })).rejects.toThrow(
        /adequate permissions/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
