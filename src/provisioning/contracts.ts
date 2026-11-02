/**
 * Shared provisioning evidence and operation contracts (Slice A1 redesign).
 * Based on planner spec agent://PlanAutotaskFourthRepair.
 */

export interface Actor {
  email: string; // normalized lowercase verified identity
  resourceId: number; // positive safe-integer resource ID
}

export type OperationKind =
  | 'resolution_append'
  | 'evidence_note'
  | 'checklist_set'
  | 'attachment_archive';

export type OperationPhase =
  | 'preparing'
  | 'prepared'
  | 'dispatching'
  | 'verified'
  | 'uncertain'
  | 'conflict'
  | 'rejected';

export interface Claim {
  accountKey: string;
  ticketId: string;
  operationKey: string;
  intentSha256: string;
  attemptId: string;
  fence: number;
  expiresAt: number;
  mode: 'preparing' | 'reconciling';
}

export interface PreparedRequest {
  provider: 'autotask' | 'google-drive';
  canonicalRoute: string;
  method: 'POST' | 'PATCH' | 'PUT';
  exactBodyDigest: string;
  requiredAttribution?: string;
  policyFingerprint?: string;
  preparedSha256: string;
  frozenParameters: Record<string, unknown>;
}

export interface DispatchIdentity {
  dispatchId: string;
  operationKey: string;
  intentSha256: string;
  preparedSha256: string;
  requestSha256: string;
  policyFingerprint?: string;
  originalAttemptId: string;
  originalFence: number;
  armedAt: number;
}

export interface AttachmentMetadata {
  ticketId: string;
  attachmentId: string;
  companyId: string;
  filename: string;
  mimeType: 'application/pdf';
  byteLength: number;
  sha256: string;
}

export interface PrivateAttachment {
  metadata: AttachmentMetadata;
  bytes: Buffer;
}

export interface CompanyArchiveBinding {
  accountKey: string;
  companyId: string;
  driveId: string;
  folderId: string;
  archivePrincipal: string;
  allowedActorResourceIds: number[];
  version: number;
  approvalEvidenceRef: string;
  disabled: boolean;
}

export interface ArchiveReceipt {
  operationId: string;
  status: 'verified';
  kind?: 'attachment_archive';
  source: AttachmentMetadata;
  destination: {
    provider: 'google-drive';
    driveId: string;
    folderId: string;
    fileId: string;
    mimeType?: 'application/pdf';
    byteLength: number;
    sha256: string;
    trashed?: false;
  };
  observedAt: string;
}

export interface ResolutionAppendReceipt {
  ticketID: number;
  operationId: string;
  status: 'verified';
  kind?: 'resolution_append';
  written: boolean;
  already_present: boolean;
  originalPrefixSha256?: string;
  appended_line: string;
  resolution_length_before: number;
  resolution_length_after: number;
  markerCount?: number;
  observedAt: string;
}

export interface EvidenceNoteReceipt {
  ticketID: number;
  noteID: number;
  title: string;
  operationId: string;
  status: 'verified';
  kind?: 'evidence_note';
  created: boolean;
  already_present: boolean;
  contentHash?: string;
  noteType?: number;
  publish?: number;
  markerCount?: number;
  attribution?: string;
  observedAt: string;
}

export interface ChecklistSetReceipt {
  ticketID: number;
  checklistItemID: number;
  operationId: string;
  status: 'verified';
  kind?: 'checklist_set';
  isCompleted: boolean;
  semanticFingerprint?: string;
  requirementVersion?: number;
  evidenceOperationId?: string;
  evidenceReceiptId?: string;
  evidenceVerified: boolean;
  mutationSent?: boolean;
  finalityBasis?: 'settled_original_mutation' | 'exact_causal_effect' | 'observation_only';
  position?: number | null;
  completedDateTime?: string | null;
  completedByResourceID?: number | null;
  itemName?: string;
  already_in_state?: boolean;
  updated?: boolean;
  observedAt: string;
}

export type OperationReceipt =
  | ArchiveReceipt
  | ResolutionAppendReceipt
  | EvidenceNoteReceipt
  | ChecklistSetReceipt;

/**
 * Immutable caller intent.
 * MUST NOT contain generated timestamps or allocated resource IDs.
 */
export interface OperationIntent {
  version: 1 | 2;
  accountKey: string;
  operationId: string;
  operationKey?: string;
  actor: Actor;
  kind: OperationKind;
  ticketId: string; // canonical numeric string without leading zeros
  targetId?: string;
  intentSha256: string;
  payload: Record<string, unknown>; // pure user-supplied parameters only
  preparedState?: Record<string, unknown>; // write-once preparation
  preparedRequest?: PreparedRequest;
  dispatch?: DispatchIdentity;
  phase: OperationPhase;
  createdAt: number;
  updatedAt: number;
  dispatchedAt?: number;
  completedAt?: number;
  receipt?: OperationReceipt | Record<string, unknown>;
  error?: string;
}

export interface TicketCoordinator {
  accountKey: string;
  ticketId: string;
  fence: number; // monotonic high-water mark, preserved across releases
  lease?: {
    attemptId: string; // random UUID per preparation attempt
    expiresAt: number;
    owner: string;
  } | null;
  activeDispatch?: {
    dispatchId?: string;
    operationKey: string;
    attemptId: string;
    operationId: string;
    intentSha256: string;
    preparedSha256?: string;
    requestSha256?: string;
    policyFingerprint?: string;
    dispatchedAt: number;
  } | null;
}
