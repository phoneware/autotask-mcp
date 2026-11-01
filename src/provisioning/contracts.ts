/**
 * Shared provisioning evidence and operation contracts (Slice A1).
 * Based on planner spec agent://PlanAutotaskTransferSafety.
 */

export interface Actor {
  email: string;
  resourceId: number;
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

export interface OperationIntent {
  version: 1;
  accountKey: string;
  operationId: string;
  actor: Actor;
  kind: OperationKind;
  ticketId: string;
  targetId?: string;
  intentSha256: string;
  payload: Record<string, unknown>;
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
  fence: number; // monotonic high-water mark, never reset
  lease?: {
    attemptId: string; // random UUID per attempt
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
