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

  // Check if store has existing operations or coordinators under legacy namespaces
  const opsSnap = await firestore.collection('provisioning_operations').limit(1).get();
  const coordsSnap = await firestore.collection('provisioning_coordinators').limit(1).get();

  if (opsSnap.empty && coordsSnap.empty) {
    // Certified fresh empty store: automatically record completed migration for this canonical account
    const record: AccountMigrationRecord = {
      accountKey,
      status: 'completed',
      migratedAt: Date.now(),
      inventoriedCount: 0,
      quarantinedCount: 0,
      legacyNamespaces: [],
      notes: 'Certified empty store on first canonical initialization',
    };
    await docRef.set(record);
    return;
  }

  throw new AccountMigrationError(
    `Account writes refused: unmigrated historical records detected. Run administrative account migration for account "${accountKey}" before admitting new writes.`,
  );
}
