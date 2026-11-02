# Changelog
## 0.5.0 (2026-11-01) - Provisioning Fifth Repair: Boundary, State Ordering, and Strict Authority

Comprehensive remediation of P1 and P2 findings from `AuditAutotaskFourth` per specification `PlanAutotaskFifthRepair`.

### Slice 1: Boundary and Transport
- **Continuation Route Hardening:** Fixed read-only continuation bypass in `get-next-page` and `api.getPage` by requiring explicit collection context and strict validation against `querySchema` (no `.passthrough()`, rejecting arbitrary mutation fields).
- **Canonical Route Resolver:** Introduced `resolveCanonicalRoute` and updated `classifyRouteMutation` in `src/provisioning/dispatch.ts`. Correctly exempts documented query routes (e.g. `POST V1.0/TicketNotes/query`) while strictly classifying mutations regardless of query strings or suffixes.
- **Mandatory Dispatch Permits:** Required `permitToken` in `singleDispatchMutation` and `uploadPreparedOnce`, removing `armBeforeFetch`.
- **Application Deadlines:** Added server-owned 15-second timeouts to ordinary API execution, stream readers, and `Semaphore.acquire` concurrency slot waiting.
- **Error Sanitization:** Fixed `$1` regex value-copy bug in `sanitizeErrorMessage` in `src/safe-errors.ts`.

### Slice 2: State and Identity
- **Schema Version 3:** Upgraded records to schema version 3 in `src/provisioning/contracts.ts` with strict, non-optional receipt discriminants and full `PreparedRequest` contracts.
- **Firestore Transaction Reordering:** Fixed read-after-write defects in `markVerified`, `markObservationOnly`, and `markUncertain` in `src/provisioning/operation-store.ts`, ensuring all reads precede any writes.
- **Actor and Target Intent Binding:** Incorporated actor and target into `computeIntentSha256` and immutable replay checks.
- **Quiescent Migration:** Removed automatic empty-store certification from `src/provisioning/account.ts`, requiring explicit administrative migration with established quiescence.
- **Authoritative Stdio Identity:** Bound stdio identity to authoritative Resource lookup, passing verified actor into wire impersonation headers.

### Slice 3: Policy and Administration
- **Live Item & Company Verification:** Updated `src/admin/provisioning.ts` to verify company existence and checklist item names directly against Autotask, deriving unredacted task semantic fingerprints.
- **Administrative Commands:** Added `get-requirement` and `migrate-account` commands to `src/admin/provisioning.ts`.

### Slice 4: Archive
- **Attachment Metadata Typing:** Imported and runtime-validated `AttachmentMetadata` via `decodeAttachmentMetadata`.
- **Frozen Multipart Bytes:** Froze multipart body before arming in `src/tools/attachments.ts` and `src/archive/drive.ts`, binding permit digestion to exact multipart bytes buffer.
- **Credential Margin:** Enforced safety margin on freshly minted IAM tokens in `src/archive/credentials.ts`.
- **Strict Image Signatures:** Enforced standard magic header checks for PNG, JPEG, GIF, and WebP in `src/tools/attachments.ts`.

### Slice 5: Ticket Automation
- **Unified Resolution Markers:** Unified format `[op:<id>]` and counting logic, reusing frozen timestamp and composed line across retries.
- **Server-Generated Note Markers:** Generated unique server nonces `[op:<id>:d:<nonce>]` for causal finality, verifying exact title, description, noteType, publish, and attribution.
- **Discriminated Checklist Requirements:** Enforced all fields of `ArchivedPdfRequirement` and `RecordedNoteRequirement`.
- **Strict Settlement Validation:** Validated documented `OperationResultModel.itemId` on checklist PATCH responses and enforced strict boolean readback.

### Slice 6: Proof and Test Support
- **Harness Fixes:** Closed unclosed `it` blocks in `tests/provisioning-evidence.test.ts` and replaced stale `requestLog` references.
- **Mirror Authorization:** Added bearer and scope checks to `DriveMirror` and `GoogleCredentialsMirror`, returning 404 for unseeded folders and 409 for duplicate file IDs.
- **HTTP Proof Configuration:** Updated `provisioning-http.ts` to seed `autotask_mcp_oauth_tokens`, set `AUTOTASK_BASE_URL`, and spawn `node dist/index.js`.

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
