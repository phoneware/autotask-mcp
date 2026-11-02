import { getBindingsStore, FirestoreBindingsStore, BINDINGS_COLLECTION } from '../archive/bindings.js';
import {
  getRequirementsStore,
  FirestoreRequirementsStore,
  REQUIREMENTS_COLLECTION,
  type ChecklistTaskRequirement,
} from '../provisioning/requirements.js';
import type { CompanyArchiveBinding } from '../provisioning/contracts.js';
import { Firestore } from '@google-cloud/firestore';

/**
 * Privileged administration command for customer archive destination bindings
 * and server-owned checklist requirements.
 * Excluded from ordinary MCP capabilities.
 */
export async function setCompanyArchiveBinding(params: {
  accountKey: string;
  companyId: string;
  driveId: string;
  folderId: string;
  archivePrincipal: string;
  allowedActorResourceIds: number[];
  approvalEvidenceRef: string;
  expectedVersion?: number;
  disabled?: boolean;
}): Promise<CompanyArchiveBinding> {
  const store = getBindingsStore();

  if (
    !params.driveId.trim() ||
    !params.folderId.trim() ||
    !params.archivePrincipal.trim() ||
    !params.approvalEvidenceRef.trim()
  ) {
    throw new Error('All destination and approval fields must be non-empty strings');
  }

  if (
    !Array.isArray(params.allowedActorResourceIds) ||
    params.allowedActorResourceIds.length === 0 ||
    params.allowedActorResourceIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error('allowedActorResourceIds must be a non-empty array of positive safe integers');
  }

  // Atomic transaction if Firestore is used
  if (store instanceof FirestoreBindingsStore) {
    const fs = new Firestore({
      projectId: process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
      ignoreUndefinedProperties: true,
    });
    const docId = `${params.accountKey}_${params.companyId}`;
    const docRef = fs.collection(BINDINGS_COLLECTION).doc(docId);

    return fs.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const existing = snap.exists ? (snap.data() as CompanyArchiveBinding) : null;

      if (params.expectedVersion !== undefined) {
        const currentVersion = existing?.version ?? 0;
        if (currentVersion !== params.expectedVersion) {
          throw new Error(
            `CAS mismatch: expected binding version ${params.expectedVersion}, but current version is ${currentVersion}`,
          );
        }
      }

      const newVersion = (existing?.version ?? 0) + 1;
      const binding: CompanyArchiveBinding = {
        accountKey: params.accountKey,
        companyId: params.companyId,
        driveId: params.driveId.trim(),
        folderId: params.folderId.trim(),
        archivePrincipal: params.archivePrincipal.trim(),
        allowedActorResourceIds: params.allowedActorResourceIds,
        version: newVersion,
        approvalEvidenceRef: params.approvalEvidenceRef.trim(),
        disabled: Boolean(params.disabled),
      };

      txn.set(docRef, binding);
      return binding;
    });
  }

  // In-memory atomic fallback for tests
  const existing = await store.get(params.accountKey, params.companyId);
  if (params.expectedVersion !== undefined) {
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== params.expectedVersion) {
      throw new Error(
        `CAS mismatch: expected binding version ${params.expectedVersion}, but current version is ${currentVersion}`,
      );
    }
  }

  const newVersion = (existing?.version ?? 0) + 1;
  const binding: CompanyArchiveBinding = {
    accountKey: params.accountKey,
    companyId: params.companyId,
    driveId: params.driveId.trim(),
    folderId: params.folderId.trim(),
    archivePrincipal: params.archivePrincipal.trim(),
    allowedActorResourceIds: params.allowedActorResourceIds,
    version: newVersion,
    approvalEvidenceRef: params.approvalEvidenceRef.trim(),
    disabled: Boolean(params.disabled),
  };

  await store.set(binding);
  return binding;
}

export async function setChecklistRequirement(params: ChecklistTaskRequirement): Promise<void> {
  const store = getRequirementsStore();

  if (store instanceof FirestoreRequirementsStore) {
    const fs = new Firestore({
      projectId: process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
      ignoreUndefinedProperties: true,
    });
    const docId = `${params.accountKey}_${params.ticketId}_${params.checklistItemId}`;
    const docRef = fs.collection(REQUIREMENTS_COLLECTION).doc(docId);

    await fs.runTransaction(async (txn) => {
      const snap = await txn.get(docRef);
      const existing = snap.exists ? (snap.data() as ChecklistTaskRequirement) : null;
      if (params.version !== undefined && existing) {
        if (existing.version !== params.version) {
          throw new Error(`CAS mismatch: requirement version changed from ${params.version} to ${existing.version}`);
        }
      }
      txn.set(docRef, params);
    });
    return;
  }

  await store.set(params);
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[2];
  if (!command) {
    console.error('Usage: node dist/admin/provisioning.js <set-binding|get-binding|set-requirement> [jsonArgs]');
    process.exit(1);
  }

  const jsonRaw = argv[3];
  const parsedArgs = jsonRaw ? JSON.parse(jsonRaw) : {};

  if (command === 'set-binding') {
    const res = await setCompanyArchiveBinding(parsedArgs);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'get-binding') {
    const store = getBindingsStore();
    const res = await store.get(parsedArgs.accountKey, parsedArgs.companyId);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'set-requirement') {
    await setChecklistRequirement(parsedArgs);
    console.log(JSON.stringify({ success: true }, null, 2));
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

// CLI entrypoint execution
if (process.argv[1] && process.argv[1].includes('provisioning')) {
  main(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
