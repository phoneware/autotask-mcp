import { describe, it, expect, vi, afterEach } from 'vitest';

// buildServer imports the tool layer, whose api singleton needs credentials.
vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import { buildServer } from '../src/server.js';
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
