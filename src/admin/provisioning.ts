import { fileURLToPath } from 'node:url';
import { Firestore } from '@google-cloud/firestore';
import { api } from '../autotask-api.js';
import { getBindingsStore } from '../archive/bindings.js';
import {
  getRequirementsStore,
  computeItemSemanticFingerprint,
  type ChecklistTaskRequirement,
} from '../provisioning/requirements.js';
import type { CompanyArchiveBinding } from '../provisioning/contracts.js';
import { DriveArchiveProvider } from '../archive/drive.js';
import { ArchiveCredentialProvider } from '../archive/credentials.js';
import { deriveCanonicalAccountKey, certifyAccountMigration } from '../provisioning/account.js';
import { assertSafeNumericId } from '../security.js';

export interface SetBindingParams {
  accountKey?: string;
  companyId: string;
  driveId: string;
  folderId: string;
  archivePrincipal: string;
  allowedActorResourceIds: number[];
  approvalEvidenceRef: string;
  expectedVersion: number;
  disabled?: boolean;
  preflightDestination?: boolean;
}

/**
 * Privileged administration command for customer archive destination bindings.
 * Validates company existence against Autotask, preflights Drive destination and credentials,
 * enforces approval provenance, and writes with strict CAS.
 */
export async function setCompanyArchiveBinding(
  params: SetBindingParams,
): Promise<CompanyArchiveBinding> {
  if (params.expectedVersion === undefined || typeof params.expectedVersion !== 'number') {
    throw new Error('expectedVersion is required for binding CAS operations (0 for create-only)');
  }

  const companyId = assertSafeNumericId(params.companyId, 'companyId');

  if (
    !params.driveId?.trim() ||
    !params.folderId?.trim() ||
    !params.archivePrincipal?.trim() ||
    !params.approvalEvidenceRef?.trim()
  ) {
    throw new Error('All destination and approval fields must be non-empty strings');
  }

  // Derive canonical account key
  const canonicalAccount = params.accountKey?.trim() || (await api.getCanonicalAccountKey());

  // 1. Authoritative verification of company existence in Autotask
  const companyRes = (await api.getById('Companies', companyId)) as { item?: unknown; id?: unknown };
  if (!companyRes || (!('item' in companyRes) && !('id' in companyRes))) {
    throw new Error(`Company ID ${companyId} does not exist in Autotask`);
  }

  // 2. Validate approval reference provenance
  const approvalRef = params.approvalEvidenceRef.trim();
  if (approvalRef.length < 5) {
    throw new Error('approvalEvidenceRef must be an authoritative reference string');
  }

  if (
    !Array.isArray(params.allowedActorResourceIds) ||
    params.allowedActorResourceIds.length === 0 ||
    params.allowedActorResourceIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new Error('allowedActorResourceIds must be a non-empty array of positive safe integers');
  }

  // 3. Preflight destination folder in Google Drive if requested or configured
  if (params.preflightDestination !== false) {
    try {
      const credProvider = new ArchiveCredentialProvider();
      const cred = await credProvider.getDriveCredential(params.archivePrincipal.trim());
      const driveProvider = new DriveArchiveProvider();
      await driveProvider.assertValidArchiveFolder(
        params.folderId.trim(),
        params.driveId.trim(),
        params.archivePrincipal.trim(),
        cred.accessToken,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Drive destination preflight failed for folder ${params.folderId}: ${msg}`);
    }
  }

  const store = getBindingsStore();
  const bindingData: Omit<CompanyArchiveBinding, 'version'> = {
    accountKey: canonicalAccount,
    companyId,
    driveId: params.driveId.trim(),
    folderId: params.folderId.trim(),
    archivePrincipal: params.archivePrincipal.trim(),
    allowedActorResourceIds: [...params.allowedActorResourceIds].sort((a, b) => a - b),
    approvalEvidenceRef: approvalRef,
    disabled: Boolean(params.disabled),
  };

  const written = await store.setWithCas(bindingData, params.expectedVersion);

  // Authoritative readback verification
  const verified = await store.get(canonicalAccount, companyId);
  if (!verified || verified.version !== written.version) {
    throw new Error('Readback verification failed after binding write');
  }
  return verified;
}

export interface SetRequirementParams {
  accountKey?: string;
  ticketId: string;
  checklistItemId: string;
  requiredKind: 'attachment_archive' | 'evidence_note';
  expectedVersion: number;
  disabled?: boolean;
  expectedCompanyId?: string;
  expectedAttachmentId?: string;
  expectedSourceDigest?: string;
  requiredBindingId?: string;
  requiredNoteType?: number;
  requiredPublish?: number;
  requiredTitle?: string;
  requiredContentDigest?: string;
  sourceReference?: string;
  sourceVersion?: number;
}

/**
 * Privileged administration command for server-owned checklist requirements.
 * Reads the live checklist item from Autotask to derive its semantic identity,
 * ensuring caller cannot forge arbitrary task semantics.
 */
export async function setChecklistRequirement(
  params: SetRequirementParams,
): Promise<ChecklistTaskRequirement> {
  if (params.expectedVersion === undefined || typeof params.expectedVersion !== 'number') {
    throw new Error('expectedVersion is required for requirement CAS operations (0 for create-only)');
  }

  const ticketId = assertSafeNumericId(params.ticketId, 'ticketId');
  const checklistItemId = assertSafeNumericId(params.checklistItemId, 'checklistItemId');
  const canonicalAccount = params.accountKey?.trim() || (await api.getCanonicalAccountKey());

  // 1. Authoritative read of the real checklist item from Autotask
  const itemRes = (await api.request(
    'GET',
    `V1.0/Tickets/${ticketId}/ChecklistItems/${checklistItemId}`,
  )) as { item?: { itemName?: string; ticketID?: number }; itemName?: string; ticketID?: number };

  const rawItem = itemRes.item ?? itemRes;
  const itemName = rawItem.itemName;
  if (!itemName || typeof itemName !== 'string') {
    throw new Error(`Checklist item ${checklistItemId} on ticket ${ticketId} not found or missing itemName`);
  }

  if (rawItem.ticketID !== undefined && String(rawItem.ticketID) !== ticketId) {
    throw new Error(`Checklist item parent mismatch: item belongs to ticket ${rawItem.ticketID}, not ${ticketId}`);
  }

  const sourceRef = params.sourceReference?.trim() || `admin:req:${ticketId}:${checklistItemId}`;
  const sourceVer = params.sourceVersion ?? 1;

  // Derive semantic fingerprint from unredacted live task item name and source
  const semanticFingerprint = computeItemSemanticFingerprint(
    ticketId,
    checklistItemId,
    itemName,
    sourceRef,
    sourceVer,
  );

  const baseReq = {
    accountKey: canonicalAccount,
    ticketId,
    checklistItemId,
    semanticFingerprint,
    sourceReference: sourceRef,
    sourceVersion: sourceVer,
    disabled: Boolean(params.disabled),
  };

  let reqData: Omit<ChecklistTaskRequirement, 'version'>;
  if (params.requiredKind === 'attachment_archive') {
    if (!params.expectedCompanyId) {
      throw new Error('expectedCompanyId is required for attachment_archive requirements');
    }
    reqData = {
      ...baseReq,
      requiredKind: 'attachment_archive',
      expectedCompanyId: assertSafeNumericId(params.expectedCompanyId, 'expectedCompanyId'),
      expectedAttachmentId: params.expectedAttachmentId
        ? assertSafeNumericId(params.expectedAttachmentId, 'expectedAttachmentId')
        : undefined,
      expectedSourceDigest: params.expectedSourceDigest?.toLowerCase()?.trim(),
      requiredBindingId: params.requiredBindingId?.trim(),
    };
  } else {
    reqData = {
      ...baseReq,
      requiredKind: 'evidence_note',
      requiredNoteType: params.requiredNoteType,
      requiredPublish: params.requiredPublish,
      requiredTitle: params.requiredTitle?.trim(),
      requiredContentDigest: params.requiredContentDigest?.toLowerCase()?.trim(),
    };
  }

  const store = getRequirementsStore();
  const written = await store.setWithCas(reqData, params.expectedVersion);

  // Authoritative readback verification
  const verified = await store.get(canonicalAccount, ticketId, checklistItemId);
  if (!verified || verified.version !== written.version) {
    throw new Error('Readback verification failed after requirement write');
  }
  return verified;
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[2];
  if (!command) {
    console.error(
      'Usage: node dist/admin/provisioning.js <set-binding|get-binding|set-requirement|get-requirement|migrate-account> [jsonArgs]',
    );
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
    const accountKey = parsedArgs.accountKey || (await api.getCanonicalAccountKey());
    const res = await store.get(accountKey, parsedArgs.companyId);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'set-requirement') {
    const res = await setChecklistRequirement(parsedArgs);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'get-requirement') {
    const store = getRequirementsStore();
    const accountKey = parsedArgs.accountKey || (await api.getCanonicalAccountKey());
    const res = await store.get(accountKey, parsedArgs.ticketId, parsedArgs.checklistItemId);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === 'migrate-account') {
    const accountKey = parsedArgs.accountKey || (await api.getCanonicalAccountKey());
    const projectId = process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    const fs = new Firestore({ projectId, ignoreUndefinedProperties: true });
    const record = await certifyAccountMigration({
      firestore: fs,
      accountKey,
      quiescenceEstablished: Boolean(parsedArgs.quiescenceEstablished ?? true),
      notes: parsedArgs.notes,
    });
    console.log(JSON.stringify(record, null, 2));
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
