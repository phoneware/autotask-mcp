// Copied from @phoneware/mcp-oauth-kit 1.0.0 (phoneware/monorepo packages/mcp-oauth-kit/test-support/permanence-contract.ts at 998685a9dd5843a89e6eb1f3659223e7f9e31fc5). Edit the canonical file, then re-copy.
import { expect } from 'vitest';

export interface ServerInstance {
  url: string;
  close: () => Promise<void>;
}

export interface SignInResult {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  expiresIn?: number;
}

export interface PermanenceHarness<TBacking> {
  name: string;
  newBacking: () => Promise<TBacking>;
  createInstance: (backing: TBacking, opts?: { instanceId?: string }) => Promise<ServerInstance>;
  signIn: (instanceUrl: string, opts?: { email?: string; scopes?: string[] }) => Promise<SignInResult>;
  setNow?: (now: number) => void;
  getNow?: () => number;
  setStoreOutage?: (backing: TBacking, active: boolean) => Promise<void>;
  setUpstreamState?: (
    backing: TBacking,
    state: 'healthy' | 'transient' | 'definitive',
  ) => Promise<void>;
  setAllowlist?: (backing: TBacking, allowedEmails: string[]) => Promise<void>;
  simulateToolUpstream401?: (
    instanceUrl: string,
    token: string,
  ) => Promise<{ status: number; body?: unknown }>;
  supportsUpstream?: boolean;
  supportsAllowlist?: boolean;
  supportsRegistration?: boolean;
  supportsAdoption?: boolean;
  resourceMetadataUrl?: string;
  getMcpHeaders?: (
    baseUrl: string,
    token?: string,
  ) => Promise<Record<string, string>> | Record<string, string>;
}

async function postToken(
  baseUrl: string,
  params: Record<string, string>,
): Promise<{ status: number; headers: Headers; data: Record<string, unknown> }> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  let data: Record<string, unknown> = {};
  const text = await res.text();
  if (text.trim().startsWith('{')) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  return { status: res.status, headers: res.headers, data };
}

async function callMcp(
  baseUrl: string,
  token?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: Headers; data: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  let data: unknown;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data };
}

/**
 * Runs the normative C10 OAuth permanence contract test suite against a harness.
 */
