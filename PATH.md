# Thin Provisioning Path Specification

**Status:** Source repair completed under strict embargo. No builds, tests, scripts, installations, VMs, network probes, live vendor writes, or CI triggers executed. The acceptance cases below are requirements and designed behaviors, not observed test results.

## 1. Goal and Single Thin Path

An authenticated operator or MCP client initiates digital ticket evidence provisioning:
1. Archives a verified PDF attachment to an approved customer Google Shared Drive folder with frozen multipart body and exact byte digest permit binding.
2. Reads back and verifies affirmative destination folder, single parent, Shared Drive ID, non-trashed state, file size, and SHA-256 digest, returning an exact typed `ArchiveReceipt`.
3. Records an evidence note on the Autotask ticket referencing the operation and unique server-generated dispatch marker `[op:<id>:d:<nonce>]`, returning an exact typed `EvidenceNoteReceipt`.
4. Marks the ticket checklist item completed only after revalidating all discriminated fields of the mandatory server-owned checklist requirement in the arming transaction, returning an exact `ChecklistSetReceipt` with `finalityBasis: "settled_original_mutation"` based on documented `OperationResultModel.itemId`.

## 2. Command-Line Entry Point

When authorized for execution in a qualified environment with the official Firestore emulator running and vendor mirrors listening:

```bash
npm run proof:provisioning-http
```

Equivalent direct invocation:

```bash
node dist/proof/provisioning-http.js
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

## 4. Designed Acceptance Scenarios (Awaiting Qualified Execution)

These scenarios define the required regression and behavioral matrix to be executed when containment is authorized:

1. **Fresh Positive Path:** PDF archive -> evidence note -> checklist completion across compiled `node dist/index.js` HTTP processes with real bearer authentication.
2. **Idempotent Retry:** Identical retries return existing receipts without second mutations or duplicate records.
3. **Contended Lease Waiter:** Concurrent contender processes serialize via coordinator lease; verified waiter releases lease immediately without running heartbeat.
4. **Applied-But-Response-Lost Recovery:** Network drop after upload leaves operation `uncertain`; reconciliation recovers verified state without re-upload.
5. **Ambiguous Checklist Equality:** Pre-existing boolean true state cannot settle uncertain PATCH; records observation-only receipt (`finalityBasis: "observation_only"`).
6. **Protected Route Admission:** Generic entity updates attempting to mutate ticket resolution, notes, or checklist items without single-dispatch permit are refused at the canonical route boundary.
7. **Requirement CAS:** Concurrent administrative updates enforce server-assigned sequential revisions using true hashed operationKey.
