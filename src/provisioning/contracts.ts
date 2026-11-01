/**
 * Shared provisioning evidence and operation contracts (Slice A1 redesign).
 * Based on planner spec agent://PlanAutotaskSecondRepair.
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
  | 'prepared'
  | 'dispatching'
  | 'verified'
  | 'uncertain'
  | 'conflict'
  | 'rejected';

/**
 * Immutable caller intent.
 * MUST NOT contain generated timestamps or allocated resource IDs.
 */
export interface OperationIntent {
  version: 1;
  accountKey: string;
  operationId: string;
  actor: Actor;
  kind: OperationKind;
  ticketId: string; // canonical numeric string without leading zeros
  targetId?: string;
  intentSha256: string;
  payload: Record<string, unknown>; // pure user-supplied parameters only
  preparedState?: Record<string, unknown>; // generated once during preparation
  phase: OperationPhase;
  createdAt: number;
  updatedAt: number;
  dispatchedAt?: number;
  completedAt?: number;
  receipt?: Record<string, unknown>;
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
    operationKey: string;
    attemptId: string;
    operationId: string;
    intentSha256: string;
    dispatchedAt: number;
  } | null;
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
  source: AttachmentMetadata;
  destination: {
    provider: 'google-drive';
    driveId: string;
    folderId: string;
    fileId: string;
    byteLength: number;
    sha256: string;
  };
  observedAt: string;
}

export interface ResolutionAppendReceipt {
  ticketID: number;
  operationId: string;
  status: 'verified';
  written: boolean;
  already_present: boolean;
  appended_line: string;
  resolution_length_before: number;
  resolution_length_after: number;
  observedAt: string;
}

export interface EvidenceNoteReceipt {
  ticketID: number;
  noteID: number;
  title: string;
  operationId: string;
  status: 'verified';
  created: boolean;
  already_present: boolean;
  observedAt: string;
}

export interface ChecklistSetReceipt {
  ticketID: number;
  checklistItemID: number;
  operationId: string;
  status: 'verified';
  isCompleted: boolean;
  evidenceOperationId?: string;
  evidenceVerified: boolean;
  observedAt: string;
}
