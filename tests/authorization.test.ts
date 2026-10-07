/**
 * The authorization layer.
 *
 * Autotask's REST API authenticates as one API user with full
 * system-administrator rights, and that user's rights apply to every call no
 * matter who asked. ImpersonationResourceId changes attribution, not
 * permission. So everything that stops a Service Desk User deleting a company
 * is in this repo, and these tests are the only thing standing behind it.
 *
 * The cases below are drawn from Phoneware's real Autotask tenant: System
 * Administrators, one Manager, one Service Desk User who is a contractor, three
 * API service accounts, and two addresses that match only deactivated records.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.AUTOTASK_USERNAME = 'apiuser@example.com';
  process.env.AUTOTASK_SECRET = 'super-secret-value';
  process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
  process.env.AUTOTASK_API_URL = 'https://webservices2.autotask.net/atservicesrest/';
});

import {
  capabilitiesForUserType,
  isServiceAccount,
  labelForUserType,
  permits,
  type Capability,
} from '../src/auth/capabilities.js';
import {
  capabilityForTool,
  assertCapability,
  DESTRUCTIVE_TOOLS,
  TOOL_CAPABILITY,
} from '../src/security.js';
import {
  resolveResourceForEmail,
  isResolved,
  resetResourceCache,
} from '../src/auth/resource-lookup.js';
import { buildServer } from '../src/server.js';
import { governor } from '../src/governor.js';

beforeEach(() => {
  resetResourceCache();
  governor.reset();
  delete process.env.AUTOTASK_READ_ONLY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Stub the Autotask Resources query with whatever rows a test needs. */
