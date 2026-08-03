/**
 * In-memory stores for issued tokens and dynamically registered OAuth clients.
 *
 * The service runs as a single always-warm Cloud Run instance (sessions live in
 * instance memory, so it cannot scale out anyway), which makes an in-process
 * map the honest choice rather than a placeholder. The cost is that a restart,
 * including every deploy, forces clients to re-authenticate. Google sign-in is
 * a couple of clicks and usually silent, so that is a fair trade for not
 * standing up Firestore. If this ever needs to survive restarts or scale out,
 * swap these two classes for the Firestore-backed pair in peplink-mcp.
 */

import { randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  /** Epoch ms when the access token stops being valid. */
  expiresAt: number;
  scopes?: string[];
  /** Google account that authenticated. */
  email: string;
  /** Autotask Resource id for that email, when one exists. */
  resourceId?: number;
}

export class TokenStore {
  private readonly byAccess = new Map<string, StoredToken>();
  private readonly byRefresh = new Map<string, string>();

  get size(): number {
    return this.byAccess.size;
  }

  set(token: StoredToken): void {
    this.byAccess.set(token.accessToken, token);
    this.byRefresh.set(token.refreshToken, token.accessToken);
  }

  get(accessToken: string): StoredToken | undefined {
    return this.byAccess.get(accessToken);
  }

  getByRefreshToken(refreshToken: string): StoredToken | undefined {
    const accessToken = this.byRefresh.get(refreshToken);
    return accessToken ? this.byAccess.get(accessToken) : undefined;
  }

  delete(accessToken: string): void {
    const token = this.byAccess.get(accessToken);
    if (!token) return;
    this.byAccess.delete(accessToken);
    this.byRefresh.delete(token.refreshToken);
  }

  deleteByRefreshToken(refreshToken: string): void {
    const accessToken = this.byRefresh.get(refreshToken);
    if (accessToken) this.delete(accessToken);
  }

  /** Drop expired access tokens. Returns how many were removed. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const token of [...this.byAccess.values()]) {
      if (token.expiresAt <= now) {
        this.delete(token.accessToken);
        removed++;
      }
    }
    return removed;
  }
}

export class MemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  get size(): number {
    return this.clients.size;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(registered.client_id, registered);
    return registered;
  }
}
