/**
 * Stores for issued tokens and dynamically registered OAuth clients.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Capability } from './capabilities.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export const REFRESH_RETRY_WINDOW_MS = 30_000;
export const MAX_RETIRED_REFRESH_FINGERPRINTS = 64;

export function refreshFingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('base64url');
}

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  refreshFamilyId?: string;
  expiresAt: number;
  scopes?: string[];
  email: string;
  resourceId?: number;
  userType?: number;
  capabilities?: Capability[];
}

export type RefreshRotationResult =
  | { status: 'claimed'; token: StoredToken }
  | { status: 'retry'; token: StoredToken }
  | { status: 'missing' }
  | { status: 'replay' };

interface RefreshRecord {
  status: 'active' | 'consumed';
  familyId: string;
  token: StoredToken;
  successorRefreshToken?: string;
  consumedAt?: number;
}

interface RefreshFamily {
  id: string;
  currentAccessToken: string;
  currentRefreshToken: string;
  previousAccessToken?: string;
  previousRefreshToken?: string;
  retiredRefreshFingerprints: string[];
}

export interface TokenStoreLike {
  get(accessToken: string): StoredToken | undefined | Promise<StoredToken | undefined>;
  getByRefreshToken(
    refreshToken: string,
  ): StoredToken | undefined | Promise<StoredToken | undefined>;
  set(token: StoredToken): void | Promise<void>;
  delete(accessToken: string): void | Promise<void>;
  revokeByAccessToken(accessToken: string): void | Promise<void>;
  deleteByRefreshToken(refreshToken: string): void | Promise<void>;
  rotateRefreshToken(
    oldRefreshToken: string,
    replacement: StoredToken,
    expectedClientId: string,
    now?: number,
  ): RefreshRotationResult | Promise<RefreshRotationResult>;
  sweep(now?: number): number | Promise<number>;
}

export class TokenStore implements TokenStoreLike {
  private readonly byAccess = new Map<string, StoredToken>();
  private readonly byRefresh = new Map<string, RefreshRecord>();
  private readonly families = new Map<string, RefreshFamily>();
  private readonly retiredFamilies = new Map<string, string>();

  get size(): number {
    return this.byAccess.size;
  }

  set(token: StoredToken): void {
    const familyId = token.refreshFamilyId ?? randomUUID();
    const stored = { ...token, refreshFamilyId: familyId };
    this.byAccess.set(stored.accessToken, stored);
    this.byRefresh.set(stored.refreshToken, { status: 'active', familyId, token: stored });
    this.families.set(familyId, {
      id: familyId,
      currentAccessToken: stored.accessToken,
      currentRefreshToken: stored.refreshToken,
      retiredRefreshFingerprints: [],
    });
  }

  get(accessToken: string): StoredToken | undefined {
    return this.byAccess.get(accessToken);
  }

  getByRefreshToken(refreshToken: string): StoredToken | undefined {
    const record = this.byRefresh.get(refreshToken);
    return record?.status === 'active' ? record.token : undefined;
  }

  delete(accessToken: string): void {
    this.byAccess.delete(accessToken);
  }

  revokeByAccessToken(accessToken: string): void {
    const token = this.byAccess.get(accessToken);
    if (!token?.refreshFamilyId) {
      this.delete(accessToken);
      return;
    }
    this.revokeFamily(token.refreshFamilyId);
  }

  deleteByRefreshToken(refreshToken: string): void {
    const record = this.byRefresh.get(refreshToken);
    const familyId = record?.familyId ?? this.retiredFamilies.get(refreshFingerprint(refreshToken));
    if (familyId) this.revokeFamily(familyId);
  }

  rotateRefreshToken(
    oldRefreshToken: string,
    replacement: StoredToken,
    expectedClientId: string,
    now: number = Date.now(),
  ): RefreshRotationResult {
    const record = this.byRefresh.get(oldRefreshToken);
    if (!record) {
      const retiredFamilyId = this.retiredFamilies.get(refreshFingerprint(oldRefreshToken));
      if (!retiredFamilyId) return { status: 'missing' };
      this.revokeFamily(retiredFamilyId);
      return { status: 'replay' };
    }
    if (record.token.clientId !== expectedClientId) return { status: 'missing' };

    const family = this.families.get(record.familyId);
    if (record.status === 'consumed') {
      const successor = record.successorRefreshToken
        ? this.byRefresh.get(record.successorRefreshToken)
        : undefined;
      const withinRetryWindow =
        record.consumedAt !== undefined && now - record.consumedAt <= REFRESH_RETRY_WINDOW_MS;
      if (
        withinRetryWindow &&
        family?.previousRefreshToken === oldRefreshToken &&
        successor?.status === 'active' &&
        successor.token.clientId === expectedClientId
      ) {
        return { status: 'retry', token: successor.token };
      }
      this.revokeFamily(record.familyId);
      return { status: 'replay' };
    }
    const activeFamily: RefreshFamily = family ?? {
      id: record.familyId,
      currentAccessToken: record.token.accessToken,
      currentRefreshToken: oldRefreshToken,
      retiredRefreshFingerprints: [],
    };
    const retired = [...activeFamily.retiredRefreshFingerprints];
    if (activeFamily.previousRefreshToken) {
      this.byAccess.delete(activeFamily.previousAccessToken ?? '');
      this.byRefresh.delete(activeFamily.previousRefreshToken);
      retired.push(refreshFingerprint(activeFamily.previousRefreshToken));
    }
    while (retired.length > MAX_RETIRED_REFRESH_FINGERPRINTS) {
      const evicted = retired.shift();
      if (evicted) this.retiredFamilies.delete(evicted);
    }
    for (const fingerprint of retired) this.retiredFamilies.set(fingerprint, record.familyId);

    const stored = { ...replacement, refreshFamilyId: record.familyId };
    this.byAccess.delete(record.token.accessToken);
    this.byAccess.set(stored.accessToken, stored);
    this.byRefresh.set(oldRefreshToken, {
      ...record,
      status: 'consumed',
      successorRefreshToken: stored.refreshToken,
      consumedAt: now,
    });
    this.byRefresh.set(stored.refreshToken, {
      status: 'active',
      familyId: record.familyId,
      token: stored,
    });
    this.families.set(record.familyId, {
      id: record.familyId,
      currentAccessToken: stored.accessToken,
      currentRefreshToken: stored.refreshToken,
      previousAccessToken: record.token.accessToken,
      previousRefreshToken: oldRefreshToken,
      retiredRefreshFingerprints: retired,
    });
    return { status: 'claimed', token: stored };
  }

  private revokeFamily(familyId: string): void {
    const family = this.families.get(familyId);
    if (!family) return;
    this.byAccess.delete(family.currentAccessToken);
    this.byRefresh.delete(family.currentRefreshToken);
    if (family.previousAccessToken) this.byAccess.delete(family.previousAccessToken);
    if (family.previousRefreshToken) this.byRefresh.delete(family.previousRefreshToken);
    for (const fingerprint of family.retiredRefreshFingerprints) {
      if (this.retiredFamilies.get(fingerprint) === familyId) {
        this.retiredFamilies.delete(fingerprint);
      }
    }
    this.families.delete(familyId);
  }

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
    const client = this.clients.get(clientId);
    if (!client) return undefined;
    const normalized = normalizePublicClient(client);
    if (normalized !== client) this.clients.set(clientId, normalized);
    return normalized;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> &
      Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
  ): OAuthClientInformationFull {
    const registered = normalizePublicClient({
      ...client,
      client_id: client.client_id ?? randomUUID(),
      client_id_issued_at: client.client_id_issued_at ?? Math.floor(Date.now() / 1000),
    });
    this.clients.set(registered.client_id, registered);
    return registered;
  }
}

export function normalizePublicClient(
  client: OAuthClientInformationFull,
): OAuthClientInformationFull {
  if (
    client.token_endpoint_auth_method === 'none' &&
    client.client_secret === undefined &&
    client.client_secret_expires_at === undefined
  ) {
    return client;
  }
  const normalized = { ...client };
  delete normalized.client_secret;
  delete normalized.client_secret_expires_at;
  normalized.token_endpoint_auth_method = 'none';
  return normalized;
}
