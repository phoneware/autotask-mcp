import type { ToolDefinition, ToolResponse } from '../types.js';
import { api } from '../autotask-api.js';
import { assertSafeNumericId } from '../security.js';
import { currentCaller, resolveActorOrThrow } from '../auth/context.js';
import {
  fetchPrivatePdfAttachment,
  unwrapSingleAttachment,
  type TicketAttachmentModel,
} from '../archive/source.js';
import {
  assertAuthorizedArchiveBinding,
  computeBindingFingerprint,
} from '../archive/bindings.js';
import { DriveArchiveProvider } from '../archive/drive.js';
import { ArchiveCredentialProvider } from '../archive/credentials.js';
import {
  TicketCoordinatorSession,
  withTicketOperation,
} from '../provisioning/ticket-coordinator.js';
import { computeBodyDigest } from '../provisioning/dispatch.js';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB decoded

function isVerifiedImageBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 4) return false;
  if (mimeType === 'image/png' && buffer.subarray(0, 4).toString('hex') === '89504e47') {
    return true;
  }
  if (mimeType === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return true;
  }
  if (mimeType === 'image/gif' && buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return true;
  }
  if (
    mimeType === 'image/webp' &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.length >= 12 &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return true;
  }
  return false;
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

      const att = unwrapSingleAttachment(rawRes, attachmentId);
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
      let decodedBuffer: Buffer | null = null;
      if (base64Data.length > 0) {
        decodedBuffer = Buffer.from(base64Data, 'base64');
        decodedBytes = decodedBuffer.byteLength;
      } else if (typeof att.fileSize === 'number') {
        decodedBytes = att.fileSize;
      }

      if (!isImage) {
        // Use shared strict PDF validator if application/pdf to ensure exact inspection/archive parity
        let sha256: string | undefined = undefined;
        if (mimeType === 'application/pdf') {
          try {
            const validated = await fetchPrivatePdfAttachment({ ticketId, attachmentId });
            sha256 = validated.metadata.sha256;
          } catch {
            // If strict validation fails (malformed/oversized), omit sha256
          }
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

      // MIME-spoofing check on explicit image branch
      if (decodedBuffer && !isVerifiedImageBytes(decodedBuffer, mimeType)) {
        const metadata = {
          id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
          ticketID: Number(ticketId),
          title,
          contentType: rawContentType,
          fileSize: decodedBytes,
          attached_as_image: false,
          reason: 'Attachment bytes do not match expected image magic signature; inline image content omitted.',
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }],
          structuredContent: metadata,
        };
      }

      if (decodedBytes > MAX_IMAGE_BYTES) {
        const metadata = {
          id: att.id !== undefined ? Number(att.id) : Number(attachmentId),
          ticketID: Number(ticketId),
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
          ticketID: Number(ticketId),
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
        ticketID: Number(ticketId),
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

      const actor = resolveActorOrThrow();

      return withTicketOperation(
        {
          ticketId,
          actor,
          operationId,
          kind: 'attachment_archive',
          payload: {
            ticketID: ticketId,
            attachmentID: attachmentId,
            expectedCompanyID: expectedCompanyId,
            expectedSha256,
          },
        },
        async (session) => {
          const op = session.getOperation();
          if (op?.phase === 'verified') {
            const receipt = op.receipt ?? { status: 'verified', operationId };
            return {
              content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }],
              structuredContent: receipt as unknown as Record<string, unknown>,
            };
          }

          const provider = new DriveArchiveProvider();
          const existingPrepared = op?.preparedState;
          let fileId = (existingPrepared?.driveFileId as string) || '';

          // 1. Destination binding authorization check
          const binding = await assertAuthorizedArchiveBinding({
            accountKey: session.accountKey,
            companyId: expectedCompanyId,
            actorResourceId: actor.resourceId,
          });

          // 2. Preflight credentials
          const credProvider = new ArchiveCredentialProvider();
          const cred = await credProvider.getDriveCredential(binding.archivePrincipal);

          // 3. Read-only recovery reconciliation if in recovery mode
          const isRecovery = session.getClaim()?.mode === 'reconciling';
          if (isRecovery && fileId && existingPrepared?.sourceMetadata) {
            try {
              const receipt = await provider.reconcileStoredArchive({
                operationId,
                sourceMetadata: existingPrepared.sourceMetadata as unknown as AttachmentMetadata,
                binding,
                fileId,
                token: cred.accessToken,
              });
              await session.markVerified(receipt);
              return {
                content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }],
                structuredContent: receipt as unknown as Record<string, unknown>,
              };
            } catch {
              throw new Error(
                `Conflict: operation "${operationId}" has an uncertain dispatch and file was not verified in Drive; read-only reconciliation required`,
              );
            }
          }

          // 4. Preflight destination folder in Google Drive BEFORE arming dispatch
          await provider.preflightDestination(binding, cred.accessToken);

          // 5. Private attachment fetch and validation
          const privateAtt = await fetchPrivatePdfAttachment({
            ticketId,
            attachmentId,
            expectedCompanyId,
            expectedSha256,
          });

          // 6. Pre-allocate Drive file ID before arming
          if (!fileId) {
            fileId = await provider.generateFileId(binding.archivePrincipal, cred.accessToken);
          }

          const policyFingerprint = computeBindingFingerprint(binding);

          // 7. Fenced preparation commit (write-once)
          await session.commitPreparation({
            sourceMetadata: privateAtt.metadata,
            driveFileId: fileId,
            policyFingerprint,
          });

          // 8. Re-check binding version right before arming
          await assertAuthorizedArchiveBinding({
            accountKey: session.accountKey,
            companyId: expectedCompanyId,
            actorResourceId: actor.resourceId,
            expectedVersion: binding.version,
          });

          const uploadRoute = `${process.env.DRIVE_UPLOAD_BASE_URL || 'https://www.googleapis.com/upload/drive/v3'}/files?uploadType=multipart&supportsAllDrives=true`;

          // 9. Arm sticky dispatch barrier before external upload
          const armRes = await session.armDispatch({
            requiredBindingId: `${session.accountKey}_${expectedCompanyId}`,
            expectedPolicyRevision: binding.version,
            policyFingerprint,
            provider: 'google-drive',
            canonicalRoute: uploadRoute,
            method: 'POST',
            exactBodyDigest: computeBodyDigest(privateAtt.bytes),
          });

          try {
            // 10. Single upload and verify readback
            const receipt = await provider.uploadPreparedOnce({
              operationId,
              attachment: privateAtt,
              binding,
              fileId,
              token: cred.accessToken,
              permitToken: armRes.permitToken,
            });

            // 11. Mark verified and clear dispatch barrier
            await session.markVerified(receipt);

            return {
              content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }],
              structuredContent: receipt as unknown as Record<string, unknown>,
            };
          } catch (err: unknown) {
            if (session.isArmed()) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await session.markUncertain(errMsg);
            }
            throw err;
          }
        },
      );
    },
  },
];
