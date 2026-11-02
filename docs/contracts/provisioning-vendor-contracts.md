# Provisioning Vendor Contracts and Boundary Assertions

This document records the grounded vendor contracts, wire formats, and evidence classifications governing the Autotask MCP digital provisioning pipeline.

## 1. Evidence Classification

| Category | Definition | Repository Artifacts |
|---|---|---|
| **Primary Sources** | Authoritative upstream documentation, specifications, and client libraries. | `spec/autotask-swagger-v1.json`, Google Drive v3 REST API documentation, Google Cloud IAM REST API reference. |
| **Sanitized Captures** | Redacted wire captures of actual Autotask API and Drive API response structures. | Ticket models, `OperationResultModel`, zone discovery payloads, Drive metadata schemas. |
| **Fixture Assumptions** | Synthetic fixtures used for deterministic offline test execution. | Raster magic headers (PNG/JPEG), valid PDF byte fixtures, local mirror journals. |
| **Unavailable Evidence** | Live external assertions that cannot be proven without executing against production. | Live customer folder authorization, live Google ADC serving principal, production ticket completion finality. |

## 2. Autotask API Contracts

### 2.1 Route Scoping and Parent Anchoring
- **Checklist Items:** Addressed as child resources under tickets: `GET /V1.0/Tickets/{ticketId}/ChecklistItems/{itemId}` and `PATCH /V1.0/Tickets/{ticketId}/ChecklistItems`. The server validates that returned items have matching `ticketID`.
- **Ticket Notes:** Addressed as `POST /V1.0/Tickets/{ticketId}/Notes` and `GET /V1.0/Tickets/{ticketId}/Notes/{noteId}`. Querying uses `POST /V1.0/TicketNotes/query` with `filter: [{ op: 'eq', field: 'ticketID', value: ticketId }]`.
- **Ticket Resolution:** Addressed as `PATCH /V1.0/Tickets` with `{ id: ticketId, resolution: string }`.
- **Response Format:** Create and update operations return `OperationResultModel` carrying `itemId` or wrapped `{ item: { id } }`.

### 2.2 Protected Mutation Admission
Generic entity update/create/delete tools (`update-entity`, `create-entity`, `delete-entity`) and promoted actions cannot mutate protected entities (resolution fields on `Tickets`, any mutation on `TicketNotes`, `TicketChecklistItems`, or deletion of `Tickets`) without consuming a module-private single-use dispatch permit.

## 3. Google Drive API v3 Contracts

### 3.1 Destination Verification
- Destination folders must reside within an approved Google Shared Drive (`driveId` present and matching binding).
- Folders must be verified:
  - `mimeType === 'application/vnd.google-apps.folder'`
  - `trashed === false` (strictly enforced, not undefined)
  - `capabilities.canAddChildren === true` (strictly affirmative)

### 3.2 File Archival and Verification
- Uploads use multipart related upload (`POST /upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`).
- Readback verification requires:
  - `parents.length === 1` and `parents[0] === folderId`
  - `driveId === binding.driveId`
  - `mimeType === 'application/pdf'`
  - `trashed === false`
  - Computed SHA-256 matches source attachment digest.
- Verification uses streaming bounded readers (5 MB ceiling for media, 256 KB for metadata).

## 4. Google Cloud IAM Credentials Contracts

- Ephemeral Drive tokens are minted via `POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{principal}:generateAccessToken`.
- Requests specify `scope: ['https://www.googleapis.com/auth/drive']` and `lifetime: '3600s'`.
- Responses return `accessToken` and ISO-8601 `expireTime`. Tokens are cached only by principal and scope, and refreshed when remaining validity is less than 5 minutes.
- Static tokens and unauthenticated fallback modes are strictly disabled in production.

## 5. Server-Owned Checklist Requirements

Checklist completion requires a verified evidence operation and an enabled server-owned requirement:
- **Archived PDF Requirement (`attachment_archive`):** Requires verified `ArchiveReceipt`, expected company ID, expected SHA-256 digest, active binding, and affirmative Drive readback.
- **Recorded Note Requirement (`evidence_note`):** Requires verified `EvidenceNoteReceipt`, note existence on ticket, and unique marker `[op:<id>]`.
- If a requirement is missing or disabled, checklist completion fails closed.
