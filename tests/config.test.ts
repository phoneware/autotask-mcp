import { describe, it, expect, afterEach } from 'vitest';

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

afterEach(() => {
  for (const k of CREDS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  resetApi();
});

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

  it('is configured once all three are present', () => {
    process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
    process.env.AUTOTASK_SECRET = 's';
    process.env.AUTOTASK_INTEGRATION_CODE = 'c';
    expect(missingCredentials()).toEqual([]);
    expect(isConfigured()).toBe(true);
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

describe('/health with no credentials', () => {
  it('answers 200 and names what is missing', async () => {
    for (const k of CREDS) delete process.env[k];
    const { createRouter, SessionStore } = await import('../src/http.js');

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

    await createRouter({
      token: 'a-very-long-test-token-1234567890',
      sessions: new SessionStore(),
      limiter: null,
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 1024,
      createSession: () => {
        throw new Error('not used');
      },
    })(
      { url: '/health', headers: {}, method: 'GET' } as never,
      res as unknown as Parameters<ReturnType<typeof createRouter>>[1],
    );

    // 200, not a failed probe: a crash-looping revision hides the reason.
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(false);
    expect(body.missingConfig).toEqual([...CREDS]);
  });
});
