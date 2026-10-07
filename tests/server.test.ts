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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
    // Skipped count must equal the destructive set: this fails the moment a
    // new create-/update-/delete- tool is added without being marked destructive.
    expect(ro.skipped).toBe(DESTRUCTIVE_TOOLS.size);
    expect(full.registeredCount - ro.registeredCount).toBe(DESTRUCTIVE_TOOLS.size);
    expect(ro.registeredCount).toBe(full.registeredCount - DESTRUCTIVE_TOOLS.size);
  });

  it('locks the documented counts: full=47, readonly=33, skipped=14', () => {
    delete process.env.AUTOTASK_READ_ONLY;
    expect(buildServer().registeredCount).toBe(47);
    process.env.AUTOTASK_READ_ONLY = 'true';
    const ro = buildServer();
    expect(ro.registeredCount).toBe(33);
    expect(ro.skipped).toBe(14);
  });

  it('rejects an unknown argument instead of silently searching for everything', async () => {
    delete process.env.AUTOTASK_READ_ONLY;
    const { server } = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // The dropped-argument bug was silent: the handler saw no filters and
    // Autotask returned an arbitrary first page. Strict makes it an error
    // result that names the key, so the agent can fix its own call.
    const res = await client.callTool({
      name: 'search-companies',
      arguments: { searchTerm: 'Zucker' },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(
      /Unrecognized key\(s\).*searchTerm/,
    );

    const listed = await client.listTools();
    const schema = listed.tools.find((t) => t.name === 'search-companies')!.inputSchema;
    expect(schema.additionalProperties).toBe(false);

    await client.close();
  });
});
