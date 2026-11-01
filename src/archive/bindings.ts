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
}): Promise<CompanyArchiveBinding> {
  const store = getBindingsStore();
  const binding = await store.get(params.accountKey, params.companyId);

  if (!binding) {
    throw new Error(
      `No archive destination binding configured for company ID ${params.companyId}. Register an approved Shared Drive folder binding first.`,
    );
  }

  if (binding.disabled) {
    throw new Error(
      `Archive destination binding for company ID ${params.companyId} is currently disabled; archival refused`,
    );
  }

  if (
    binding.allowedActorResourceIds &&
    binding.allowedActorResourceIds.length > 0 &&
    !binding.allowedActorResourceIds.includes(params.actorResourceId)
  ) {
    throw new Error(
      `Actor resource ID ${params.actorResourceId} is not authorized by archive binding for company ${params.companyId}`,
    );
  }

  return binding;
}
