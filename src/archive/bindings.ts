import { Firestore } from '@google-cloud/firestore';
import type { CompanyArchiveBinding } from '../provisioning/contracts.js';

export const BINDINGS_COLLECTION = 'autotask_mcp_archive_bindings';

export interface BindingsStore {
  get(accountKey: string, companyId: string): Promise<CompanyArchiveBinding | null>;
  set(binding: CompanyArchiveBinding): Promise<void>;
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
}

let activeBindingsStore: BindingsStore | null = null;

export function getBindingsStore(): BindingsStore {
  if (activeBindingsStore) return activeBindingsStore;
  const projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId) {
    try {
      const fs = new Firestore({ projectId, ignoreUndefinedProperties: true });
      activeBindingsStore = new FirestoreBindingsStore(fs);
      return activeBindingsStore;
    } catch {
      // Fallback
    }
  }
  activeBindingsStore = new MemoryBindingsStore();
  return activeBindingsStore;
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
