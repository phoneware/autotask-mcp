import { fileURLToPath } from 'node:url';
import { getBindingsStore } from '../archive/bindings.js';
import {
  getRequirementsStore,
  type ChecklistTaskRequirement,
} from '../provisioning/requirements.js';
import type { CompanyArchiveBinding } from '../provisioning/contracts.js';

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
  expectedVersion: number;
  disabled?: boolean;
}): Promise<CompanyArchiveBinding> {
  if (params.expectedVersion === undefined || typeof params.expectedVersion !== 'number') {
    throw new Error('expectedVersion is required for binding CAS operations (0 for create-only)');
  }

  if (
    !params.driveId?.trim() ||
    !params.folderId?.trim() ||
    !params.archivePrincipal?.trim() ||
    !params.approvalEvidenceRef?.trim()
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

  const store = getBindingsStore();
  const bindingData: Omit<CompanyArchiveBinding, 'version'> = {
    accountKey: params.accountKey,
    companyId: params.companyId,
    driveId: params.driveId.trim(),
    folderId: params.folderId.trim(),
    archivePrincipal: params.archivePrincipal.trim(),
    allowedActorResourceIds: [...params.allowedActorResourceIds].sort((a, b) => a - b),
    approvalEvidenceRef: params.approvalEvidenceRef.trim(),
    disabled: Boolean(params.disabled),
  };

  const written = await store.setWithCas(bindingData, params.expectedVersion);
  // Authoritative readback
  const verified = await store.get(params.accountKey, params.companyId);
  if (!verified || verified.version !== written.version) {
    throw new Error('Readback verification failed after binding write');
  }
  return verified;
}

export async function setChecklistRequirement(
  params: ChecklistTaskRequirement & { expectedVersion: number },
): Promise<ChecklistTaskRequirement> {
  if (params.expectedVersion === undefined || typeof params.expectedVersion !== 'number') {
    throw new Error('expectedVersion is required for requirement CAS operations (0 for create-only)');
  }

  if (!params.accountKey?.trim() || !params.ticketId?.trim() || !params.checklistItemId?.trim()) {
    throw new Error('accountKey, ticketId, and checklistItemId must be non-empty');
  }

  if (!params.semanticFingerprint?.trim()) {
    throw new Error('semanticFingerprint must be non-empty');
  }

  const store = getRequirementsStore();
  const { version: _ignoreVersion, expectedVersion, ...reqData } = params;

  const written = await store.setWithCas(reqData, expectedVersion);
  // Authoritative readback
  const verified = await store.get(params.accountKey, params.ticketId, params.checklistItemId);
  if (!verified || verified.version !== written.version) {
    throw new Error('Readback verification failed after requirement write');
  }
  return verified;
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
    const res = await setChecklistRequirement(parsedArgs);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

// Strict exact ESM entrypoint detection
const isDirectEntry = Boolean(
  process.argv[1] &&
    (process.argv[1] === fileURLToPath(import.meta.url) ||
      process.argv[1].endsWith('/admin/provisioning.js') ||
      process.argv[1].endsWith('/admin/provisioning.ts')),
);

if (isDirectEntry) {
  main(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
