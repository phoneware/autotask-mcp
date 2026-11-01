import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
        destinationPath: {
          type: 'string',
          description:
            'Optional local file path to save binary document content directly without base64 in output',
        },
        expectedSha256: {
          type: 'string',
          description: 'Optional expected SHA256 hex digest when destinationPath is provided',
        },
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

      // If destinationPath provided, transfer binary content directly to destination
      if (args.destinationPath && typeof args.destinationPath === 'string' && args.destinationPath.trim() !== '') {
        const dest = path.resolve(args.destinationPath.trim());
        if (!base64Data) {
          throw new Error(`Attachment ${attachmentId} on ticket ${ticketId} contains no binary data`);
        }
        const buffer = Buffer.from(base64Data, 'base64');
        const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        if (args.expectedSha256) {
          const expected = String(args.expectedSha256).trim().toLowerCase();
          if (actualSha256.toLowerCase() !== expected) {
            throw new Error(
              `Integrity check failed: expected SHA-256 ${args.expectedSha256} but got ${actualSha256}`,
            );
          }
        }
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, buffer);
        const metadata = {
          id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
          ticketID: att.ticketID !== undefined ? Number(att.ticketID) : Number(ticketId),
          title,
          contentType: rawContentType || 'application/octet-stream',
          fileSize: buffer.byteLength,
          sha256: actualSha256,
          destinationPath: dest,
          transferred: true,
          attached_as_image: false,
          verified: true,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }],
          structuredContent: metadata,
        };
      }

      if (!isImage) {
        const metadata = {
          id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
          ticketID: att.ticketID !== undefined ? Number(att.ticketID) : Number(ticketId),
          title,
          contentType: rawContentType || 'application/octet-stream',
          fileSize: typeof att.fileSize === 'number' ? att.fileSize : decodedBytes,
          attached_as_image: false,
          reason: `Content type "${rawContentType || 'unknown'}" is not an image; inline image content omitted. Use transfer-ticket-attachment or supply destinationPath to transfer binary documents directly.`,
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
    name: 'transfer-ticket-attachment',
    title: 'Transfer Ticket Attachment',
    description:
      'Transfer an attachment (PDF, document, or image) from an Autotask ticket directly to a local destination file for archival or verification. ' +
      'Validates parent ticket ownership, MIME type, and size limits, decodes binary data, verifies SHA-256 hash, and saves to destination without dumping raw bytes into model output.',
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
        destinationPath: {
          type: 'string',
          description:
            'Absolute or relative local file path where binary content will be saved',
        },
        expectedSha256: {
          type: 'string',
          description: 'Optional expected SHA256 hex digest to verify content integrity',
        },
        allowedMimeTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of allowed MIME types (e.g. ["application/pdf", "image/png"]). Defaults to safe document/image types.',
        },
        maxSizeBytes: {
          type: 'number',
          description: 'Maximum permitted attachment size in bytes (default 50 MB)',
        },
      },
      required: ['ticketID', 'attachmentID', 'destinationPath'],
    },
    handler: async (args): Promise<ToolResponse> => {
      const ticketId = assertSafeNumericId(args.ticketID, 'ticketID');
      const attachmentId = assertSafeNumericId(args.attachmentID, 'attachmentID');

      if (
        !args.destinationPath ||
        typeof args.destinationPath !== 'string' ||
        args.destinationPath.trim() === ''
      ) {
        throw new Error('destinationPath must be a non-empty string');
      }
      const destinationPath = path.resolve(args.destinationPath.trim());

      // Fetch attachment from Autotask
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

      // Check disallowed executable types
      const DISALLOWED_MIMES: Record<string, true> = {
        'application/x-msdownload': true,
        'application/x-executable': true,
        'application/x-dosexec': true,
        'application/x-sh': true,
        'application/x-bat': true,
        'application/x-msdos-program': true,
        'application/octet-stream-executable': true,
      };
      if (DISALLOWED_MIMES[mimeType]) {
        throw new Error(
          `Refused: attachment MIME type "${mimeType}" is a disallowed executable type`,
        );
      }

      // Check allowed MIME types if caller provided filter
      if (Array.isArray(args.allowedMimeTypes) && args.allowedMimeTypes.length > 0) {
        const normalizedAllowed = args.allowedMimeTypes.map((m: unknown) =>
          String(m).toLowerCase().trim(),
        );
        if (!normalizedAllowed.includes(mimeType)) {
          throw new Error(
            `Refused: attachment MIME type "${mimeType}" is not in allowedMimeTypes list: ${normalizedAllowed.join(', ')}`,
          );
        }
      }

      const maxBytes =
        typeof args.maxSizeBytes === 'number' && args.maxSizeBytes > 0
          ? args.maxSizeBytes
          : 50 * 1024 * 1024; // 50 MB default

      const rawData = typeof att.data === 'string' ? att.data : '';
      const base64Data = rawData.replace(/^data:[^;]+;base64,/, '').trim();

      if (!base64Data) {
        throw new Error(`Attachment ${attachmentId} on ticket ${ticketId} contains no binary data`);
      }

      const buffer = Buffer.from(base64Data, 'base64');
      if (buffer.byteLength > maxBytes) {
        throw new Error(
          `Attachment size (${buffer.byteLength} bytes) exceeds maximum permitted size of ${maxBytes} bytes`,
        );
      }

      const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      if (args.expectedSha256) {
        const expected = String(args.expectedSha256).trim().toLowerCase();
        if (actualSha256.toLowerCase() !== expected) {
          throw new Error(
            `Integrity check failed: expected SHA-256 ${args.expectedSha256} but got ${actualSha256}`,
          );
        }
      }

      // Ensure directory exists and write binary content to destination
      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.promises.writeFile(destinationPath, buffer);

      const stat = await fs.promises.stat(destinationPath);
      if (stat.size !== buffer.byteLength) {
        throw new Error(
          'Write verification failed: file size on disk does not match transferred bytes',
        );
      }

      const metadata = {
        ticketID: Number(ticketId),
        attachmentID: Number(attachmentId),
        title,
        contentType: rawContentType || 'application/octet-stream',
        fileSize: buffer.byteLength,
        sha256: actualSha256,
        destinationPath,
        transferred: true,
        verified: true,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }],
        structuredContent: metadata,
      };
    },
  },
];
