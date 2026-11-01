import { getBindingsStore } from '../src/archive/bindings.js';
import type { CompanyArchiveBinding } from '../src/provisioning/contracts.js';

/**
 * Privileged administration utility for customer archive destination bindings.
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
  const existing = await store.get(params.accountKey, params.companyId);

  if (params.expectedVersion !== undefined) {
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== params.expectedVersion) {
      throw new Error(
        `CAS mismatch: expected binding version ${params.expectedVersion}, but current version is ${currentVersion}`,
      );
    }
  }

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

export async function getCompanyArchiveBinding(
  accountKey: string,
  companyId: string,
): Promise<CompanyArchiveBinding | null> {
  const store = getBindingsStore();
  return store.get(accountKey, companyId);
}
