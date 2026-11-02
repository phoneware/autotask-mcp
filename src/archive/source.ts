import crypto from 'node:crypto';
import { api } from '../autotask-api.js';
import { assertSafeNumericId } from '../security.js';
import type { AttachmentMetadata, PrivateAttachment } from '../provisioning/contracts.js';

export const MAX_PDF_BYTES = 5_000_000; // 5 MB decoded ceiling
export const MAX_ENVELOPE_BYTES = 7_000_000; // 7 MB response envelope ceiling

export interface TicketAttachmentModel {
  id?: number | string;
  ticketID?: number | string;
  title?: string;
  contentType?: string;
  fileSize?: number;
  data?: string;
  [key: string]: unknown;
}

interface TicketModel {
  id?: number | string;
  companyID?: number | string;
  [key: string]: unknown;
}

export function unwrapSingleAttachment(
  raw: unknown,
  expectedId?: string,
): TicketAttachmentModel {
  if (!raw || typeof raw !== 'object') return {};

  if ('items' in raw && Array.isArray((raw as { items: unknown[] }).items)) {
    const items = (raw as { items: unknown[] }).items;
    if (items.length === 0) return {};
    if (expectedId) {
      const match = items.filter(
        (it) => it && typeof it === 'object' && String((it as { id?: unknown }).id) === expectedId,
      );
      if (match.length === 1) return match[0] as TicketAttachmentModel;
      if (match.length > 1) {
        throw new Error(
          `Ambiguous attachment envelope: multiple records match attachment ID ${expectedId}`,
        );
      }
      return {};
    }
    if (items.length === 1) {
      return items[0] as TicketAttachmentModel;
    }
    throw new Error(
      `Ambiguous attachment envelope: expected exactly one attachment record, got ${items.length}`,
    );
  }

  if (
    'item' in raw &&
    (raw as { item: unknown }).item &&
    typeof (raw as { item: unknown }).item === 'object'
  ) {
    return (raw as { item: unknown }).item as TicketAttachmentModel;
  }

  return raw as TicketAttachmentModel;
}

function unwrapTicket(raw: unknown): TicketModel {
  if (raw && typeof raw === 'object') {
    if ('item' in raw && (raw as { item: unknown }).item && typeof (raw as { item: unknown }).item === 'object') {
      return (raw as { item: unknown }).item as TicketModel;
    }
    return raw as TicketModel;
  }
  return {};
}

/**
 * Fetch and validate an Autotask ticket attachment for archival.
 * Enforces parent ticket scoping, company verification, PDF MIME type, %PDF- magic prefix,
 * size ceiling, and SHA-256 integrity verification.
 * Keeps binary bytes strictly private.
 */
