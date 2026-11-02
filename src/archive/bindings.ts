import crypto from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type { CompanyArchiveBinding } from '../provisioning/contracts.js';

export const BINDINGS_COLLECTION = 'autotask_mcp_archive_bindings';

export function bindingDocId(accountKey: string, companyId: string): string {
  return `${accountKey}_${companyId}`;
}
export function computeBindingFingerprint(binding: CompanyArchiveBinding): string {
  const sortedActors = [...binding.allowedActorResourceIds].sort((a, b) => a - b).join(',');
  const parts = [
    binding.accountKey,
    binding.companyId,
    binding.driveId,
    binding.folderId,
    binding.archivePrincipal,
    sortedActors,
    String(binding.version),
    String(binding.disabled),
    binding.approvalEvidenceRef,
  ];
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex');
}

export interface BindingsStore {
  get(accountKey: string, companyId: string): Promise<CompanyArchiveBinding | null>;
  set(binding: CompanyArchiveBinding): Promise<void>;
  setWithCas(
    binding: Omit<CompanyArchiveBinding, 'version'>,
    expectedVersion: number,
  ): Promise<CompanyArchiveBinding>;
}

export class MemoryBindingsStore implements BindingsStore {
  private readonly bindings = new Map<string, CompanyArchiveBinding>();

  async get(accountKey: string, companyId: string): Promise<CompanyArchiveBinding | null> {
    const key = `${accountKey}:${companyId}`;
    const b = this.bindings.get(key);
    return b ? { ...b } : null;
  }

  async set(binding: CompanyArchiveBinding): Promise<void> {
    const key = `${binding.accountKey}:${binding.companyId}`;
    this.bindings.set(key, { ...binding });
  }

  async setWithCas(
    params: Omit<CompanyArchiveBinding, 'version'>,
    expectedVersion: number,
  ): Promise<CompanyArchiveBinding> {
    const key = `${params.accountKey}:${params.companyId}`;
    const existing = this.bindings.get(key);
    const currentVersion = existing?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      throw new Error(
        `CAS mismatch: expected binding version ${expectedVersion}, but current version is ${currentVersion}`,
      );
    }

    const nextVersion = currentVersion + 1;
    const finalBinding: CompanyArchiveBinding = {
      ...params,
      version: nextVersion,
    };
    this.bindings.set(key, { ...finalBinding });
    return { ...finalBinding };
  }

  clear(): void {
    this.bindings.clear();
  }
}

export class FirestoreBindingsStore implements BindingsStore {
  constructor(private readonly firestore: Firestore) {}

  async get(accountKey: string, companyId: string): Promise<CompanyArchiveBinding | null> {
    const docId = `${accountKey}_${companyId}`;
    const snap = await this.firestore.collection(BINDINGS_COLLECTION).doc(docId).get();
    if (!snap.exists) return null;
    return (snap.data() as CompanyArchiveBinding) ?? null;
  }

  async set(binding: CompanyArchiveBinding): Promise<void> {
    const docId = `${binding.accountKey}_${binding.companyId}`;
    await this.firestore.collection(BINDINGS_COLLECTION).doc(docId).set(binding);
  }

  async setWithCas(
    params: Omit<CompanyArchiveBinding, 'version'>,
    expectedVersion: number,
  ): Promise<CompanyArchiveBinding> {
    const docId = `${params.accountKey}_${params.companyId}`;
    const docRef = this.firestore.collection(BINDINGS_COLLECTION).doc(docId);

    return this.firestore.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const existing = snap.exists ? (snap.data() as CompanyArchiveBinding) : null;
      const currentVersion = existing?.version ?? 0;

      if (currentVersion !== expectedVersion) {
        throw new Error(
          `CAS mismatch: expected binding version ${expectedVersion}, but current version is ${currentVersion}`,
        );
      }

      const nextVersion = currentVersion + 1;
      const finalBinding: CompanyArchiveBinding = {
        ...params,
        version: nextVersion,
      };

      txn.set(docRef, finalBinding);
      return finalBinding;
    });
  }
}

let activeBindingsStore: BindingsStore | null = null;

export function getBindingsStore(): BindingsStore {
  if (activeBindingsStore) return activeBindingsStore;
  try {
    const projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    const fs = new Firestore({ projectId, ignoreUndefinedProperties: true });
    activeBindingsStore = new FirestoreBindingsStore(fs);
    return activeBindingsStore;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to initialize Firestore bindings store: ${msg}`);
  }
}

export function setBindingsStore(store: BindingsStore | null): void {
  activeBindingsStore = store;
}

/**
 * Validate customer archive destination binding before initiating transfer.
 */
export async function assertAuthorizedArchiveBinding(params: {
  accountKey: string;
  companyId: string;
  actorResourceId: number;
  expectedVersion?: number;
}): Promise<CompanyArchiveBinding> {
  const store = getBindingsStore();
  const binding = await store.get(params.accountKey, params.companyId);

  if (!binding) {
    throw new Error(
      `No archive destination binding configured for company ID ${params.companyId}. Register an approved Shared Drive folder binding first.`,
    );
  }

  // Schema validation of stored binding
  if (
    typeof binding.driveId !== 'string' ||
    !binding.driveId.trim() ||
    typeof binding.folderId !== 'string' ||
    !binding.folderId.trim() ||
    typeof binding.archivePrincipal !== 'string' ||
    !binding.archivePrincipal.trim() ||
    typeof binding.version !== 'number'
  ) {
    throw new Error(
      `Invalid archive binding for company ID ${params.companyId}: malformed or incomplete destination schema; archival refused`,
    );
  }

  if (binding.disabled) {
    throw new Error(
      `Archive destination binding for company ID ${params.companyId} is currently disabled; archival refused`,
    );
  }

  // Strict authorization: allowedActorResourceIds MUST exist, be non-empty, and include caller
  if (
    !Array.isArray(binding.allowedActorResourceIds) ||
    binding.allowedActorResourceIds.length === 0 ||
    !binding.allowedActorResourceIds.includes(params.actorResourceId)
  ) {
    throw new Error(
      `Actor resource ID ${params.actorResourceId} is not authorized by archive binding for company ${params.companyId}; archival refused`,
    );
  }

  // Version check if caller expects specific binding version
  if (params.expectedVersion !== undefined && binding.version !== params.expectedVersion) {
    throw new Error(
      `Conflict: archive destination binding version changed from ${params.expectedVersion} to ${binding.version} during execution; write refused`,
    );
  }

  return binding;
}