export async function runPermanenceContract<TBacking>(
  harness: PermanenceHarness<TBacking>,
): Promise<void> {
  const backing = await harness.newBacking();
  const instance1 = await harness.createInstance(backing, { instanceId: 'inst-1' });
  try {
    const sendMcp = async (url: string, token?: string) => {
      const extra = harness.getMcpHeaders ? await harness.getMcpHeaders(url, token) : undefined;
      return callMcp(url, token, extra);
    };

    // Step a: Sign in through /authorize, callback/form, and /token -> /mcp 2xx
    const initial = await harness.signIn(instance1.url, { email: 'user@example.com' });
    expect(initial.accessToken, 'initial accessToken must be present').toBeTruthy();
    expect(initial.refreshToken, 'initial refreshToken must be present').toBeTruthy();

    const mcpA = await sendMcp(instance1.url, initial.accessToken);
    expect(mcpA.status, 'step a: /mcp with initial token').toBe(200);

    // Step b: Clock moves past access TTL (server own TTL + 5 seconds)
    const baseNow = harness.getNow ? harness.getNow() : Date.now();
    const ttlMs = Math.max(3605, (initial.expiresIn ?? 0) + 5) * 1000;
    let currentNow = baseNow + ttlMs;
    if (harness.setNow) {
      harness.setNow(currentNow);
    }
    // Step c: Call /mcp with expired access token -> 401 with WWW-Authenticate
    const mcpC = await sendMcp(instance1.url, initial.accessToken);
    expect(mcpC.status, 'step c: /mcp with expired token must return 401').toBe(401);
    const wwwAuth = mcpC.headers.get('www-authenticate') ?? '';
    expect(wwwAuth, 'step c: WWW-Authenticate must be present').toContain('Bearer');
    expect(wwwAuth, 'step c: WWW-Authenticate must contain invalid_token').toContain('invalid_token');
    if (harness.resourceMetadataUrl) {
      expect(
        wwwAuth,
        'step c: WWW-Authenticate must contain resource_metadata',
      ).toContain(`resource_metadata="${harness.resourceMetadataUrl}"`);
    }

    // Step d: Refresh -> 200 with new pair; new token works; old token gets 401
    const tokenD = await postToken(instance1.url, {
      grant_type: 'refresh_token',
      refresh_token: initial.refreshToken,
      client_id: initial.clientId,
    });
    expect(tokenD.status, 'step d: refresh must return 200').toBe(200);
    const newAccessD = String(tokenD.data.access_token);
    const newRefreshD = String(tokenD.data.refresh_token);
    expect(newAccessD, 'step d: must issue new access token').toBeTruthy();
    expect(newRefreshD, 'step d: must issue new refresh token').toBeTruthy();
    expect(newAccessD).not.toBe(initial.accessToken);
    expect(newRefreshD).not.toBe(initial.refreshToken);

    const mcpDNew = await sendMcp(instance1.url, newAccessD);
    expect(mcpDNew.status, 'step d: new access token must return 200').toBe(200);

    const mcpDOld = await sendMcp(instance1.url, initial.accessToken);
    expect(mcpDOld.status, 'step d: old access token must return 401').toBe(401);

    // Step e: Replay the consumed refresh token at +1 second -> identical successor pair
    currentNow += 1000;
    if (harness.setNow) {
      harness.setNow(currentNow);
    }
    const tokenE = await postToken(instance1.url, {
      grant_type: 'refresh_token',
      refresh_token: initial.refreshToken,
      client_id: initial.clientId,
    });
    expect(tokenE.status, 'step e: retry inside window must return 200').toBe(200);
    expect(tokenE.data.access_token, 'step e: retry access token must match').toBe(newAccessD);
    expect(tokenE.data.refresh_token, 'step e: retry refresh token must match').toBe(newRefreshD);

    // Step f: Fresh instance over the same backing refreshes -> 200 and /mcp 2xx
    const instance2 = await harness.createInstance(backing, { instanceId: 'inst-2' });
    try {
      const tokenF = await postToken(instance2.url, {
        grant_type: 'refresh_token',
        refresh_token: newRefreshD,
        client_id: initial.clientId,
      });
      expect(tokenF.status, 'step f: fresh instance refresh must return 200').toBe(200);
      const newAccessF = String(tokenF.data.access_token);
      const newRefreshF = String(tokenF.data.refresh_token);

      const mcpF = await sendMcp(instance2.url, newAccessF);
      expect(mcpF.status, 'step f: /mcp on fresh instance must return 200').toBe(200);

      // Step g: Two concurrent refreshes -> both return 200 with identical pairs
      const [conc1, conc2] = await Promise.all([
        postToken(instance1.url, {
          grant_type: 'refresh_token',
          refresh_token: newRefreshF,
          client_id: initial.clientId,
        }),
        postToken(instance2.url, {
          grant_type: 'refresh_token',
          refresh_token: newRefreshF,
          client_id: initial.clientId,
        }),
      ]);
      expect(conc1.status, 'step g: concurrent refresh 1 must return 200').toBe(200);
      expect(conc2.status, 'step g: concurrent refresh 2 must return 200').toBe(200);
      expect(conc1.data.access_token, 'step g: concurrent access tokens must match').toBe(
        conc2.data.access_token,
      );
      expect(conc1.data.refresh_token, 'step g: concurrent refresh tokens must match').toBe(
        conc2.data.refresh_token,
      );

      const activeAccessG = String(conc1.data.access_token);
      let activeRefreshG = String(conc1.data.refresh_token);

      const mcpG = await sendMcp(instance1.url, activeAccessG);
      expect(mcpG.status, 'step g: /mcp with concurrent access token must return 200').toBe(200);
      // Step h: Bogus refresh token -> 400 invalid_grant
      const tokenH = await postToken(instance1.url, {
        grant_type: 'refresh_token',
        refresh_token: 'bogus_refresh_token_nonexistent',
        client_id: initial.clientId,
      });
      expect(tokenH.status, 'step h: bogus refresh token must return 400').toBe(400);
      expect(tokenH.data.error, 'step h: bogus error must be invalid_grant').toBe('invalid_grant');

      // Step i: Present a consumed token at +2 min (outside 30 s window) -> 400; family is revoked
      currentNow += 120 * 1000;
      if (harness.setNow) {
        harness.setNow(currentNow);
      }
      const tokenIReplay = await postToken(instance1.url, {
        grant_type: 'refresh_token',
        refresh_token: newRefreshF, // consumed token from step g
        client_id: initial.clientId,
      });
      expect(tokenIReplay.status, 'step i: consumed token outside window must return 400').toBe(400);
      expect(tokenIReplay.data.error).toBe('invalid_grant');

      // Presenting the current active token should now also fail because family was revoked
      const tokenICurrent = await postToken(instance1.url, {
        grant_type: 'refresh_token',
        refresh_token: activeRefreshG,
        client_id: initial.clientId,
      });
      expect(tokenICurrent.status, 'step i: current token after family revocation must return 400').toBe(
        400,
      );
      expect(tokenICurrent.data.error).toBe('invalid_grant');

      // Sign in again for subsequent steps
      const secondSession = await harness.signIn(instance1.url, { email: 'user@example.com' });
      activeRefreshG = secondSession.refreshToken;

      // Step j: Store outage -> /token 400 temporarily_unavailable; /mcp 503 Retry-After; then heals
      if (harness.setStoreOutage) {
        await harness.setStoreOutage(backing, true);
        try {
          const tokenJ = await postToken(instance1.url, {
            grant_type: 'refresh_token',
            refresh_token: activeRefreshG,
            client_id: secondSession.clientId,
          });
          expect(tokenJ.status, 'step j: /token under store outage must return 400').toBe(400);
          expect(tokenJ.data.error, 'step j: /token error must be temporarily_unavailable').toBe(
            'temporarily_unavailable',
          );

          const mcpJ = await sendMcp(instance1.url, secondSession.accessToken);
          expect(mcpJ.status, 'step j: /mcp under store outage must return 503').toBe(503);
          expect(mcpJ.headers.get('retry-after'), 'step j: Retry-After header must be set').toBe('5');
          expect((mcpJ.data as Record<string, unknown>).error).toBe('temporarily_unavailable');
        } finally {
          await harness.setStoreOutage(backing, false);
        }

        const mcpJHealed = await sendMcp(instance1.url, secondSession.accessToken);
        expect(mcpJHealed.status, 'step j: /mcp after store heals must return 200').toBe(200);
      }

      // Step k: Upstream transient & definitive failure
      if (harness.supportsUpstream && harness.setUpstreamState) {
        await harness.setUpstreamState(backing, 'transient');
        // While still valid, should proceed
        const mcpKValid = await sendMcp(instance1.url, secondSession.accessToken);
        expect([200, 503]).toContain(mcpKValid.status);

        // Definitive failure
        await harness.setUpstreamState(backing, 'definitive');
        const tokenKDef = await postToken(instance1.url, {
          grant_type: 'refresh_token',
          refresh_token: activeRefreshG,
          client_id: secondSession.clientId,
        });
        expect([400, 401]).toContain(tokenKDef.status);
        await harness.setUpstreamState(backing, 'healthy');
      }

      // Step l: Adoption
      if (harness.supportsAdoption) {
        // loopback redirect gives 302 onward
        const resLoopback = await fetch(
          `${instance1.url}/authorize?client_id=adoptable_client_12345&redirect_uri=http://127.0.0.1:9099/callback&response_type=code`,
          { redirect: 'manual' },
        );
        expect([302, 200]).toContain(resLoopback.status);

        // evil redirect gives 400 with no Location header
        const resEvil = await fetch(
          `${instance1.url}/authorize?client_id=adoptable_client_12345&redirect_uri=https://evil.example/cb&response_type=code`,
          { redirect: 'manual' },
        );
        expect(resEvil.status, 'step l: evil redirect must return 400').toBe(400);
        expect(resEvil.headers.get('location'), 'step l: evil redirect must have no Location').toBeNull();
      }

      // Step m: Allowlist removal
      if (harness.supportsAllowlist && harness.setAllowlist) {
        const allowlistSession = await harness.signIn(instance1.url, { email: 'allowed@example.com' });
        await harness.setAllowlist(backing, ['other@example.com']);
        const tokenM = await postToken(instance1.url, {
          grant_type: 'refresh_token',
          refresh_token: allowlistSession.refreshToken,
          client_id: allowlistSession.clientId,
        });
        expect(tokenM.status, 'step m: refresh after allowlist removal must return 400').toBe(400);
        expect(tokenM.data.error).toBe('invalid_grant');
        await harness.setAllowlist(backing, ['allowed@example.com', 'user@example.com']);
      }

      // Step n: /register public client
      if (harness.supportsRegistration) {
        const resReg = await fetch(`${instance1.url}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Public Test Client',
            redirect_uris: ['http://127.0.0.1:8123/callback'],
            token_endpoint_auth_method: 'none',
          }),
        });
        expect([200, 201]).toContain(resReg.status);
      }

      // Step o: Clock +31 days, then refresh -> 200 (no calendar expiry on refresh tokens)
      const freshSession = await harness.signIn(instance1.url, { email: 'user@example.com' });
      currentNow += 31 * 86400 * 1000;
      if (harness.setNow) {
        harness.setNow(currentNow);
      }
      const tokenO = await postToken(instance1.url, {
        grant_type: 'refresh_token',
        refresh_token: freshSession.refreshToken,
        client_id: freshSession.clientId,
      });
      expect(tokenO.status, 'step o: refresh at +31 days must return 200').toBe(200);
      expect(tokenO.data.access_token).toBeTruthy();

      // Step p: Upstream 401 during tool call
      if (harness.simulateToolUpstream401) {
        const toolRes = await harness.simulateToolUpstream401(
          instance1.url,
          String(tokenO.data.access_token),
        );
        expect([200, 401, 500]).toContain(toolRes.status);
      }
    } finally {
      await instance2.close();
    }
  } finally {
    await instance1.close();
  }
}
