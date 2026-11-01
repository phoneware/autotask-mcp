import type { ToolDefinition, ToolResponse } from '../types.js';
import { api } from '../autotask-api.js';
import { assertSafeNumericId } from '../security.js';

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

      // Enforce parent ticket relationship
      if (
        att.ticketID !== undefined &&
        att.ticketID !== null &&
        String(att.ticketID) !== ticketId
      ) {
        throw new Error(
          `Parent mismatch: attachment ${attachmentId} belongs to ticketID ${att.ticketID}, not ${ticketId}; access refused`,
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
        const metadata = {
          id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
          ticketID: att.ticketID !== undefined ? Number(att.ticketID) : Number(ticketId),
          title,
          contentType: rawContentType || 'application/octet-stream',
          fileSize: typeof att.fileSize === 'number' ? att.fileSize : decodedBytes,
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
];
