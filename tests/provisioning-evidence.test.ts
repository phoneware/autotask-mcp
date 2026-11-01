import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutotaskMirror } from './test-support/autotask-mirror.js';
import { buildServer } from '../src/server.js';
import { ticketWriteTools, TicketLock } from '../src/tools/ticket-writes.js';
import { attachmentTools } from '../src/tools/attachments.js';
import { DESTRUCTIVE_TOOLS } from '../src/security.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('Provisioning Evidence & Transport Acceptance (Slice A1)', () => {
  let mirror: AutotaskMirror;
  let mirrorUrl: string;
  let savedEnv: {
    username?: string;
    secret?: string;
    code?: string;
    apiUrl?: string;
    readonly?: string;
  };

  const appendTool = ticketWriteTools.find((t) => t.name === 'append-ticket-resolution')!;
  const checklistTool = ticketWriteTools.find((t) => t.name === 'set-ticket-checklist-item')!;
  const evidenceTool = ticketWriteTools.find((t) => t.name === 'record-ticket-evidence')!;
  const getAttachmentTool = attachmentTools.find((t) => t.name === 'get-ticket-attachment')!;
  const transferAttachmentTool = attachmentTools.find(
    (t) => t.name === 'transfer-ticket-attachment',
  )!;

  beforeEach(async () => {
    savedEnv = {
      username: process.env.AUTOTASK_USERNAME,
      secret: process.env.AUTOTASK_SECRET,
      code: process.env.AUTOTASK_INTEGRATION_CODE,
      apiUrl: process.env.AUTOTASK_API_URL,
      readonly: process.env.AUTOTASK_READ_ONLY,
    };

    mirror = new AutotaskMirror();
    const started = await mirror.start();
    mirrorUrl = started.url;

    process.env.AUTOTASK_USERNAME = 'tech@phoneware.us';
    process.env.AUTOTASK_SECRET = 'valid-test-secret';
    process.env.AUTOTASK_INTEGRATION_CODE = 'INTCODE123';
    process.env.AUTOTASK_API_URL = mirrorUrl;
    delete process.env.AUTOTASK_READ_ONLY;

    TicketLock.clear();
  });

  afterEach(async () => {
    await mirror.stop();
    TicketLock.clear();

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
  });

  describe('1. Logical operation deduplication across clock advances', () => {
    it('does not duplicate logical resolution line when retried after the clock advances', async () => {
      mirror.seedTicket({
        id: 1001,
        title: 'Hazelbrook Provisioning Ticket',
        resolution: 'Scope approved.\nInitial WAN check completed.',
      });

      // Initial execution at T1
      const res1 = await appendTool.handler({
        ticketID: '1001',
        text: 'Installed Frontier eSIM into slot A.',
        operationId: 'hazelbrook-esim-slot-a',
      });

      const parsed1 = JSON.parse(res1.content[0].text);
      expect(parsed1.written).toBe(true);
      expect(parsed1.already_present).toBe(false);
      expect(parsed1.verified).toBe(true);

      const ticketAfter1 = mirror.tickets.get(1001);
      expect(ticketAfter1?.resolution).toContain('Installed Frontier eSIM into slot A.');

      // Count occurrences in mirror resolution
      const count1 = (
        ticketAfter1?.resolution?.match(/Installed Frontier eSIM into slot A\./g) || []
      ).length;
      expect(count1).toBe(1);

      // Simulating clock advance / retry after timeout:
      // Even if called later with the same logical operationId, it must reconcile prior evidence
      const res2 = await appendTool.handler({
        ticketID: '1001',
        text: 'Installed Frontier eSIM into slot A.',
        operationId: 'hazelbrook-esim-slot-a',
      });

      const parsed2 = JSON.parse(res2.content[0].text);
      expect(parsed2.written).toBe(false);
      expect(parsed2.already_present).toBe(true);
      expect(parsed2.reconciled_from_prior_evidence).toBe(true);
      expect(parsed2.verified).toBe(true);
      expect(parsed2.operationId).toBe('hazelbrook-esim-slot-a');

      // Crucial: no second line was appended in Autotask
      const ticketAfter2 = mirror.tickets.get(1001);
      const count2 = (
        ticketAfter2?.resolution?.match(/Installed Frontier eSIM into slot A\./g) || []
      ).length;
      expect(count2).toBe(1);
    });

    it('reconciles prior evidence on ticket note creation with operationId across retries', async () => {
      mirror.seedTicket({
        id: 1001,
        title: 'Hazelbrook Provisioning Ticket',
      });

      // Initial evidence note creation
      const res1 = await evidenceTool.handler({
        ticketID: '1001',
        title: 'eSIM Download Verification',
        description: 'Profile 8901260000000000000 verified active on modem 3.',
        operationId: 'op-esim-verify-1001',
      });

      const parsed1 = JSON.parse(res1.content[0].text);
      expect(parsed1.created).toBe(true);
      expect(parsed1.already_present).toBe(false);
      expect(parsed1.verified).toBe(true);
      const noteId1 = parsed1.noteID;

      // Retry of evidence creation (e.g. after network glitch or restart)
      const res2 = await evidenceTool.handler({
        ticketID: '1001',
        title: 'eSIM Download Verification',
        description: 'Profile 8901260000000000000 verified active on modem 3.',
        operationId: 'op-esim-verify-1001',
      });

      const parsed2 = JSON.parse(res2.content[0].text);
      expect(parsed2.created).toBe(false);
      expect(parsed2.already_present).toBe(true);
      expect(parsed2.reconciled_from_prior_evidence).toBe(true);
      expect(parsed2.noteID).toBe(noteId1);
      expect(parsed2.verified).toBe(true);

      // Verify mirror contains only 1 note for this ticket
      const notes = Array.from(mirror.notes.values()).filter((n) => n.ticketID === 1001);
      expect(notes).toHaveLength(1);
    });
  });

  describe('2. Concurrent-edit uncertainty is not success', () => {
    it('refuses write and reports conflict when concurrent modification occurs between reads', async () => {
      mirror.seedTicket({
        id: 1001,
        title: 'Hazelbrook Provisioning Ticket',
        resolution: 'Base state.',
      });

      // Simulate external concurrent modification occurring right before the write
      mirror.simulateConcurrentResolutionModification =
        'Base state.\nExternal tech modified resolution concurrently!';

      await expect(
        appendTool.handler({
          ticketID: '1001',
          text: 'Configured AP mesh SSID.',
          operationId: 'ap-mesh-1001',
        }),
      ).rejects.toThrow(/Conflict: ticket resolution was modified concurrently between reads/);

      // Verify that unverified or conflicting state was NOT reported as success
      const current = mirror.tickets.get(1001);
      expect(current?.resolution).not.toContain('Configured AP mesh SSID.');
    });
  });

  describe('3. Wrong-parent attachment and checklist access is refused', () => {
    it('refuses checklist item update when item belongs to a different ticket', async () => {
      mirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      mirror.seedTicket({ id: 9999, title: 'Other Customer Ticket' });

      mirror.seedChecklistItem({
        id: 501,
        ticketID: 9999, // Belongs to ticket 9999
        itemName: 'Install Starlink dish',
        isCompleted: false,
      });

      // Attempting to access item 501 under ticket 1001 must be refused
      await expect(
        checklistTool.handler({
          ticketID: '1001',
          checklistItemID: '501',
          completed: 'true',
        }),
      ).rejects.toThrow(/Parent mismatch: checklist item 501 belongs to ticketID 9999, not 1001/);

      // Verify item state remains untouched
      expect(mirror.checklistItems.get(501)?.isCompleted).toBe(false);
    });

    it('refuses checklist item completion when requireEvidence is true and evidence is missing', async () => {
      mirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      mirror.seedChecklistItem({
        id: 502,
        ticketID: 1001,
        itemName: 'Verify throughput threshold',
        isCompleted: false,
      });

      await expect(
        checklistTool.handler({
          ticketID: '1001',
          checklistItemID: '502',
          completed: 'true',
          requireEvidence: 'true',
        }),
      ).rejects.toThrow(/checklist item completion requires observed evidence/);

      expect(mirror.checklistItems.get(502)?.isCompleted).toBe(false);
    });

    it('refuses checklist item completion when evidence note belongs to a different ticket', async () => {
      mirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      mirror.seedTicket({ id: 9999, title: 'Other Ticket' });

      mirror.seedChecklistItem({
        id: 503,
        ticketID: 1001,
        itemName: 'Verify AP Mesh Link',
        isCompleted: false,
      });

      mirror.seedNote({
        id: 701,
        ticketID: 9999, // Note belongs to other ticket 9999
        title: 'Mesh link verified',
        description: 'Operational link confirmed.',
      });

      await expect(
        checklistTool.handler({
          ticketID: '1001',
          checklistItemID: '503',
          completed: 'true',
          evidenceNoteID: '701',
        }),
      ).rejects.toThrow(/Parent mismatch: evidence note 701 belongs to ticketID 9999, not 1001/);

      expect(mirror.checklistItems.get(503)?.isCompleted).toBe(false);
    });

    it('refuses attachment retrieval when attachment belongs to a different ticket', async () => {
      mirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      mirror.seedTicket({ id: 9999, title: 'Other Ticket' });

      mirror.seedAttachment({
        id: 601,
        ticketID: 9999, // Belongs to ticket 9999
        title: 'confidential.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('data').toString('base64'),
      });

      await expect(
        getAttachmentTool.handler({
          ticketID: '1001',
          attachmentID: '601',
        }),
      ).rejects.toThrow(/Parent mismatch: attachment 601 belongs to ticketID 9999, not 1001/);

      await expect(
        transferAttachmentTool.handler({
          ticketID: '1001',
          attachmentID: '601',
          destinationPath: '/tmp/test.pdf',
        }),
      ).rejects.toThrow(/Parent mismatch: attachment 601 belongs to ticketID 9999, not 1001/);
    });

    it('successfully completes checklist item when valid parent evidence note is provided', async () => {
      mirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      mirror.seedChecklistItem({
        id: 504,
        ticketID: 1001,
        itemName: 'AP series management adoption',
        isCompleted: false,
      });

      mirror.seedNote({
        id: 702,
        ticketID: 1001, // Valid parent match
        title: 'AP adoption confirmed',
        description: 'AP One AX serial 1234 adopted by B One.',
      });

      const res = await checklistTool.handler({
        ticketID: '1001',
        checklistItemID: '504',
        completed: 'true',
        evidenceNoteID: '702',
      });

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.updated).toBe(true);
      expect(parsed.isCompleted).toBe(true);
      expect(parsed.evidenceVerified).toBe(true);
      expect(parsed.evidenceNoteID).toBe(702);

      expect(mirror.checklistItems.get(504)?.isCompleted).toBe(true);
    });
  });

  describe('4. PDF transfer to isolated consumer and content-hash verification', () => {
    it('transfers PDF binary data to consumer path without dumping bytes into model output', async () => {
      mirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });

      const pdfPayload = Buffer.from(
        '%PDF-1.4\n%Hazelbrook Statement of Work and Customer Signed Acceptance\n%%EOF',
      );
      const expectedSha = crypto.createHash('sha256').update(pdfPayload).digest('hex');
      const base64Payload = pdfPayload.toString('base64');

      mirror.seedAttachment({
        id: 901,
        ticketID: 1001,
        title: 'hazelbrook-sow-signed.pdf',
        contentType: 'application/pdf',
        fileSize: pdfPayload.byteLength,
        data: base64Payload,
      });

      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hazelbrook-archival-'));
      const destinationFile = path.join(tmpDir, 'transferred-sow.pdf');

      try {
        const res = await transferAttachmentTool.handler({
          ticketID: '1001',
          attachmentID: '901',
          destinationPath: destinationFile,
          expectedSha256: expectedSha,
          allowedMimeTypes: ['application/pdf'],
        });

        // 1. Destination file exists on disk and exact bytes match
        const fileBytes = await fs.promises.readFile(destinationFile);
        expect(fileBytes.equals(pdfPayload)).toBe(true);

        // 2. Output contains metadata only and no raw binary/base64 text
        expect(res.content).toHaveLength(1);
        expect(res.content[0].type).toBe('text');
        const metadata = JSON.parse(res.content[0].text);
        expect(metadata.ticketID).toBe(1001);
        expect(metadata.attachmentID).toBe(901);
        expect(metadata.title).toBe('hazelbrook-sow-signed.pdf');
        expect(metadata.contentType).toBe('application/pdf');
        expect(metadata.fileSize).toBe(pdfPayload.byteLength);
        expect(metadata.sha256).toBe(expectedSha);
        expect(metadata.transferred).toBe(true);
        expect(metadata.verified).toBe(true);

        expect(res.content[0].text).not.toContain(base64Payload);
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('refuses transfer when content SHA-256 does not match expected hash', async () => {
      mirror.seedTicket({ id: 1001, title: 'Hazelbrook Ticket' });
      mirror.seedAttachment({
        id: 902,
        ticketID: 1001,
        title: 'corrupt.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('actual content').toString('base64'),
      });

      await expect(
        transferAttachmentTool.handler({
          ticketID: '1001',
          attachmentID: '902',
          destinationPath: '/tmp/corrupt.pdf',
          expectedSha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        }),
      ).rejects.toThrow(/Integrity check failed: expected SHA-256/);
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

      // Safe read tools must be present
      expect(toolNames).toContain('get-ticket-attachment');
      expect(toolNames).toContain('transfer-ticket-attachment');

      await client.close();
    });
  });
});
