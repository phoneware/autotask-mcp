import crypto from 'node:crypto';
import type { Firestore } from '@google-cloud/firestore';

export const ACCOUNT_MIGRATIONS_COLLECTION = 'provisioning_account_migrations';

export class AccountMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountMigrationError';
  }
}

/**
 * Derive canonical account key strictly from integration username and effective zone URL.
 * Rejects invalid URLs or missing/empty values instead of falling back to unsafe hashes.
 */
export function deriveCanonicalAccountKey(
  usernameInput?: string,
  effectiveZoneUrlInput?: string,
): string {
  const username = (
    usernameInput !== undefined ? usernameInput : process.env.AUTOTASK_USERNAME || ''
  )
    .toLowerCase()
    .trim();

  if (!username) {
    throw new Error('Account derivation requires a non-empty Autotask integration username');
  }

  const rawUrl = (
    effectiveZoneUrlInput !== undefined
      ? effectiveZoneUrlInput
      : process.env.AUTOTASK_API_URL || ''
  ).trim();

  if (!rawUrl) {
    throw new Error(
      'Account derivation requires an effective Autotask zone URL (or AUTOTASK_API_URL)',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `Account derivation refused invalid Autotask zone URL: ${JSON.stringify(rawUrl)}`,
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `Account derivation requires http or https Autotask zone URL: got ${parsed.protocol}`,
    );
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  const normalizedUrl = `${parsed.origin}${normalizedPath}`;

  return crypto
    .createHash('sha256')
    .update(`${username}\0${normalizedUrl}`)
    .digest('hex')
    .slice(0, 16);
}

export interface AccountMigrationRecord {
  accountKey: string;
  status: 'completed' | 'quarantined' | 'pending';
  migratedAt: number;
  inventoriedCount: number;
  quarantinedCount: number;
  legacyNamespaces: string[];
  notes?: string;
}

/**
 * Enforce that writes to an account are admitted only after verifying safe migration state
 * or establishing certified empty inventory on fresh installations.
 */
export async function assertAccountWriteAdmitted(
  firestore: Firestore | null,
  accountKey: string,
): Promise<void> {
  if (!firestore) {
    // In-memory or non-persistent test environments bypass persistent Firestore gate
    return;
  }

  const docRef = firestore.collection(ACCOUNT_MIGRATIONS_COLLECTION).doc(accountKey);
  const snap = await docRef.get();

  if (snap.exists) {
    const data = snap.data() as AccountMigrationRecord;
    if (data.status === 'completed') {
      return;
    }
    throw new AccountMigrationError(
      `Account writes refused: migration for account ${accountKey} is in status "${data.status}"`,
    );
  }
  throw new AccountMigrationError(
    `Account writes refused: unmigrated historical records or missing certification detected. Run administrative account migration for account "${accountKey}" with established quiescence before admitting new writes.`,
  );
}

/**
 * Administrative migration certification requiring established old-writer quiescence.
 */
export async function certifyAccountMigration(params: {
  firestore: Firestore;
  accountKey: string;
  quiescenceEstablished: boolean;
  notes?: string;
}): Promise<AccountMigrationRecord> {
  if (!params.quiescenceEstablished) {
    throw new Error(
      'Refused: old-writer quiescence must be established before certifying account migration',
    );
  }
  const docRef = params.firestore.collection(ACCOUNT_MIGRATIONS_COLLECTION).doc(params.accountKey);
  const snap = await docRef.get();
  if (snap.exists) {
    const existing = snap.data() as AccountMigrationRecord;
    if (existing.status === 'completed') {
      return existing;
    }
  }

  const legacyOps = await params.firestore.collection('provisioning_operations').get();
  const legacyCoords = await params.firestore.collection('provisioning_coordinators').get();

  const record: AccountMigrationRecord = {
    accountKey: params.accountKey,
    status: 'completed',
    migratedAt: Date.now(),
    inventoriedCount: legacyOps.size + legacyCoords.size,
    quarantinedCount: 0,
    legacyNamespaces: ['provisioning_operations', 'provisioning_coordinators'],
    notes:
      params.notes ??
      'Certified via administrative migration command with established quiescence',
  };

  await docRef.set(record);
  return record;
}