function stubResources(rows: unknown[] | { fail: true }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/Resources/query')) {
        if ('fail' in (rows as object)) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ items: rows }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('ThresholdInformation')) {
        return new Response(
          JSON.stringify({ externalRequestThreshold: 10000, currentTimeframeRequestCount: 10 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

// --- the mapping itself ------------------------------------------------------

describe('capabilitiesForUserType', () => {
  it('gives administrators everything', () => {
    for (const userType of [14, 10]) {
      expect(capabilitiesForUserType(userType)).toEqual(['read', 'create', 'update', 'delete']);
    }
  });

  it('lets managers write but not delete', () => {
    for (const userType of [15, 16]) {
      expect(capabilitiesForUserType(userType)).toEqual(['read', 'create', 'update']);
    }
  });

  it('lets service desk, team members and sales create but not update or delete', () => {
    for (const userType of [20, 18, 17]) {
      expect(capabilitiesForUserType(userType)).toEqual(['read', 'create']);
    }
  });

  it('leaves the low-privilege levels read-only', () => {
    for (const userType of [11, 12, 19, 21, 22, 23]) {
      expect(capabilitiesForUserType(userType)).toEqual(['read']);
    }
  });

  it('treats an unknown or missing security level as read-only', () => {
    // A custom or newly added Autotask level must not inherit write access
    // just because nobody has classified it yet.
    expect(capabilitiesForUserType(999)).toEqual(['read']);
    expect(capabilitiesForUserType(undefined)).toEqual(['read']);
  });

  it('never grants a write capability without read', () => {
    for (let userType = 10; userType <= 24; userType++) {
      const caps = capabilitiesForUserType(userType);
      if (caps.some((c) => c !== 'read')) expect(caps).toContain('read');
    }
  });

  it('identifies the API service-account levels', () => {
    expect(isServiceAccount(13)).toBe(true);
    expect(isServiceAccount(24)).toBe(true);
    expect(isServiceAccount(14)).toBe(false);
    expect(isServiceAccount(undefined)).toBe(false);
  });

  it('names levels for logs and messages', () => {
    expect(labelForUserType(14)).toBe('System Administrator');
    expect(labelForUserType(20)).toBe('Service Desk User');
    expect(labelForUserType(999)).toBe('userType 999');
    expect(labelForUserType(undefined)).toBe('unknown');
  });
});

// --- tools to capabilities ---------------------------------------------------

describe('capabilityForTool', () => {
  it('classifies each mutating tool by what it actually does', () => {
    expect(capabilityForTool('create-ticket')).toBe('create');
    expect(capabilityForTool('update-ticket')).toBe('update');
    expect(capabilityForTool('delete-entity')).toBe('delete');
  });

  it('treats anything unlisted as a read', () => {
    expect(capabilityForTool('search-tickets')).toBe('read');
    expect(capabilityForTool('whoami')).toBe('read');
  });

  it('keeps the destructive set derived, so the two cannot drift', () => {
    expect(DESTRUCTIVE_TOOLS.size).toBe(TOOL_CAPABILITY.size);
    for (const name of TOOL_CAPABILITY.keys()) expect(DESTRUCTIVE_TOOLS.has(name)).toBe(true);
    // Every destructive tool must need more than read, or it is misfiled.
    for (const name of DESTRUCTIVE_TOOLS) expect(capabilityForTool(name)).not.toBe('read');
  });
});

describe('assertCapability', () => {
  const readOnly: Capability[] = ['read'];

  it('allows what the capabilities cover', () => {
    expect(() => assertCapability('search-tickets', readOnly)).not.toThrow();
    expect(() => assertCapability('create-ticket', ['read', 'create'])).not.toThrow();
  });

  it('refuses what they do not, naming the person and the missing capability', () => {
    expect(() => assertCapability('delete-entity', readOnly, 'dave@phoneware.us')).toThrow(
      /"delete" capability, which dave@phoneware\.us does not have/,
    );
  });

  it('refuses everything when capabilities are absent', () => {
    expect(() => assertCapability('search-tickets', undefined)).toThrow(/requires the "read"/);
    expect(() => assertCapability('search-tickets', [])).toThrow(/requires the "read"/);
  });

  it('permits() is the single source of the comparison', () => {
    expect(permits(['read', 'create'], 'create')).toBe(true);
    expect(permits(['read', 'create'], 'update')).toBe(false);
  });
});

// --- resolving a person ------------------------------------------------------

describe('resolveResourceForEmail', () => {
  it('resolves one active resource to its id and rights', async () => {
    stubResources([{ id: 29682893, isActive: true, userType: 14, licenseType: 1 }]);
    const r = await resolveResourceForEmail('jasonw@phoneware.us');

    expect(isResolved(r)).toBe(true);
    if (!isResolved(r)) return;
    expect(r.resourceId).toBe(29682893);
    expect(r.userType).toBe(14);
    expect(r.capabilities).toEqual(['read', 'create', 'update', 'delete']);
  });

  it('gives a service desk contractor create but not delete', async () => {
    stubResources([{ id: 4242, isActive: true, userType: 20, licenseType: 3 }]);
    const r = await resolveResourceForEmail('contractor@phoneware.us');

    expect(isResolved(r) && r.capabilities).toEqual(['read', 'create']);
  });

  it('refuses an email that matches only a deactivated resource', async () => {
    // grega@ and marka@ are exactly this in the real tenant. The old code fell
    // back to items[0] and would have impersonated the departed employee.
    stubResources([{ id: 29682888, isActive: false, userType: 14 }]);
    const r = await resolveResourceForEmail('grega@phoneware.us');

    expect(isResolved(r)).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/deactivated/i);
  });

  it('never falls back to an inactive record when no active one exists', async () => {
    stubResources([
      { id: 1, isActive: false, userType: 14 },
      { id: 2, isActive: false, userType: 14 },
    ]);
    expect(isResolved(await resolveResourceForEmail('gone@phoneware.us'))).toBe(false);
  });

  it('picks the active record when an inactive one shares the address', async () => {
    stubResources([
      { id: 1, isActive: false, userType: 14 },
      { id: 2, isActive: true, userType: 15 },
    ]);
    const r = await resolveResourceForEmail('rehired@phoneware.us');

    expect(isResolved(r) && r.resourceId).toBe(2);
    expect(isResolved(r) && r.capabilities).toEqual(['read', 'create', 'update']);
  });

  it('refuses when no resource matches at all', async () => {
    stubResources([]);
    const r = await resolveResourceForEmail('stranger@phoneware.us');

    expect(isResolved(r)).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/No active Autotask resource/i);
  });

  it('refuses an ambiguous email rather than guessing who to act as', async () => {
    stubResources([
      { id: 1, isActive: true, userType: 14 },
      { id: 2, isActive: true, userType: 20 },
    ]);
    const r = await resolveResourceForEmail('shared@phoneware.us');

    expect(isResolved(r)).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/more than one active/i);
  });

  it('refuses a service account, so a person cannot borrow an integration identity', async () => {
    for (const userType of [13, 24]) {
      resetResourceCache();
      stubResources([{ id: 9, isActive: true, userType }]);
      const r = await resolveResourceForEmail('integration@phoneware.us');

      expect(isResolved(r)).toBe(false);
      expect((r as { reason: string }).reason).toMatch(/API\/service account/i);
    }
  });

  it('refuses, and does not cache, when Autotask cannot be reached', async () => {
    // Failing open here would hand out rights precisely when we cannot check
    // them. Failing closed and not caching means the next attempt retries.
    stubResources({ fail: true });
    expect(isResolved(await resolveResourceForEmail('dave@phoneware.us'))).toBe(false);

    stubResources([{ id: 5, isActive: true, userType: 14 }]);
    expect(isResolved(await resolveResourceForEmail('dave@phoneware.us'))).toBe(true);
  });

  it('caches a genuine answer instead of re-querying per call', async () => {
    stubResources([{ id: 5, isActive: true, userType: 14 }]);
    await resolveResourceForEmail('dave@phoneware.us');
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await resolveResourceForEmail('dave@phoneware.us');

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });
});

// --- the tools a person actually gets ---------------------------------------

describe('buildServer capability filtering', () => {
  // Registration, not just refusal: a tool a person may not use is never built,
  // so the model is not offered a capability it would only be denied.
  const FULL = 47;
  const MUTATING = 14;

  it('builds everything when no capabilities are given (stdio)', () => {
    expect(buildServer().registeredCount).toBe(FULL);
  });

  it('builds everything for an administrator', () => {
    const b = buildServer(['read', 'create', 'update', 'delete']);
    expect(b.registeredCount).toBe(FULL);
    expect(b.skipped).toBe(0);
  });

  it('withholds every mutating tool from a read-only person', () => {
    const b = buildServer(['read']);
    expect(b.registeredCount).toBe(FULL - MUTATING);
    expect(b.skipped).toBe(MUTATING);
  });

  it('gives a create-only person the creates but no updates or deletes', () => {
    const creates = [...TOOL_CAPABILITY.values()].filter((c) => c === 'create').length;
    const b = buildServer(['read', 'create']);
    expect(b.registeredCount).toBe(FULL - MUTATING + creates);
    expect(b.skipped).toBe(MUTATING - creates);
  });

  it('withholds only delete from a manager', () => {
    const deletes = [...TOOL_CAPABILITY.values()].filter((c) => c === 'delete').length;
    const b = buildServer(['read', 'create', 'update']);
    expect(b.skipped).toBe(deletes);
  });

  it('builds nothing at all for a caller with no capabilities', () => {
    expect(buildServer([]).registeredCount).toBe(0);
  });

  it('read-only mode still wins over an administrator capability set', () => {
    // The env switch is an operator decision and must not be overridable by
    // whoever happens to sign in.
    process.env.AUTOTASK_READ_ONLY = 'true';
    const b = buildServer(['read', 'create', 'update', 'delete']);
    expect(b.registeredCount).toBe(FULL - MUTATING);
  });
});
