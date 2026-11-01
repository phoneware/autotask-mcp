import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachmentTools } from '../src/tools/attachments.js';
import { DESTRUCTIVE_TOOLS } from '../src/security.js';
import { buildServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { request } = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../src/autotask-api.js', () => ({
  api: {
    request,
    getById: vi.fn(),
    update: vi.fn(),
    entityFields: vi.fn(),
  },
}));

describe('get-ticket-attachment tool', () => {
  const getAttachmentTool = attachmentTools.find((t) => t.name === 'get-ticket-attachment')!;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is read-only and not in DESTRUCTIVE_TOOLS', () => {
    expect(DESTRUCTIVE_TOOLS.has('get-ticket-attachment')).toBe(false);
    expect(getAttachmentTool.annotations?.readOnlyHint).toBe(true);
    expect(getAttachmentTool.annotations?.destructiveHint).toBe(false);
  });

  it('returns text metadata and image content block for image <= 3 MB decoded', async () => {
    const rawImageBytes = Buffer.from('fake-png-binary-content-12345');
    const base64Data = rawImageBytes.toString('base64');

    request.mockResolvedValue({
      item: {
        id: 701,
        ticketID: 1001,
        title: 'front-panel.png',
        contentType: 'image/png; charset=binary',
        fileSize: rawImageBytes.byteLength,
        data: base64Data,
      },
    });

    const res = await getAttachmentTool.handler({
      ticketID: '1001',
      attachmentID: '701',
    });

    expect(request).toHaveBeenCalledWith('GET', 'V1.0/Tickets/1001/Attachments/701');
    expect(res.content).toHaveLength(2);

    // Block 1: text metadata
    expect(res.content[0].type).toBe('text');
    const metadata = JSON.parse(res.content[0].text);
    expect(metadata.id).toBe(701);
    expect(metadata.ticketID).toBe(1001);
    expect(metadata.title).toBe('front-panel.png');
    expect(metadata.contentType).toBe('image/png; charset=binary');
    expect(metadata.fileSize).toBe(rawImageBytes.byteLength);
    expect(metadata.attached_as_image).toBe(true);

    // Block 2: image content
    expect(res.content[1].type).toBe('image');
    if (res.content[1].type === 'image') {
      expect(res.content[1].data).toBe(base64Data);
      expect(res.content[1].mimeType).toBe('image/png');
    }
  });

  it('handles data URI prefix in data field cleanly', async () => {
    const base64Data = Buffer.from('simple-jpeg').toString('base64');
    request.mockResolvedValue({
      item: {
        id: 702,
        ticketID: 1001,
        title: 'photo.jpg',
        contentType: 'image/jpeg',
        data: `data:image/jpeg;base64,${base64Data}`,
      },
    });

    const res = await getAttachmentTool.handler({
      ticketID: '1001',
      attachmentID: '702',
    });

    expect(res.content).toHaveLength(2);
    if (res.content[1].type === 'image') {
      expect(res.content[1].data).toBe(base64Data);
      expect(res.content[1].mimeType).toBe('image/jpeg');
    }
  });

  it('returns metadata only for non-image attachments (e.g. PDF)', async () => {
    request.mockResolvedValue({
      item: {
        id: 703,
        ticketID: 1001,
        title: 'sow-signed.pdf',
        contentType: 'application/pdf',
        fileSize: 45000,
        data: Buffer.from('fake-pdf-content').toString('base64'),
      },
    });

    const res = await getAttachmentTool.handler({
      ticketID: '1001',
      attachmentID: '703',
    });

    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    const metadata = JSON.parse(res.content[0].text);
    expect(metadata.attached_as_image).toBe(false);
    expect(metadata.contentType).toBe('application/pdf');
    expect(metadata.sha256).toBeDefined();
    expect(metadata.reason).toMatch(/is not an image; inline image content omitted/);
  });

  it('returns metadata only for oversized image attachments (> 3 MB decoded)', async () => {
    const hugeBytes = 3 * 1024 * 1024 + 1024; // 3 MB + 1 KB
    request.mockResolvedValue({
      item: {
        id: 704,
        ticketID: 1001,
        title: 'huge-scan.png',
        contentType: 'image/png',
        fileSize: hugeBytes,
        data: Buffer.alloc(hugeBytes).toString('base64'),
      },
    });

    const res = await getAttachmentTool.handler({
      ticketID: '1001',
      attachmentID: '704',
    });

    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    const metadata = JSON.parse(res.content[0].text);
    expect(metadata.attached_as_image).toBe(false);
    expect(metadata.reason).toMatch(/exceeds 3 MB limit for inline image content/);
  });

  it('returns metadata only when image attachment has empty data', async () => {
    request.mockResolvedValue({
      item: {
        id: 705,
        ticketID: 1001,
        title: 'empty.png',
        contentType: 'image/png',
        fileSize: 0,
        data: '',
      },
    });

    const res = await getAttachmentTool.handler({
      ticketID: '1001',
      attachmentID: '705',
    });

    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    const metadata = JSON.parse(res.content[0].text);
    expect(metadata.attached_as_image).toBe(false);
    expect(metadata.reason).toMatch(/contains no binary image data/);
  });

  it('refuses invalid numeric IDs', async () => {
    await expect(
      getAttachmentTool.handler({
        ticketID: 'abc',
        attachmentID: '123',
      }),
    ).rejects.toThrow(/numeric id/);

    await expect(
      getAttachmentTool.handler({
        ticketID: '123',
        attachmentID: '../bad',
      }),
    ).rejects.toThrow(/numeric id/);
  });

  it('refuses when attachment belongs to a different ticket (parent mismatch)', async () => {
    request.mockResolvedValue({
      item: {
        id: 706,
        ticketID: 9999, // Belongs to ticket 9999
        title: 'secret-scan.png',
        contentType: 'image/png',
      },
    });

    await expect(
      getAttachmentTool.handler({
        ticketID: '1001', // Request specifies ticket 1001
        attachmentID: '706',
      }),
    ).rejects.toThrow(/Parent mismatch: attachment 706 belongs to ticketID 9999, not 1001/);
  });

  it('refuses when attachment has absent or null ticketID (fails closed)', async () => {
    request.mockResolvedValue({
      item: {
        id: 707,
        // ticketID is undefined
        title: 'orphaned.png',
        contentType: 'image/png',
      },
    });

    await expect(
      getAttachmentTool.handler({
        ticketID: '1001',
        attachmentID: '707',
      }),
    ).rejects.toThrow(/Parent mismatch: attachment 707 belongs to ticketID unknown, not 1001/);
  });

  it('is available in read-only mode and for Service Desk callers over real MCP server', async () => {
    process.env.AUTOTASK_READ_ONLY = 'true';
    const ro = buildServer();
    delete process.env.AUTOTASK_READ_ONLY;

    // Server registers get-ticket-attachment in read-only mode
    const [roClientTransport, roServerTransport] = InMemoryTransport.createLinkedPair();
    const roClient = new Client({ name: 'ro-test', version: '0' });
    await Promise.all([ro.server.connect(roServerTransport), roClient.connect(roClientTransport)]);

    const roTools = (await roClient.listTools()).tools.map((t) => t.name);
    expect(roTools).toContain('get-ticket-attachment');
    expect(roTools).not.toContain('append-ticket-resolution');
    expect(roTools).not.toContain('set-ticket-checklist-item');
    expect(roTools).not.toContain('archive-ticket-attachment');
    expect(roTools).not.toContain('record-ticket-evidence');
    await roClient.close();

    // Service Desk caller (read + create capabilities)
    const sdServer = buildServer(['read', 'create']);
    const [sdClientTransport, sdServerTransport] = InMemoryTransport.createLinkedPair();
    const sdClient = new Client({ name: 'sd-test', version: '0' });
    await Promise.all([
      sdServer.server.connect(sdServerTransport),
      sdClient.connect(sdClientTransport),
    ]);

    const sdTools = (await sdClient.listTools()).tools.map((t) => t.name);
    expect(sdTools).toContain('get-ticket-attachment');
    expect(sdTools).not.toContain('append-ticket-resolution');
    expect(sdTools).not.toContain('set-ticket-checklist-item');
    expect(sdTools).toContain('create-ticket');
  });
});
