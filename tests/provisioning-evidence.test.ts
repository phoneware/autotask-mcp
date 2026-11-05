import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutotaskMirror } from './test-support/autotask-mirror.js';
import { DriveMirror } from './test-support/drive-mirror.js';
import { buildServer } from '../src/server.js';
import { ticketWriteTools } from '../src/tools/ticket-writes.js';
import { attachmentTools } from '../src/tools/attachments.js';
import { DESTRUCTIVE_TOOLS } from '../src/security.js';
import { withCaller } from '../src/auth/context.js';
import { resetApi } from '../src/autotask-api.js';
import { setOperationStore, MemoryOperationStore } from '../src/provisioning/operation-store.js';
import { setBindingsStore, MemoryBindingsStore } from '../src/archive/bindings.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('Provisioning Evidence & Transport Acceptance (Slice A1)', () => {
  let autotaskMirror: AutotaskMirror;
  let driveMirror: DriveMirror;
  let operationStore: MemoryOperationStore;
  let bindingsStore: MemoryBindingsStore;

  let savedEnv: {
    username?: string;
    secret?: string;
    code?: string;
    apiUrl?: string;
    readonly?: string;
    driveApi?: string;
    driveUpload?: string;
  };

  const appendTool = ticketWriteTools.find((t) => t.name === 'append-ticket-resolution')!;
  const checklistTool = ticketWriteTools.find((t) => t.name === 'set-ticket-checklist-item')!;
  const recordEvidenceTool = ticketWriteTools.find((t) => t.name === 'record-ticket-evidence')!;
  const getAttachmentTool = attachmentTools.find((t) => t.name === 'get-ticket-attachment')!;
  const archiveAttachmentTool = attachmentTools.find(
    (t) => t.name === 'archive-ticket-attachment',
  )!;

  const testCaller = {
    email: 'tech@phoneware.us',
    resourceId: 77,
    userType: 14,
    capabilities: ['read', 'create', 'update', 'delete'] as const,
  };

  beforeEach(async () => {
    savedEnv = {
      username: process.env.AUTOTASK_USERNAME,
      secret: process.env.AUTOTASK_SECRET,
      code: process.env.AUTOTASK_INTEGRATION_CODE,
      apiUrl: process.env.AUTOTASK_API_URL,
      readonly: process.env.AUTOTASK_READ_ONLY,
      driveApi: process.env.DRIVE_API_BASE_URL,
      driveUpload: process.env.DRIVE_UPLOAD_BASE_URL,
    };

    autotaskMirror = new AutotaskMirror();
    const atStarted = await autotaskMirror.start();

    driveMirror = new DriveMirror();
    const driveStarted = await driveMirror.start();

    process.env.AUTOTASK_USERNAME = 'tech@phoneware.us';
    process.env.AUTOTASK_SECRET = 'valid-test-secret';
    process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
    process.env.AUTOTASK_API_URL = atStarted.url;
    process.env.DRIVE_API_BASE_URL = driveStarted.baseUrl;
    process.env.DRIVE_UPLOAD_BASE_URL = driveStarted.uploadBaseUrl;
    delete process.env.AUTOTASK_READ_ONLY;

    resetApi();

    operationStore = new MemoryOperationStore();
    setOperationStore(operationStore);

    bindingsStore = new MemoryBindingsStore();
    setBindingsStore(bindingsStore);
  });

  afterEach(async () => {
    resetApi();
    await autotaskMirror.stop();
    await driveMirror.stop();
    setOperationStore(null);
    setBindingsStore(null);

    if (savedEnv.username !== undefined) process.env.AUTOTASK_USERNAME = savedEnv.username;
    else delete process.env.AUTOTASK_USERNAME;

    if (savedEnv.secret !== undefined) process.env.AUTOTASK_SECRET = savedEnv.secret;
    else delete process.env.AUTOTASK_SECRET;

    if (savedEnv.code !== undefined) process.env.AUTOTASK_INTEGRATION_CODE = savedEnv.code;
    else delete process.env.AUTOTASK_INTEGRATION_CODE;

    if (savedEnv.apiUrl !== undefined) process.env.AUTOTASK_API_URL = savedEnv.apiUrl;
    else delete process.env.AUTOTASK_API_URL;

    if (savedEnv.readonly !== undefined) process.env.AUTOTASK_READ_ONLY = savedEnv.readonly;
    else delete process.env.AUTOTASK_READ_ONLY;

    if (savedEnv.driveApi !== undefined) process.env.DRIVE_API_BASE_URL = savedEnv.driveApi;
    else delete process.env.DRIVE_API_BASE_URL;

    if (savedEnv.driveUpload !== undefined)
      process.env.DRIVE_UPLOAD_BASE_URL = savedEnv.driveUpload;
    else delete process.env.DRIVE_UPLOAD_BASE_URL;
  });

  describe('1. Logical operation deduplication and mismatch guards', () => {
    it('does not duplicate logical resolution line when retried with same operationId after clock advances', async () => {
      autotaskMirror.seedTicket({
        id: 1001,
        title: 'Hazelbrook Provisioning Ticket',
        resolution: 'Scope approved.\nInitial WAN check completed.',
      });

      // Initial execution
      const res1 = await withCaller(testCaller, () =>
        appendTool.handler({
          ticketID: '1001',
          text: 'Installed Frontier eSIM into slot A.',
          operationId: 'hazelbrook-esim-slot-a',
        }),
      );

      const parsed1 = JSON.parse(res1.content[0].text);
      expect(parsed1.written).toBe(true);
      expect(parsed1.already_present).toBe(false);
      expect(parsed1.verified).toBe(true);

      const ticketAfter1 = autotaskMirror.tickets.get(1001);
      const count1 = (
        ticketAfter1?.resolution?.match(/Installed Frontier eSIM into slot A\./g) || []
      ).length;
      expect(count1).toBe(1);

      // Clock advances / retry with same operationId
      const res2 = await withCaller(testCaller, () =>
        appendTool.handler({
          ticketID: '1001',
          text: 'Installed Frontier eSIM into slot A.',
          operationId: 'hazelbrook-esim-slot-a',
        }),
      );

      const parsed2 = JSON.parse(res2.content[0].text);
      expect(parsed2.written).toBe(false);
      expect(parsed2.already_present).toBe(true);
      expect(parsed2.reconciled_from_prior_evidence).toBe(true);
      expect(parsed2.verified).toBe(true);
      expect(parsed2.operationId).toBe('hazelbrook-esim-slot-a');

      // Crucial: no duplicate line appended in Autotask
      const ticketAfter2 = autotaskMirror.tickets.get(1001);
      const count2 = (
        ticketAfter2?.resolution?.match(/Installed Frontier eSIM into slot A\./g) || []
      ).length;
      expect(count2).toBe(1);
    });

    it('guards operationId against text mismatch', async () => {
      autotaskMirror.seedTicket({
        id: 1001,
        title: 'Hazelbrook Provisioning Ticket',
        resolution:
          'Installed Frontier eSIM into slot A. [2026-10-31 14:05 UTC, tech@phoneware.us, op:slot-a-install]',
      });

      await expect(
        withCaller(testCaller, () =>
          appendTool.handler({
            ticketID: '1001',
            text: 'Completely different text with same operationId.',
            operationId: 'slot-a-install',
          }),
        ),
      ).rejects.toThrow(
        /Conflict: operationId "slot-a-install" was previously recorded with different text/,
      );
    });

    it('does not deduplicate distinct operations based merely on identical text when distinct operation IDs are supplied', async () => {
      autotaskMirror.seedTicket({
        id: 1001,
        title: 'Hazelbrook Provisioning Ticket',
        resolution:
          'Base resolution.\nRebooted router. [2026-10-31 14:05 UTC, tech@phoneware.us, op:phase-1-reboot]',
      });

      const res = await withCaller(testCaller, () =>
        appendTool.handler({
          ticketID: '1001',
          text: 'Rebooted router.',
          operationId: 'phase-2-reboot',
        }),
      );

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.written).toBe(true);
      expect(parsed.already_present).toBe(false);
      expect(parsed.operationId).toBe('phase-2-reboot');

      const ticket = autotaskMirror.tickets.get(1001);
      const count = (ticket?.resolution?.match(/Rebooted router\./g) || []).length;
      expect(count).toBe(2);
    });

    it('reconciles prior evidence on record-ticket-evidence with operationId across retries', async () => {
      autotaskMirror.seedTicket({
        id: 1001,
        title: 'Hazelbrook Provisioning Ticket',
      });

      const res1 = await withCaller(testCaller, () =>
        recordEvidenceTool.handler({
          ticketID: '1001',
          title: 'eSIM Download Verification',
          description: 'Profile 8901260000000000000 verified active on modem 3.',
          operationId: 'op-esim-verify-1001',
        }),
      );

      const parsed1 = JSON.parse(res1.content[0].text);
      expect(parsed1.created).toBe(true);
      expect(parsed1.already_present).toBe(false);
      expect(parsed1.verified).toBe(true);
      const noteId1 = parsed1.noteID;

      // Retry
      const res2 = await withCaller(testCaller, () =>
        recordEvidenceTool.handler({
          ticketID: '1001',
          title: 'eSIM Download Verification',
          description: 'Profile 8901260000000000000 verified active on modem 3.',
          operationId: 'op-esim-verify-1001',
        }),
      );

      const parsed2 = JSON.parse(res2.content[0].text);
      expect(parsed2.created).toBe(false);
      expect(parsed2.already_present).toBe(true);
      expect(parsed2.reconciled_from_prior_evidence).toBe(true);
      expect(parsed2.noteID).toBe(noteId1);
      expect(parsed2.verified).toBe(true);

      const notes = Array.from(autotaskMirror.notes.values()).filter((n) => n.ticketID === 1001);
      expect(notes).toHaveLength(1);
    });
  });

  describe('2. Concurrent-edit uncertainty is not success', () => {
    it('refuses write and reports conflict when concurrent modification occurs between reads', async () => {
      autotaskMirror.seedTicket({
        id: 1001,
        title: 'Hazelbrook Provisioning Ticket',
        resolution: 'Base state.',
      });

      autotaskMirror.simulateConcurrentResolutionModification =
        'Base state.\nExternal tech modified resolution concurrently!';

      await expect(
        withCaller(testCaller, () =>
          appendTool.handler({
            ticketID: '1001',
            text: 'Configured AP mesh SSID.',
            operationId: 'ap-mesh-1001',
          }),
        ),
      ).rejects.toThrow(/Conflict: ticket resolution was modified concurrently between reads/);

      const current = autotaskMirror.tickets.get(1001);
      expect(current?.resolution).not.toContain('Configured AP mesh SSID.');
    });
  });

  describe('3. Wrong-parent attachment and checklist access is refused', () => {
    it('refuses checklist item update when item belongs to a different ticket', async () => {
      autotaskMirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      autotaskMirror.seedTicket({ id: 9999, title: 'Other Customer Ticket' });

      autotaskMirror.seedNote({
        id: 702,
        ticketID: 1001,
        title: 'AP adoption confirmed',
        description: 'Evidence on the valid parent ticket.',
      } as never);
      autotaskMirror.seedChecklistItem({
        id: 501,
        ticketID: 9999, // Belongs to ticket 9999
        itemName: 'Install Starlink dish',
        isCompleted: false,
      });

      await expect(
        withCaller(testCaller, () =>
          checklistTool.handler({
            ticketID: '1001',
            checklistItemID: '501',
            completed: 'true',
            evidenceNoteID: '702',
          }),
        ),
      ).rejects.toThrow(/Parent mismatch: checklist item 501 belongs to ticketID 9999, not 1001/);

      expect(autotaskMirror.checklistItems.get(501)?.isCompleted).toBe(false);
    });

    it('refuses checklist item completion when evidence is missing', async () => {
      autotaskMirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      autotaskMirror.seedChecklistItem({
        id: 502,
        ticketID: 1001,
        itemName: 'Verify throughput threshold',
        isCompleted: false,
      });

      await expect(
        withCaller(testCaller, () =>
          checklistTool.handler({
            ticketID: '1001',
            checklistItemID: '502',
            completed: 'true',
          }),
        ),
      ).rejects.toThrow(/checklist item completion requires observed evidence/);

      expect(autotaskMirror.checklistItems.get(502)?.isCompleted).toBe(false);
    });

    it('refuses checklist item completion when evidence note belongs to a different ticket', async () => {
      autotaskMirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      autotaskMirror.seedTicket({ id: 9999, title: 'Other Ticket' });

      autotaskMirror.seedChecklistItem({
        id: 503,
        ticketID: 1001,
        itemName: 'Verify AP Mesh Link',
        isCompleted: false,
      });

      autotaskMirror.seedNote({
        id: 701,
        ticketID: 9999, // Belongs to ticket 9999
        title: 'Mesh link verified',
        description: 'Operational link confirmed.',
      });

      await expect(
        withCaller(testCaller, () =>
          checklistTool.handler({
            ticketID: '1001',
            checklistItemID: '503',
            completed: 'true',
            evidenceNoteID: '701',
          }),
        ),
      ).rejects.toThrow(/Parent mismatch: evidence note 701 belongs to ticketID 9999, not 1001/);

      expect(autotaskMirror.checklistItems.get(503)?.isCompleted).toBe(false);
    });

    it('refuses attachment retrieval when attachment belongs to a different ticket', async () => {
      autotaskMirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      autotaskMirror.seedTicket({ id: 9999, title: 'Other Ticket' });

      autotaskMirror.seedAttachment({
        id: 601,
        ticketID: 9999, // Belongs to ticket 9999
        title: 'confidential.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 sample data').toString('base64'),
      });

      await expect(
        withCaller(testCaller, () =>
          getAttachmentTool.handler({
            ticketID: '1001',
            attachmentID: '601',
          }),
        ),
      ).rejects.toThrow(/Parent mismatch: attachment 601 belongs to ticketID 9999, not 1001/);
    });

    it('successfully completes checklist item when valid parent evidence note is provided', async () => {
      autotaskMirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      autotaskMirror.seedChecklistItem({
        id: 504,
        ticketID: 1001,
        itemName: 'AP series management adoption',
        isCompleted: false,
      });

      autotaskMirror.seedNote({
        id: 702,
        ticketID: 1001, // Valid parent match
        title: 'AP adoption confirmed',
        description: 'AP One AX serial 1234 adopted by B One.',
      });

      const res = await withCaller(testCaller, () =>
        checklistTool.handler({
          ticketID: '1001',
          checklistItemID: '504',
          completed: 'true',
          evidenceNoteID: '702',
        }),
      );

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.updated).toBe(true);
      expect(parsed.isCompleted).toBe(true);
      expect(parsed.evidenceVerified).toBe(true);
      expect(parsed.evidenceNoteID).toBe(702);

      expect(autotaskMirror.checklistItems.get(504)?.isCompleted).toBe(true);
    });
  });

  describe('4. Server-side PDF archive transport to approved Drive destination', () => {
    it('archives PDF to approved customer Drive folder and returns receipt metadata without exposing raw bytes', async () => {
      autotaskMirror.seedTicket({
        id: 1001,
        companyID: 450,
        title: 'Hazelbrook Provisioning Ticket',
      });

      const pdfPayload = Buffer.from(
        '%PDF-1.4\n%Hazelbrook Statement of Work and Customer Signed Acceptance\n%%EOF',
      );
      const expectedSha = crypto.createHash('sha256').update(pdfPayload).digest('hex');

      autotaskMirror.seedAttachment({
        id: 901,
        ticketID: 1001,
        title: 'hazelbrook-sow-signed.pdf',
        contentType: 'application/pdf',
        fileSize: pdfPayload.byteLength,
        data: pdfPayload.toString('base64'),
      });

      // Seed approved company archive binding
      const accountKey = crypto
        .createHash('sha256')
        .update('tech@phoneware.us\0' + autotaskMirror.baseUrl.toLowerCase().trim())
        .digest('hex')
        .slice(0, 16);

      await bindingsStore.set({
        accountKey,
        companyId: '450',
        driveId: 'shared-drive-hazelbrook',
        folderId: 'folder-sow-archive',
        archivePrincipal: 'autotask-archive@phoneware-edge.iam.gserviceaccount.com',
        allowedActorResourceIds: [77],
        version: 1,
        approvalEvidenceRef: 'board-approval-2026-10-31',
        disabled: false,
      });

      // Agent first reads attachment metadata via get-ticket-attachment to obtain sha256 without raw bytes
      const inspectRes = await withCaller(testCaller, () =>
        getAttachmentTool.handler({
          ticketID: '1001',
          attachmentID: '901',
        }),
      );
      const inspectMeta = JSON.parse(inspectRes.content[0].text);
      expect(inspectMeta.sha256).toBe(expectedSha);
      expect(inspectRes.content[0].text).not.toContain(pdfPayload.toString('base64'));

      // Agent archives attachment citing discovered expectedSha256
      const res = await withCaller(testCaller, () =>
        archiveAttachmentTool.handler({
          ticketID: '1001',
          attachmentID: '901',
          expectedCompanyID: '450',
          expectedSha256: inspectMeta.sha256,
          operationId: 'op-archive-sow-1001',
        }),
      );

      // 1. Output contains receipt metadata only, NO raw binary or base64 bytes
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe('text');
      const receipt = JSON.parse(res.content[0].text);
      expect(receipt.status).toBe('verified');
      expect(receipt.operationId).toBe('op-archive-sow-1001');
      expect(receipt.source.ticketId).toBe('1001');
      expect(receipt.source.attachmentId).toBe('901');
      expect(receipt.source.companyId).toBe('450');
      expect(receipt.source.sha256).toBe(expectedSha);
      expect(receipt.destination.provider).toBe('google-drive');
      expect(receipt.destination.folderId).toBe('folder-sow-archive');
      expect(receipt.destination.sha256).toBe(expectedSha);
      expect(res.content[0].text).not.toContain(pdfPayload.toString('base64'));

      // 2. Drive mirror contains the uploaded file
      const uploadedFile = driveMirror.files.get(receipt.destination.fileId);
      expect(uploadedFile).toBeDefined();
      expect(uploadedFile?.parents).toContain('folder-sow-archive');
      expect(uploadedFile?.sha256Checksum).toBe(expectedSha);
      expect(uploadedFile?.bytes.equals(pdfPayload)).toBe(true);

      // 3. Retry with same operationId returns existing verified receipt without second upload
      const initialUploadCount = driveMirror.requestLog.filter(
        (r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files'),
      ).length;

      const res2 = await withCaller(testCaller, () =>
        archiveAttachmentTool.handler({
          ticketID: '1001',
          attachmentID: '901',
          expectedCompanyID: '450',
          expectedSha256: expectedSha,
          operationId: 'op-archive-sow-1001',
        }),
      );

      const receipt2 = JSON.parse(res2.content[0].text);
      expect(receipt2.status).toBe('verified');
      expect(receipt2.destination.fileId).toBe(receipt.destination.fileId);

      const finalUploadCount = driveMirror.requestLog.filter(
        (r) => r.method === 'POST' && r.url.includes('/upload/drive/v3/files'),
      ).length;
      expect(finalUploadCount).toBe(initialUploadCount);
    });

    it('refuses archival when company ID does not match expectedCompanyID', async () => {
      autotaskMirror.seedTicket({
        id: 1001,
        companyID: 999, // actual company 999
        title: 'Hazelbrook Provisioning Ticket',
      });

      autotaskMirror.seedAttachment({
        id: 902,
        ticketID: 1001,
        title: 'sow.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 data').toString('base64'),
      });

      const accountKey = crypto
        .createHash('sha256')
        .update('tech@phoneware.us\0' + autotaskMirror.baseUrl.toLowerCase().trim())
        .digest('hex')
        .slice(0, 16);

      await bindingsStore.set({
        accountKey,
        companyId: '450',
        driveId: 'shared-drive-hazelbrook',
        folderId: 'folder-sow-archive',
        archivePrincipal: 'autotask-archive@phoneware-edge.iam.gserviceaccount.com',
        allowedActorResourceIds: [77],
        version: 1,
        approvalEvidenceRef: 'board-approval-2026-10-31',
        disabled: false,
      });

      await expect(
        withCaller(testCaller, () =>
          archiveAttachmentTool.handler({
            ticketID: '1001',
            attachmentID: '902',
            expectedCompanyID: '450', // expected 450
            expectedSha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            operationId: 'op-archive-company-mismatch',
          }),
        ),
      ).rejects.toThrow(/Company mismatch: ticket 1001 belongs to companyID 999, not expected 450/);
    });

    it('refuses archival when attachment is not valid PDF (%PDF- missing)', async () => {
      autotaskMirror.seedTicket({
        id: 1001,
        companyID: 450,
      });

      autotaskMirror.seedAttachment({
        id: 903,
        ticketID: 1001,
        title: 'fake.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('NOT_A_REAL_PDF_HEADER').toString('base64'),
      });

      const accountKey = crypto
        .createHash('sha256')
        .update('tech@phoneware.us\0' + autotaskMirror.baseUrl.toLowerCase().trim())
        .digest('hex')
        .slice(0, 16);

      await bindingsStore.set({
        accountKey,
        companyId: '450',
        driveId: 'shared-drive-hazelbrook',
        folderId: 'folder-sow-archive',
        archivePrincipal: 'autotask-archive@phoneware-edge.iam.gserviceaccount.com',
        allowedActorResourceIds: [77],
        version: 1,
        approvalEvidenceRef: 'board-approval-2026-10-31',
        disabled: false,
      });

      await expect(
        withCaller(testCaller, () =>
          archiveAttachmentTool.handler({
            ticketID: '1001',
            attachmentID: '903',
            expectedCompanyID: '450',
            expectedSha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            operationId: 'op-archive-fake-pdf',
          }),
        ),
      ).rejects.toThrow(/does not have valid PDF magic bytes/);
    });

    it('refuses archival when actor resource ID is not authorized by binding', async () => {
      autotaskMirror.seedTicket({ id: 1001, companyID: 450 });
      autotaskMirror.seedAttachment({
        id: 904,
        ticketID: 1001,
        title: 'sow.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 test').toString('base64'),
      });

      const accountKey = crypto
        .createHash('sha256')
        .update('tech@phoneware.us\0' + autotaskMirror.baseUrl.toLowerCase().trim())
        .digest('hex')
        .slice(0, 16);

      await bindingsStore.set({
        accountKey,
        companyId: '450',
        driveId: 'shared-drive-hazelbrook',
        folderId: 'folder-sow-archive',
        archivePrincipal: 'autotask-archive@phoneware-edge.iam.gserviceaccount.com',
        allowedActorResourceIds: [999], // 77 not allowed!
        version: 1,
        approvalEvidenceRef: 'board-approval',
        disabled: false,
      });

      await expect(
        withCaller(testCaller, () =>
          archiveAttachmentTool.handler({
            ticketID: '1001',
            attachmentID: '904',
            expectedCompanyID: '450',
            expectedSha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            operationId: 'op-archive-actor-unauthorized',
          }),
        ),
      ).rejects.toThrow(/Actor resource ID 77 is not authorized by archive binding/);
    });

    it('refuses archival when binding has empty allowedActorResourceIds (fails closed)', async () => {
      autotaskMirror.seedTicket({ id: 1001, companyID: 450 });
      autotaskMirror.seedAttachment({
        id: 905,
        ticketID: 1001,
        title: 'sow.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 test').toString('base64'),
      });

      const accountKey = crypto
        .createHash('sha256')
        .update('tech@phoneware.us\0' + autotaskMirror.baseUrl.toLowerCase().trim())
        .digest('hex')
        .slice(0, 16);

      await bindingsStore.set({
        accountKey,
        companyId: '450',
        driveId: 'shared-drive-hazelbrook',
        folderId: 'folder-sow-archive',
        archivePrincipal: 'autotask-archive@phoneware-edge.iam.gserviceaccount.com',
        allowedActorResourceIds: [], // Empty fails closed!
        version: 1,
        approvalEvidenceRef: 'board-approval',
        disabled: false,
      });

      await expect(
        withCaller(testCaller, () =>
          archiveAttachmentTool.handler({
            ticketID: '1001',
            attachmentID: '905',
            expectedCompanyID: '450',
            expectedSha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            operationId: 'op-archive-empty-actors',
          }),
        ),
      ).rejects.toThrow(/Actor resource ID 77 is not authorized by archive binding/);
    });

    it('refuses archival when binding is disabled', async () => {
      autotaskMirror.seedTicket({ id: 1001, companyID: 450 });
      autotaskMirror.seedAttachment({
        id: 906,
        ticketID: 1001,
        title: 'sow.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 test').toString('base64'),
      });

      const accountKey = crypto
        .createHash('sha256')
        .update('tech@phoneware.us\0' + autotaskMirror.baseUrl.toLowerCase().trim())
        .digest('hex')
        .slice(0, 16);

      await bindingsStore.set({
        accountKey,
        companyId: '450',
        driveId: 'shared-drive-hazelbrook',
        folderId: 'folder-sow-archive',
        archivePrincipal: 'autotask-archive@phoneware-edge.iam.gserviceaccount.com',
        allowedActorResourceIds: [77],
        version: 1,
        approvalEvidenceRef: 'board-approval',
        disabled: true, // Disabled!
      });

      await expect(
        withCaller(testCaller, () =>
          archiveAttachmentTool.handler({
            ticketID: '1001',
            attachmentID: '906',
            expectedCompanyID: '450',
            expectedSha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            operationId: 'op-archive-disabled',
          }),
        ),
      ).rejects.toThrow(/Archive destination binding for company ID 450 is currently disabled/);
    });
  });

  describe('5. Read-only mode safety', () => {
    it('read-only mode unregisters all destructive write tools while preserving safe attachment reads', async () => {
      process.env.AUTOTASK_READ_ONLY = 'true';
      const { server, skipped } = buildServer();

      expect(skipped).toBe(DESTRUCTIVE_TOOLS.size);

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const toolList = await client.listTools();
      const toolNames = toolList.tools.map((t) => t.name);

      // Destructive write tools must be absent
      expect(toolNames).not.toContain('append-ticket-resolution');
      expect(toolNames).not.toContain('set-ticket-checklist-item');
      expect(toolNames).not.toContain('record-ticket-evidence');
      expect(toolNames).not.toContain('archive-ticket-attachment');

      // Safe read tools must be present
      expect(toolNames).toContain('get-ticket-attachment');

      await client.close();
    });
  });
});
