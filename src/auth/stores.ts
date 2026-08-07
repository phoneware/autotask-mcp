/**
 * Stores for issued tokens and dynamically registered OAuth clients.
 *
 * Two implementations, one interface. The in-memory pair below is right for
 * local runs and tests; the Firestore pair in ./firestore-stores.ts is what
 * production uses, because in-process maps do not survive a restart.
 *
 * That distinction is not academic. A DCR client registers once, caches the
 * client_id it was issued, and presents it on every later /authorize. If the
 * store that minted it is gone, the lookup misses and the client is told
 * `invalid_client` with no way to know it should register again. On Cloud Run,
 * where every deploy replaces the instance, an in-memory clients store means
 * every deploy silently breaks every already-connected client. Tokens have the
 * same problem one level down: losing them only forces a re-login, which is
 * survivable, but there is no reason to accept it once the clients have to be
 * persisted anyway.
 *
 * The interfaces below are deliberately async-tolerant (`T | Promise<T>`) so
 * the provider can await either implementation without caring which is in use.
 */

import { randomUUID } from 'node:crypto';
import type { Capability } from './capabilities.js';
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
  /**
   * Autotask Resource id for that email. Required at issue time, but optional
   * on the type because tokens minted before authorization existed are still
   * readable from Firestore; those are treated as having no rights.
   */
  resourceId?: number;
  /** Autotask security level (Resource.userType) at the time of issue. */
  userType?: number;
  /** What the person may do. Absent on pre-authorization tokens. */
  capabilities?: Capability[];
}

/**
 * Async-friendly token store contract, implemented by both TokenStore and
 * FirestoreTokenStore. Provider code only ever sees this.
 */
export interface TokenStoreLike {
  get(accessToken: string): StoredToken | undefined | Promise<StoredToken | undefined>;
  getByRefreshToken(
    refreshToken: string,
  ): StoredToken | undefined | Promise<StoredToken | undefined>;
  set(token: StoredToken): void | Promise<void>;
  delete(accessToken: string): void | Promise<void>;
  deleteByRefreshToken(refreshToken: string): void | Promise<void>;
  /** Drop expired access tokens. Returns how many were removed. */
  sweep(now?: number): number | Promise<number>;
}

export class TokenStore implements TokenStoreLike {
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
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> &
      Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): OAuthClientInformationFull {
    // The SDK generates client_id/client_secret itself unless clientIdGeneration
    // is disabled, so keep what it sent rather than reissuing a different id
    // than the one already in the response it built.
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: client.client_id ?? randomUUID(),
      client_id_issued_at: client.client_id_issued_at ?? Math.floor(Date.now() / 1000),
    };
    this.clients.set(registered.client_id, registered);
    return registered;
  }
}
