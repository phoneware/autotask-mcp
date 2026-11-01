import crypto from 'node:crypto';
import type { ToolDefinition, ToolResponse } from '../types.js';
import { api } from '../autotask-api.js';
import { assertSafeNumericId } from '../security.js';
import { currentCaller } from '../auth/context.js';
import { fetchPrivatePdfAttachment } from '../archive/source.js';
import { assertAuthorizedArchiveBinding } from '../archive/bindings.js';
import { DriveArchiveProvider } from '../archive/drive.js';
import { TicketCoordinatorSession } from '../provisioning/ticket-coordinator.js';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB decoded

interface TicketAttachmentModel {
  id?: number | string;
  ticketID?: number | string;
  title?: string;
  contentType?: string;
  fileSize?: number;
  data?: string;
  [key: string]: unknown;
}

function unwrapAttachment(raw: unknown): TicketAttachmentModel {
  if (raw && typeof raw === 'object') {
    if ('item' in raw && raw.item && typeof raw.item === 'object') {
      return raw.item as TicketAttachmentModel;
    }
    return raw as TicketAttachmentModel;
  }
  return {};
}

export const attachmentTools: ToolDefinition[] = [
  {
    name: 'get-ticket-attachment',
    title: 'Get Ticket Attachment',
    description:
      'Retrieve an attachment from a ticket by ID. For image attachments up to 3 MB decoded, ' +
      'returns an MCP image content block in addition to metadata. Other file types or oversized attachments return metadata only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'string', description: 'Autotask ticket id' },
        attachmentID: { type: 'string', description: 'Ticket attachment id' },
      },
      required: ['ticketID', 'attachmentID'],
    },
    handler: async (args): Promise<ToolResponse> => {
      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');
      const attachmentId = assertSafeNumericId(args.attachmentID, 'attachmentID');

      // Reads GET V1.0/Tickets/{t}/Attachments/{a}
      const rawRes = await api.request(
        'GET',
        `V1.0/Tickets/${encodeURIComponent(ticketId)}/Attachments/${encodeURIComponent(attachmentId)}`,
      );

      const att = unwrapAttachment(rawRes);
      if (!att || Object.keys(att).length === 0) {
        throw new Error(`Attachment ${attachmentId} not found on ticket ${ticketId}`);
      }

      // Enforce parent ticket relationship: wrong or absent parent fails closed
      if (
        att.ticketID === undefined ||
        att.ticketID === null ||
        String(att.ticketID) !== ticketId
      ) {
        throw new Error(
          `Parent mismatch: attachment ${attachmentId} belongs to ticketID ${att.ticketID ?? 'unknown'}, not ${ticketId}; access refused`,
        );
      }

      const rawContentType = typeof att.contentType === 'string' ? att.contentType.trim() : '';
      const contentType = rawContentType.toLowerCase();
      const mimeType = contentType.split(';')[0].trim();
      const title = typeof att.title === 'string' ? att.title : '';
      const rawData = typeof att.data === 'string' ? att.data : '';
      const base64Data = rawData.replace(/^data:[^;]+;base64,/, '').trim();
      const isImage = mimeType.startsWith('image/');

      let decodedBytes = 0;
      if (base64Data.length > 0) {
        decodedBytes = Buffer.byteLength(base64Data, 'base64');
      } else if (typeof att.fileSize === 'number') {
        decodedBytes = att.fileSize;
      }

      if (!isImage) {
        let sha256: string | undefined = undefined;
        if (base64Data.length > 0) {
          const maxAllowedBytes = 5_000_000;
          if (decodedBytes > maxAllowedBytes) {
            const metadata = {
              id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
              ticketID: Number(ticketId),
              title,
              contentType: rawContentType || 'application/octet-stream',
              fileSize: decodedBytes,
              attached_as_image: false,
              reason: `Attachment size (${decodedBytes} bytes) exceeds maximum limit of ${maxAllowedBytes} bytes.`,
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }],
              structuredContent: metadata,
            };
          }
          const buffer = Buffer.from(base64Data, 'base64');
          sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        }

        const metadata = {
          id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
          ticketID: Number(ticketId),
          title,
          contentType: rawContentType || 'application/octet-stream',
          fileSize: typeof att.fileSize === 'number' ? att.fileSize : decodedBytes,
          sha256,
          attached_as_image: false,
          reason: `Content type "${rawContentType || 'unknown'}" is not an image; inline image content omitted.`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }],
          structuredContent: metadata,
        };
      }

      if (decodedBytes > MAX_IMAGE_BYTES) {
        const metadata = {
          id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
          ticketID: att.ticketID !== undefined ? Number(att.ticketID) : Number(ticketId),
          title,
          contentType: rawContentType,
          fileSize: typeof att.fileSize === 'number' ? att.fileSize : decodedBytes,
          attached_as_image: false,
          reason: `Image size (${decodedBytes} bytes decoded) exceeds 3 MB limit for inline image content.`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }],
          structuredContent: metadata,
        };
      }

      if (!base64Data) {
        const metadata = {
          id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
          ticketID: att.ticketID !== undefined ? Number(att.ticketID) : Number(ticketId),
          title,
          contentType: rawContentType,
          fileSize: typeof att.fileSize === 'number' ? att.fileSize : 0,
          attached_as_image: false,
          reason: 'Attachment contains no binary image data.',
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }],
          structuredContent: metadata,
        };
      }

      const metadata = {
        id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
        ticketID: att.ticketID !== undefined ? Number(att.ticketID) : Number(ticketId),
        title,
        contentType: rawContentType,
        fileSize: typeof att.fileSize === 'number' ? att.fileSize : decodedBytes,
        attached_as_image: true,
      };

      return {
        content: [
          { type: 'text', text: JSON.stringify(metadata, null, 2) },
          { type: 'image', data: base64Data, mimeType },
        ],
        structuredContent: metadata,
      };
    },
  },
  {
    name: 'archive-ticket-attachment',
    title: 'Archive Ticket Attachment',
    description:
      'Archive an Autotask PDF attachment into the approved customer Google Drive archive folder. ' +
      'DESTRUCTIVE (write): requires confirm token ARCHIVE_TICKET_ATTACHMENT. ' +
      'Validates parent ticket, company binding, PDF bytes and SHA-256 integrity, uploads without format conversion, ' +
      'verifies readback, and returns receipt metadata only without exposing raw document bytes.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: { type: 'string', description: 'Autotask ticket id' },
        attachmentID: { type: 'string', description: 'Ticket attachment id' },
        expectedCompanyID: {
          type: 'string',
          description: 'Expected Autotask company id for the parent ticket',
        },
        expectedSha256: {
          type: 'string',
          description: 'Expected SHA256 hex digest of the attachment PDF content',
        },
        operationId: {
          type: 'string',
          description: 'Stable operation identifier for idempotent archival',
        },
      },
      required: ['ticketID', 'attachmentID', 'expectedCompanyID', 'expectedSha256', 'operationId'],
    },
    handler: async (args): Promise<ToolResponse> => {
      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');
      const attachmentId = assertSafeNumericId(args.attachmentID, 'attachmentID');
      const expectedCompanyId = assertSafeNumericId(args.expectedCompanyID, 'expectedCompanyID');
      const expectedSha256 = String(args.expectedSha256 || '')
        .trim()
        .toLowerCase();
      const operationId = String(args.operationId || '').trim();

      if (!operationId) {
        throw new Error('operationId is required for archival');
      }
      if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
        throw new Error('expectedSha256 must be a 64-character hex digest');
      }

      const caller = currentCaller();
      const actorEmail = caller?.email ?? 'autotask-mcp';
      const actorResourceId = caller?.resourceId ?? 0;

      // 1. Prepare operation and acquire coordinator lease
      const session = new TicketCoordinatorSession({
        ticketId,
        actor: { email: actorEmail, resourceId: actorResourceId },
        operationId,
        kind: 'attachment_archive',
        payload: {
          ticketID: ticketId,
          attachmentID: attachmentId,
          expectedCompanyID: expectedCompanyId,
          expectedSha256,
        },
      });

      const { alreadyVerified } = await session.prepareAndAcquire();
      if (alreadyVerified) {
        const op = session.getOperation();
        const receipt = op?.receipt ?? { status: 'verified', operationId };
        return {
          content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }],
          structuredContent: receipt,
        };
      }

      try {
        // 2. Destination binding authorization check
        const binding = await assertAuthorizedArchiveBinding({
          accountKey: session.accountKey,
          companyId: expectedCompanyId,
          actorResourceId,
        });

        // 3. Private attachment fetch and validation
        const privateAtt = await fetchPrivatePdfAttachment({
          ticketId,
          attachmentId,
          expectedCompanyId,
          expectedSha256,
        });

        // 4. Arm sticky dispatch barrier before external Drive upload
        await session.armDispatch();

        // 5. Upload to Drive and verify readback
        const provider = new DriveArchiveProvider();
        const receipt = await provider.uploadAndVerify({
          operationId,
          attachment: privateAtt,
          binding,
        });

        // 6. Mark verified and clear dispatch barrier
        await session.markVerified(receipt as unknown as Record<string, unknown>);

        return {
          content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }],
          structuredContent: receipt,
        };
      } catch (err: unknown) {
        if (session.isArmed()) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await session.markUncertain(errMsg);
        }
        throw err;
      } finally {
        await session.release();
      }
    },
  },
];
