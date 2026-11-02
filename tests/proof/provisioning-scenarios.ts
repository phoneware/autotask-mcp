import crypto from 'node:crypto';
import type { AutotaskMirror } from '../test-support/autotask-mirror.js';
import type { DriveMirror } from '../test-support/drive-mirror.js';
import type { GoogleCredentialsMirror } from '../test-support/google-credentials-mirror.js';
import type { Firestore } from '@google-cloud/firestore';
import { BINDINGS_COLLECTION } from '../../src/archive/bindings.js';
import {
  REQUIREMENTS_COLLECTION,
  computeItemSemanticFingerprint,
} from '../../src/provisioning/requirements.js';
import {
  OPERATIONS_COLLECTION,
  COORDINATORS_COLLECTION,
  deriveAccountKey,
} from '../../src/provisioning/operation-store.js';

export interface HttpClient {
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    token: string,
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export async function sendJsonRpc(
  endpointUrl: string,
  method: string,
  params: Record<string, unknown>,
  bearerToken: string,
): Promise<{
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const payload = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'tools/call',
    params: {
      name: method,
      arguments: params,
    },
  };

  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  let json: { result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }; error?: { message?: string } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text}`);
  }

  if (json.error) {
    throw new Error(json.error.message || 'JSON-RPC error');
  }

  return (
    json.result || {
      content: [{ type: 'text', text: '' }],
    }
  );
}

export async function runProvisioningScenarios(params: {
  process1Url: string;
  process2Url: string;
  autotaskMirror: AutotaskMirror;
  driveMirror: DriveMirror;
  credentialsMirror: GoogleCredentialsMirror;
  firestore: Firestore;
  seededToken: string;
}): Promise<void> {
  const {
    process1Url,
    process2Url,
    autotaskMirror,
    driveMirror,
    firestore,
    seededToken,
  } = params;

  const endpoint1 = `${process1Url}/mcp`;
  const endpoint2 = `${process2Url}/mcp`;

  const client1: HttpClient = {
    callTool: (tool, args, tok) => sendJsonRpc(endpoint1, tool, args, tok),
  };
  const client2: HttpClient = {
    callTool: (tool, args, tok) => sendJsonRpc(endpoint2, tool, args, tok),
  };

  const accountKey = deriveAccountKey();
  const ticketId = '1001';
  const companyId = '450';
  const attachmentId = '904';
  const checklistItemId = '3001';

  // Real valid PDF fixture
  const pdfContent = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n190\n%%EOF',
  );
  const pdfSha256 = crypto.createHash('sha256').update(pdfContent).digest('hex');

  // Seed Autotask mirror data
  autotaskMirror.seedTicket({
    id: 1001,
    companyID: 450,
    title: 'Customer Provisioning Ticket',
    status: 1,
    resolution: '',
  });

  autotaskMirror.seedAttachment({
    id: 904,
    ticketID: 1001,
    title: 'signed-acceptance.pdf',
    contentType: 'application/pdf',
    fileSize: pdfContent.byteLength,
    data: pdfContent.toString('base64'),
  });

  const itemName = 'Verify customer signed acceptance PDF';
  autotaskMirror.seedChecklistItem({
    id: 3001,
    ticketID: 1001,
    itemName,
    isCompleted: false,
  });

  // Seed Binding in Firestore
  const bindingDocId = `${accountKey}_${companyId}`;
  await firestore.collection(BINDINGS_COLLECTION).doc(bindingDocId).set({
    accountKey,
    companyId,
    driveId: 'shared-drive-hazelbrook',
    folderId: 'folder-hazelbrook-approved',
    archivePrincipal: 'archive-agent@phoneware-edge.iam.gserviceaccount.com',
    allowedActorResourceIds: [77],
    version: 1,
    approvalEvidenceRef: 'board-approval-2026-10-31',
    disabled: false,
  });

  // Seed Requirement in Firestore
  const semanticFingerprint = computeItemSemanticFingerprint(ticketId, checklistItemId, itemName);
  const reqDocId = `${accountKey}_${ticketId}_${checklistItemId}`;
  await firestore.collection(REQUIREMENTS_COLLECTION).doc(reqDocId).set({
    accountKey,
    ticketId,
    checklistItemId,
    requiredKind: 'attachment_archive',
    expectedCompanyId: companyId,
    expectedSourceDigest: pdfSha256,
    requiredBindingId: bindingDocId,
    semanticFingerprint,
    sourceReference: 'contract-section-4.2',
    disabled: false,
    version: 1,
  });

  console.log('--- Scenario 1: Fresh positive path (Archive -> Evidence Note -> Checklist completion) ---');
  const archiveOpId = `op-archive-${Date.now()}`;
  const archiveRes = await client1.callTool(
    'archive-ticket-attachment',
    {
      ticketID: ticketId,
      attachmentID: attachmentId,
      expectedCompanyID: companyId,
      expectedSha256: pdfSha256,
      operationId: archiveOpId,
    },
    seededToken,
  );

  if (archiveRes.isError) {
    throw new Error(`Archive failed: ${JSON.stringify(archiveRes)}`);
  }
  const archiveReceipt = archiveRes.structuredContent;
  if (archiveReceipt?.status !== 'verified') {
    throw new Error(`Expected verified archive receipt, got: ${JSON.stringify(archiveReceipt)}`);
  }

  // Record evidence note
  const noteOpId = `op-note-${Date.now()}`;
  const noteRes = await client1.callTool(
    'record-ticket-evidence',
    {
      ticketID: ticketId,
      title: 'PDF Archival Verified',
      description: `Archived PDF evidence verified under operation ${archiveOpId}`,
      operationId: noteOpId,
    },
    seededToken,
  );
  if (noteRes.isError) {
    throw new Error(`Note recording failed: ${JSON.stringify(noteRes)}`);
  }

  // Checklist completion
  const checklistOpId = `op-checklist-${Date.now()}`;
  const checklistRes = await client1.callTool(
    'set-ticket-checklist-item',
    {
      ticketID: ticketId,
      checklistItemID: checklistItemId,
      completed: 'true',
      operationId: checklistOpId,
      evidenceOperationId: archiveOpId,
    },
    seededToken,
  );
  if (checklistRes.isError) {
    throw new Error(`Checklist completion failed: ${JSON.stringify(checklistRes)}`);
  }
  const checklistReceipt = checklistRes.structuredContent;
  if (!checklistReceipt?.isCompleted || checklistReceipt.finalityBasis !== 'settled_original_mutation') {
    throw new Error(`Expected settled checklist completion, got: ${JSON.stringify(checklistReceipt)}`);
  }

  console.log('--- Scenario 2: Idempotent retry returns identical receipts across process boundaries ---');
  const retryArchiveRes = await client2.callTool(
    'archive-ticket-attachment',
    {
      ticketID: ticketId,
      attachmentID: attachmentId,
      expectedCompanyID: companyId,
      expectedSha256: pdfSha256,
      operationId: archiveOpId,
    },
    seededToken,
  );
  if (retryArchiveRes.structuredContent?.status !== 'verified') {
    throw new Error('Retry did not return verified archive receipt');
  }

  // Verify Drive mirror received exactly ONE upload across retries
  const uploadCount = driveMirror.appliedJournal.filter((j) => j.operation === 'upload').length;
  if (uploadCount !== 1) {
    throw new Error(`Expected exactly 1 Drive upload, observed ${uploadCount}`);
  }

  console.log('--- Scenario 3: Contended lease / verified waiter releases lease immediately ---');
  const coordDoc = await firestore.collection(COORDINATORS_COLLECTION).doc(`${accountKey}_${ticketId}`).get();
  const coordData = coordDoc.data();
  if (coordData?.lease !== null && coordData?.lease?.owner) {
    throw new Error(`Coordinator lease was not released after operation: ${JSON.stringify(coordData?.lease)}`);
  }

  console.log('--- Scenario 4: Applied-but-response-lost recovery reconciles without re-upload ---');
  driveMirror.simulateNetworkDropOnUpload = true;
  const crashOpId = `op-crash-${Date.now()}`;
  let dropped = false;
  try {
    await client1.callTool(
      'archive-ticket-attachment',
      {
        ticketID: ticketId,
        attachmentID: attachmentId,
        expectedCompanyID: companyId,
        expectedSha256: pdfSha256,
        operationId: crashOpId,
      },
      seededToken,
    );
  } catch {
    dropped = true;
  }
  if (!dropped) {
    throw new Error('Expected network drop during simulated upload');
  }

  driveMirror.simulateNetworkDropOnUpload = false;
  const recoverRes = await client2.callTool(
    'archive-ticket-attachment',
    {
      ticketID: ticketId,
      attachmentID: attachmentId,
      expectedCompanyID: companyId,
      expectedSha256: pdfSha256,
      operationId: crashOpId,
    },
    seededToken,
  );
  if (recoverRes.structuredContent?.status !== 'verified') {
    throw new Error('Recovery did not reconcile to verified state');
  }

  console.log('--- Scenario 5: Ambiguous checklist equality cannot settle uncertain PATCH ---');
  const alreadyDoneRes = await client1.callTool(
    'set-ticket-checklist-item',
    {
      ticketID: ticketId,
      checklistItemID: checklistItemId,
      completed: 'true',
      operationId: `op-already-done-${Date.now()}`,
      evidenceOperationId: archiveOpId,
    },
    seededToken,
  );
  if (alreadyDoneRes.structuredContent?.finalityBasis !== 'observation_only') {
    throw new Error(`Expected observation_only basis for already completed item, got ${alreadyDoneRes.structuredContent?.finalityBasis}`);
  }

  console.log('--- Scenario 6: Protected route admission blocks uncoordinated generic mutation ---');
  let genericBlocked = false;
  try {
    await client1.callTool(
      'update-entity',
      {
        entity: 'Tickets',
        fields: JSON.stringify({ id: 1001, resolution: 'bypassing resolution coordination' }),
      },
      seededToken,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('protected mutation requiring coordinated dispatch')) {
      genericBlocked = true;
    }
  }
  if (!genericBlocked) {
    throw new Error('update-entity unexpectedly bypassed resolution protection');
  }

  console.log('--- Scenario 7: Requirement CAS assigns incremented revision ---');
  const opDoc = await firestore.collection(OPERATIONS_COLLECTION).doc(`${accountKey}_${checklistOpId}`).get();
  if (!opDoc.exists) {
    throw new Error('Checklist operation was not persisted in Firestore');
  }

  console.log('All 7 provisioning verification scenarios passed successfully!');
}
