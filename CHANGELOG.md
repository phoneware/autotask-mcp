# Changelog

## 0.4.1 (2026-11-01) - Comprehensive Provisioning Fourth Repair

Remediation of P1 and P2 findings from `ReviewAutotaskArchive` and `ReviewAutotaskReliability` per specification `PlanAutotaskFourthRepair`.

### Slice 1: Core Identity, State, and Lifecycle
- **Canonical Numeric IDs:** Normalized numeric ID handling in `src/security.ts` to return canonical numeric strings (`String(n)`), eliminating leading zeros across hashing, persistence, and readback.
- **Canonical Account Derivation:** Added `src/provisioning/account.ts` deriving canonical account key strictly from integration username and parsed effective Autotask zone URL. Rejects invalid URLs instead of hashing fallback strings. Enforces migration gate before writes.
- **Discriminated Records (Version 2):** Introduced typed version 2 discriminated records in `src/provisioning/contracts.ts` and `src/provisioning/operation-store.ts`. Added exact receipt schemas for archive, evidence note, resolution append, and checklist set operations.
- **Transactional State Invariants:**
  - In `operation-store.ts`, forbidden `uncertain -> prepared` transition. Reconciliation claims cannot commit preparation. Enforced write-once equality for prepared state.
  - In `armDispatch`, enforced exact `prepared` phase, lease fencing, and transactional verification of authoritative binding policy and revision. Installed atomic `activeDispatch` barriers.
  - In `markVerified`, required matching claim ownership, unexpired lease, and original dispatch identity. Atomic clearance of only the matching dispatch barrier.
  - In `markObservationOnly`, enforced that observation-only finalization requires no active dispatch barrier and unexpired claim (`mutationSent: false`).
- **Scoped Lease Lifetime:** Implemented `withTicketOperation` in `src/provisioning/ticket-coordinator.ts`, enclosing acquisition, heartbeat startup, and guaranteed release on every exit path. Verified waiters return without acquiring claims or starting heartbeats.
- **Strict Actor Identity:** Updated `src/http.ts` `callerFrom()` to reject blank emails and non-positive safe integer resource IDs with 401. Added `resolveActorOrThrow()` in `src/auth/context.ts` refusing `autotask-mcp` or resource `0` fallbacks across stdio and HTTP.

### Slice 2: Shared Dispatch and Bounded Transport
- **Universal Dispatch Admission:** Added `src/provisioning/dispatch.ts` issuing module-private, single-use `DispatchPermitToken` backed by WeakMap. Classified protected mutation routes (resolution updates, notes, checklist items, ticket deletion, Drive uploads). Uncoordinated generic tools calling protected routes are refused at the network boundary.
- **Bounded Stream Reading:** Added `src/bounded-response.ts` enforcing technical response ceilings on streamed bytes before parsing (Autotask JSON: 7 MB; PDF/media: 5 MB; images: 3 MB; IAM JSON: 64 KB; Drive metadata: 256 KB). Added incremental media streaming hash.
- **Safe Error Reporting:** Added `src/safe-errors.ts` sanitizing error messages and scrubbing raw upstream response bodies, authorization tokens, file paths, and secret canaries.

### Slice 3: Authoritative Policy and Privileged Administration
- **Required Revision CAS:** Updated `src/archive/bindings.ts` and `src/provisioning/requirements.ts` to require `expectedVersion` (0 for create-only). Server assigns sequential incremented revisions inside transactions.
- **Mandatory Server-Owned Requirements:** Implemented discriminated requirements (`ArchivedPdfRequirement`, `RecordedNoteRequirement`) and semantic fingerprinting (`computeItemSemanticFingerprint`).
- **Administrative CLI Entrypoint:** Updated `src/admin/provisioning.ts` with strict argument validation, transactional CAS, and exact ESM entrypoint detection.

### Slice 4: Credentials, Attachment Validation, and Archival
- **Strict Credential Lifecycle:** Updated `src/archive/credentials.ts` to acquire ephemeral Google Cloud ADC -> IAM credentials bound to principal and scope, enforcing valid `expireTime` without static tokens or unauthenticated localhost fallbacks.
- **Attachment Envelope and Size Integrity:** Updated `src/archive/source.ts` `unwrapSingleAttachment` to reject multi-record direct item envelopes. Enforced positive safe integer declared sizes matching decoded bytes, and validated file attachment semantics.
- **Affirmative Destination Verification:** Updated `src/archive/drive.ts` `preflightDestination` and `verifyDriveFile` to require affirmative folder ID, folder MIME, Shared Drive ID, `trashed === false`, and `capabilities.canAddChildren === true`. Revalidates destination folder during recovery.
- **Strict Raster Validation:** Removed non-PDF fallback in `src/tools/attachments.ts` `isVerifiedImageBytes`, enforcing exact magic headers for PNG, JPEG, GIF, and WebP.

### Slice 5: Exact Note, Resolution, and Checklist Automation
- **Coordinated Note Tools:** Unified note creation through `recordTicketEvidenceHandler`, requiring `operationId` and verified caller. Enforced complete envelope validation across pagination and exact content/marker multiplicity readback.
- **Exact Resolution Append:** Required `operationId` in `append-ticket-resolution`, committing original prefix hash, exact separator block, and unique marker count.
- **Grounded Checklist Completion:** Removed `evidenceNoteID` and raw bypass arguments. Required `evidenceOperationId`, validating server-owned requirements and re-verifying underlying evidence in Drive/notes. Handled already-true items via observation-only path.

### Slice 6: Faithful Mirrors and Independent Behavioral Proof
- **Enhanced Test Mirrors:** Updated `AutotaskMirror` and `DriveMirror` with separate arrival/applied journals and fault injection hooks. Added `GoogleCredentialsMirror`.
- **Contained Two-Process HTTP Proof:** Added `tests/proof/provisioning-scenarios.ts` and `tests/proof/provisioning-http.ts` exercising seven independent scenarios across two spawned server processes, vendor mirrors, and Firestore emulator with real HTTP authentication.
- **Updated Test Suites:** Updated `tests/provisioning-evidence.test.ts`, `tests/ticket-writes.test.ts`, and `tests/attachments.test.ts` to align with coordinated contracts.

### Slice 7: Integration, Packaging, and Evidence Record
- **Direct Dependencies:** Declared `google-auth-library` (`^10.5.0`) directly in `package.json` and `package-lock.json`.
- **Failing Build Enforcement:** Adjusted `Dockerfile` build stage to run `npm ci --ignore-scripts` before copying sources, ensuring dependency installation cannot conceal compiler errors. Added `proof:provisioning-http` script.
- **Documentation:** Added `PATH.md` defining the single thin provisioning path, and `docs/contracts/provisioning-vendor-contracts.md` classifying primary sources, sanitized captures, fixture assumptions, and unavailable evidence. Retired `scripts/live-acceptance-proof.ts`.