export async function fetchPrivatePdfAttachment(params: {
  ticketId: string;
  attachmentId: string;
  expectedCompanyId?: string;
  expectedSha256?: string;
}): Promise<PrivateAttachment> {
  const safeTicketId = assertSafeNumericId(params.ticketId, 'ticketId');
  const safeAttachmentId = assertSafeNumericId(params.attachmentId, 'attachmentId');

  // 1. Validate parent ticket and company
  const ticketRes = await api.getById('Tickets', safeTicketId);
  const ticket = unwrapTicket(ticketRes);
  if (!ticket || Object.keys(ticket).length === 0) {
    throw new Error(`Ticket ${safeTicketId} not found`);
  }

  if (ticket.id === undefined || ticket.id === null || String(ticket.id) !== safeTicketId) {
    throw new Error(
      `Ticket ID mismatch: requested ticket ${safeTicketId} but record returned id ${ticket.id ?? 'unknown'}`,
    );
  }

  const actualCompanyId = String(ticket.companyID ?? '');
  if (!actualCompanyId) {
    throw new Error(`Ticket ${safeTicketId} has no associated companyID; archival refused`);
  }

  if (params.expectedCompanyId) {
    const safeExpectedCompanyId = assertSafeNumericId(params.expectedCompanyId, 'expectedCompanyId');
    if (actualCompanyId !== safeExpectedCompanyId) {
      throw new Error(
        `Company mismatch: ticket ${safeTicketId} belongs to companyID ${actualCompanyId}, not expected ${safeExpectedCompanyId}; archival refused`,
      );
    }
  }

  // 2. Fetch parent-scoped attachment with supported envelopes normalized
  const attRes = await api.request(
    'GET',
    `V1.0/Tickets/${encodeURIComponent(safeTicketId)}/Attachments/${encodeURIComponent(safeAttachmentId)}`,
  );
  const att = unwrapSingleAttachment(attRes, safeAttachmentId);
  if (!att || Object.keys(att).length === 0) {
    throw new Error(`Attachment ${safeAttachmentId} not found on ticket ${safeTicketId}`);
  }

  // Enforce attachment ID match
  if (att.id === undefined || att.id === null || String(att.id) !== safeAttachmentId) {
    throw new Error(
      `Attachment ID mismatch: requested attachment ${safeAttachmentId} but record returned id ${att.id ?? 'unknown'}; access refused`,
    );
  }

  // Enforce parent ticket relationship (fails closed on absent or wrong parent)
  if (
    att.ticketID === undefined ||
    att.ticketID === null ||
    String(att.ticketID) !== safeTicketId
  ) {
    throw new Error(
      `Parent mismatch: attachment ${safeAttachmentId} belongs to ticketID ${att.ticketID ?? 'unknown'}, not ${safeTicketId}; access refused`,
    );
  }

  // 3. Validate PDF MIME type
  const rawContentType = typeof att.contentType === 'string' ? att.contentType.trim() : '';
  const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
  if (mimeType !== 'application/pdf') {
    throw new Error(
      `Refused: attachment ${safeAttachmentId} has MIME type "${rawContentType || 'unknown'}", expected "application/pdf" for archival`,
    );
  }

  // 4. Extract and validate base64
  const rawData = typeof att.data === 'string' ? att.data : '';
  const base64Data = rawData.replace(/^data:[^;]+;base64,/, '').trim();
  if (!base64Data) {
    throw new Error(`Attachment ${safeAttachmentId} on ticket ${safeTicketId} contains no binary data`);
  }

  // Bounded encoded check before decoding buffer
  const maxEncodedLen = Math.ceil((MAX_PDF_BYTES * 4) / 3) + 16;
  if (base64Data.length > maxEncodedLen || base64Data.length > MAX_ENVELOPE_BYTES) {
    throw new Error(
      `Attachment size exceeds maximum permitted size of ${MAX_PDF_BYTES} bytes for archival`,
    );
  }

  // Strict base64 validation (valid alphabet and padding)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data) || base64Data.length % 4 !== 0) {
    throw new Error(`Integrity check failed: attachment data contains malformed base64`);
  }

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.byteLength === 0) {
    throw new Error(`Attachment ${safeAttachmentId} decoded to zero bytes`);
  }

  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `Attachment size (${buffer.byteLength} bytes) exceeds maximum permitted size of ${MAX_PDF_BYTES} bytes for archival`,
    );
  }

  // Check consistency with declared fileSize if present
  if (typeof att.fileSize === 'number' && att.fileSize > 0 && att.fileSize !== buffer.byteLength) {
    throw new Error(
      `Integrity check failed: declared fileSize (${att.fileSize}) does not match decoded bytes (${buffer.byteLength})`,
    );
  }

  // 5. Magic bytes check: %PDF- (0x25 0x50 0x44 0x46 0x2D)
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(
      `Integrity check failed: attachment content does not have valid PDF magic bytes (%PDF-)`,
    );
  }

  // 6. SHA-256 verification
  const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (params.expectedSha256) {
    const expected = params.expectedSha256.trim().toLowerCase();
    if (actualSha256.toLowerCase() !== expected) {
      throw new Error(
        `Integrity check failed: expected SHA-256 ${params.expectedSha256} but got ${actualSha256}`,
      );
    }
  }

  const metadata: AttachmentMetadata = {
    ticketId: String(ticket.id),
    attachmentId: String(att.id),
    companyId: actualCompanyId,
    filename:
      typeof att.title === 'string' && att.title.trim()
        ? att.title.trim()
        : `ticket-${ticket.id}-attachment-${att.id}.pdf`,
    mimeType: 'application/pdf',
    byteLength: buffer.byteLength,
    sha256: actualSha256,
  };

  return {
    metadata,
    bytes: buffer,
  };
}
