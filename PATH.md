# Thin Provisioning Path Specification

**Status:** Defined and implemented (Slice 7 Integration).

## 1. Goal and Single Thin Path

An authenticated operator or MCP client initiates digital ticket evidence provisioning:
1. Archives a verified PDF attachment to an approved customer Google Shared Drive folder.
2. Reads back and verifies affirmative destination folder, single parent, Shared Drive ID, non-trashed state, file size, and SHA-256 digest, returning an exact `ArchiveReceipt`.
3. Records an evidence note on the Autotask ticket referencing the operation and unique marker `[op:<id>]`, returning an exact `EvidenceNoteReceipt`.
4. Marks the ticket checklist item completed only after revalidating the mandatory, server-owned checklist requirement against the verified evidence operation, returning an exact `ChecklistSetReceipt` with `finalityBasis: "settled_original_mutation"`.

## 2. Command-Line Entry Point

In an environment with the official Firestore emulator running and vendor mirrors listening:

```bash
npm run proof:provisioning-http
```

Equivalent direct invocation:

```bash
tsx tests/proof/provisioning-http.ts
```

## 3. Grounding and Evidence Boundaries

| Dimension | Grounded Source | Boundary / Containment |
|---|---|---|
| Autotask API Routes & Result Shapes | `spec/autotask-swagger-v1.json` and committed models (`OperationResultModel`, `TicketNotes`, `ChecklistItems`) | Evaluated against `AutotaskMirror` with arrival/applied journals. |
| Google Drive API v3 | Google Drive REST API v3 specification for multipart upload and files metadata | Evaluated against `DriveMirror` enforcing Shared Drive, non-trash, and `canAddChildren`. |
| Google Cloud IAM Credentials | Google Cloud IAM `generateAccessToken` API | Ephemeral token acquisition evaluated against `GoogleCredentialsMirror`. |
| Customer Shared Drive Association | Privileged administration CAS in `src/admin/provisioning.ts` | Stored in Firestore `autotask_mcp_archive_bindings` with required `expectedVersion`. |
| Server-Owned Checklist Requirements | Mandatory requirements store in `src/provisioning/requirements.ts` | Stored in Firestore `autotask_mcp_checklist_requirements`. Missing/disabled requirements fail closed. |
| Unavailable Live Evidence | Production customer tenant credentials and live write access | Live writes are strictly embargoed under the mirror-universe policy. No live tickets or Drive folders are touched. |

## 4. Verification Scenarios Exercised

1. **Fresh Positive Path:** PDF archive -> evidence note -> checklist completion across real HTTP transport.
2. **Idempotent Retry:** Identical retries return existing receipts without second mutations or duplicate records.
3. **Contended Lease Waiter:** Concurrent processes serialize via coordinator lease; verified waiter releases lease immediately without running heartbeat.
4. **Applied-But-Response-Lost Recovery:** Network drop after upload leaves operation `uncertain`; reconciliation recovers verified state without re-upload.
5. **Ambiguous Checklist Equality:** Pre-existing boolean true state cannot settle uncertain PATCH; records observation-only receipt (`finalityBasis: "observation_only"`).
6. **Protected Route Admission:** Generic entity updates attempting to mutate ticket resolution, notes, or checklist items without single-dispatch permit are refused at the network boundary.
7. **Requirement CAS:** Concurrent administrative updates enforce server-assigned sequential revisions.
