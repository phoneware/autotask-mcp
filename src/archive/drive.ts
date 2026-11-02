import crypto from 'node:crypto';
import type {
  ArchiveReceipt,
  AttachmentMetadata,
  CompanyArchiveBinding,
  PrivateAttachment,
} from '../provisioning/contracts.js';
import { ArchiveCredentialProvider } from './credentials.js';
import {
  readBoundedJson,
  readBoundedText,
  readBoundedAndHash,
  MAX_DRIVE_METADATA_BYTES,
  MAX_PDF_MEDIA_BYTES,
} from '../bounded-response.js';
import { safeDriveError, safeCoordinatorError, sanitizeErrorMessage } from '../safe-errors.js';
import {
  consumeDispatchPermit,
  computeBodyDigest,
  type DispatchPermitToken,
} from '../provisioning/dispatch.js';

export interface DriveUploaderConfig {
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  credentialProvider?: ArchiveCredentialProvider;
}

interface RawDriveFileMeta {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string | number;
  sha256Checksum?: string;
  parents?: string[];
  driveId?: string;
  trashed?: boolean;
}

interface RawDriveFolderMeta {
  id?: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
  driveId?: string;
  capabilities?: { canAddChildren?: boolean };
}

export class DriveArchiveProvider {
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly credProvider: ArchiveCredentialProvider;

  constructor(config?: DriveUploaderConfig) {
    this.apiBase = (
      config?.apiBaseUrl ||
      process.env.DRIVE_API_BASE_URL ||
      'https://www.googleapis.com/drive/v3'
    ).replace(/\/+$/, '');
    this.uploadBase = (
      config?.uploadBaseUrl ||
      process.env.DRIVE_UPLOAD_BASE_URL ||
      'https://www.googleapis.com/upload/drive/v3'
    ).replace(/\/+$/, '');
    this.credProvider = config?.credentialProvider || new ArchiveCredentialProvider();
  }

  async resolveAccessToken(archivePrincipal: string): Promise<string> {
    if (!archivePrincipal?.trim()) {
      throw new Error('archivePrincipal is required to resolve Drive access token');
    }
    return this.credProvider.getDriveAccessToken(archivePrincipal);
  }

  /**
   * Preflight verification of destination Shared Drive folder.
   * Enforces observed folder ID, folder MIME, Shared Drive ID, trashed === false, and canAddChildren === true.
   */
  async preflightDestination(binding: CompanyArchiveBinding, token: string): Promise<void> {
    const folderUrl = `${this.apiBase}/files/${encodeURIComponent(
      binding.folderId,
    )}?fields=id,name,mimeType,trashed,driveId,capabilities&supportsAllDrives=true`;

    let folderRes: Response;
    try {
      folderRes = await fetch(folderUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw safeDriveError(500, 'DRIVE_NETWORK_ERROR', { error: sanitizeErrorMessage(msg) });
    }

    if (!folderRes.ok) {
      throw safeDriveError(folderRes.status, 'DRIVE_FOLDER_VERIFICATION_FAILED');
    }

    const folderMeta = await readBoundedJson<RawDriveFolderMeta>(
      folderRes,
      MAX_DRIVE_METADATA_BYTES,
      'Drive destination folder',
    );

    if (folderMeta.id !== binding.folderId) {
      throw new Error(
        `Drive destination folder ID mismatch: observed "${folderMeta.id}", expected "${binding.folderId}"`,
      );
    }

    if (folderMeta.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(
        `Drive destination resource is not a folder (mimeType: "${folderMeta.mimeType}")`,
      );
    }

    if (folderMeta.trashed !== false) {
      throw new Error(
        `Drive destination folder ${binding.folderId} is in trash or trash status unverified; archival refused`,
      );
    }

    if (!folderMeta.driveId || folderMeta.driveId !== binding.driveId) {
      throw new Error(
        `Drive Shared Drive mismatch: folder belongs to drive "${folderMeta.driveId ?? 'My Drive'}", binding requires "${binding.driveId}"`,
      );
    }

    if (folderMeta.capabilities?.canAddChildren !== true) {
      throw new Error(
        `Drive destination folder ${binding.folderId} does not permit adding children for the archive principal`,
      );
    }
  }

  /**
   * Pre-allocate Drive file ID before arming dispatch.
   */
  async generateFileId(archivePrincipal: string, token: string): Promise<string> {
    const url = `${this.apiBase}/files/generateIds?count=1&supportsAllDrives=true`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw safeDriveError(500, 'DRIVE_ID_ALLOCATION_FAILED', { error: sanitizeErrorMessage(msg) });
    }

    if (!res.ok) {
      throw safeDriveError(res.status, 'DRIVE_ID_ALLOCATION_FAILED');
    }

    const json = await readBoundedJson<{ ids?: string[] }>(
      res,
      MAX_DRIVE_METADATA_BYTES,
      'Drive generateIds',
    );

    if (Array.isArray(json.ids) && json.ids[0]) {
      return json.ids[0];
    }

    throw new Error('Failed to allocate Drive file ID from files.generateIds: empty response');
  }

  /**
   * One strict verifier for initial upload, existing-file recovery, and collision recovery.
   * Requires affirmative observed Shared Drive ID, exact single parent, PDF MIME, exact size, trashed === false, and SHA-256.
   */
  async verifyDriveFile(params: {
    meta: RawDriveFileMeta;
    expectedFileId: string;
    expectedFolderId: string;
    expectedSharedDriveId: string;
    expectedByteLength: number;
    expectedSha256: string;
    token: string;
  }): Promise<{ sha256: string; driveId: string }> {
    const { meta } = params;

    if (meta.trashed !== false) {
      throw new Error(
        `Drive verification failed: file ${params.expectedFileId} is in trash or trash state unverified`,
      );
    }

    if (meta.id !== params.expectedFileId) {
      throw new Error(
        `Drive verification failed: returned file ID "${meta.id}" does not match expected "${params.expectedFileId}"`,
      );
    }

    // Exact single parent placement
    if (
      !Array.isArray(meta.parents) ||
      meta.parents.length !== 1 ||
      meta.parents[0] !== params.expectedFolderId
    ) {
      throw new Error(
        `Drive verification failed: file parents do not match approved folderId ${params.expectedFolderId}`,
      );
    }

    // Affirmative Shared Drive verification (rejects My Drive / missing driveId)
    if (!meta.driveId || typeof meta.driveId !== 'string' || !meta.driveId.trim()) {
      throw new Error(
        'Drive verification failed: file is not in a Shared Drive (missing driveId in observation)',
      );
    }
    if (meta.driveId !== params.expectedSharedDriveId) {
      throw new Error(
        `Drive verification failed: observed driveId "${meta.driveId}" does not match approved Shared Drive "${params.expectedSharedDriveId}"`,
      );
    }

    if (meta.mimeType !== 'application/pdf') {
      throw new Error(
        `Drive verification failed: observed mimeType "${meta.mimeType}" is not application/pdf`,
      );
    }

    const actualSize = typeof meta.size === 'string' ? Number(meta.size) : meta.size;
    if (actualSize !== params.expectedByteLength) {
      throw new Error(
        `Drive verification failed: observed size ${actualSize} does not match expected size ${params.expectedByteLength}`,
      );
    }

    let observedSha256 = meta.sha256Checksum;
    if (!observedSha256) {
      // Incremental media hash with 5 MB ceiling
      const mediaUrl = `${this.apiBase}/files/${encodeURIComponent(
        params.expectedFileId,
      )}?alt=media&supportsAllDrives=true`;
      const mediaRes = await fetch(mediaUrl, {
        headers: { Authorization: `Bearer ${params.token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!mediaRes.ok) {
        throw safeDriveError(mediaRes.status, 'DRIVE_MEDIA_FETCH_FAILED');
      }

      const streamResult = await readBoundedAndHash(
        mediaRes,
        MAX_PDF_MEDIA_BYTES,
        'Drive media checksum stream',
      );
      observedSha256 = streamResult.sha256;
    }

    if (observedSha256.toLowerCase() !== params.expectedSha256.toLowerCase()) {
      throw new Error(
        `Drive verification failed: observed SHA-256 "${observedSha256}" does not match source SHA-256 "${params.expectedSha256}"`,
      );
    }

    return { sha256: observedSha256.toLowerCase(), driveId: meta.driveId };
  }

  /**
   * Dedicated read-only reconciliation method with ZERO upload/mutation path.
   * Revalidates destination folder as well as file metadata.
   */
  async reconcileStoredArchive(params: {
    operationId: string;
    sourceMetadata: AttachmentMetadata;
    binding: CompanyArchiveBinding;
    fileId: string;
    token?: string;
  }): Promise<ArchiveReceipt> {
    const token = params.token || (await this.resolveAccessToken(params.binding.archivePrincipal));

    // Revalidate destination folder during recovery too
    await this.preflightDestination(params.binding, token);

    const readUrl = `${this.apiBase}/files/${encodeURIComponent(
      params.fileId,
    )}?fields=id,name,mimeType,size,sha256Checksum,parents,driveId,trashed&supportsAllDrives=true`;

    let res: Response;
    try {
      res = await fetch(readUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw safeDriveError(500, 'DRIVE_READBACK_FAILED', { error: sanitizeErrorMessage(msg) });
    }

    if (!res.ok) {
      throw safeDriveError(res.status, 'DRIVE_FILE_READBACK_FAILED');
    }

    const meta = await readBoundedJson<RawDriveFileMeta>(
      res,
      MAX_DRIVE_METADATA_BYTES,
      'Drive file readback',
    );

    const verified = await this.verifyDriveFile({
      meta,
      expectedFileId: params.fileId,
      expectedFolderId: params.binding.folderId,
      expectedSharedDriveId: params.binding.driveId,
      expectedByteLength: params.sourceMetadata.byteLength,
      expectedSha256: params.sourceMetadata.sha256,
      token,
    });

    return {
      operationId: params.operationId,
      status: 'verified',
      kind: 'attachment_archive',
      source: params.sourceMetadata,
      destination: {
        provider: 'google-drive',
        driveId: verified.driveId,
        folderId: params.binding.folderId,
        fileId: params.fileId,
        mimeType: 'application/pdf',
        byteLength: params.sourceMetadata.byteLength,
        sha256: verified.sha256,
        trashed: false,
      },
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Build frozen multipart payload, boundary, and upload URL.
   */
  buildMultipartRequestBody(
    fileId: string,
    filename: string,
    folderId: string,
    bytes: Buffer,
    fixedBoundary?: string,
  ): { multipartBody: Buffer; boundary: string; uploadUrl: string } {
    const boundary = fixedBoundary || `----DriveBoundary${crypto.randomBytes(16).toString('hex')}`;
    const fileMetadata = {
      id: fileId,
      name: filename,
      mimeType: 'application/pdf',
      parents: [folderId],
    };

    const header = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(fileMetadata),
      `--${boundary}`,
      'Content-Type: application/pdf',
      '',
      '',
    ].join('\r\n');

    const footer = `\r\n--${boundary}--`;
    const multipartBody = Buffer.concat([
      Buffer.from(header, 'utf-8'),
      bytes,
      Buffer.from(footer, 'utf-8'),
    ]);

    const uploadUrl = `${this.uploadBase}/files?uploadType=multipart&supportsAllDrives=true`;
    return { multipartBody, boundary, uploadUrl };
  }

  /**
   * Initial upload path. Calls single multipart POST and authoritative verify.
   */
  async uploadPreparedOnce(params: {
    operationId: string;
    attachment: PrivateAttachment;
    binding: CompanyArchiveBinding;
    fileId: string;
    token: string;
    permitToken: DispatchPermitToken;
    frozenMultipartBody?: Buffer;
    boundary?: string;
  }): Promise<ArchiveReceipt> {
    if (!params.permitToken) {
      throw new Error('Refused: Drive archive upload requires a valid dispatch permit token');
    }

    const { multipartBody, boundary, uploadUrl } = params.frozenMultipartBody && params.boundary
      ? { multipartBody: params.frozenMultipartBody, boundary: params.boundary, uploadUrl: `${this.uploadBase}/files?uploadType=multipart&supportsAllDrives=true` }
      : this.buildMultipartRequestBody(
          params.fileId,
          params.attachment.metadata.filename,
          params.binding.folderId,
          params.attachment.bytes,
          params.boundary,
        );

    consumeDispatchPermit(params.permitToken, {
      provider: 'google-drive',
      method: 'POST',
      route: uploadUrl,
      bodyDigest: computeBodyDigest(multipartBody),
    });

    const uploadHeaders: Record<string, string> = {
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(multipartBody.byteLength),
      Authorization: `Bearer ${params.token}`,
    };

    let uploadRes: Response;
    try {
      uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: uploadHeaders,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        body: multipartBody,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw safeCoordinatorError(
        'DRIVE_UPLOAD_UNCERTAIN',
        `Drive upload dispatch uncertain: ${sanitizeErrorMessage(msg)}`,
      );
    }

    if (!uploadRes.ok) {
      if (uploadRes.status === 409) {
        // Read back on 409 conflict using the exact strict verifier
        return this.reconcileStoredArchive({
          operationId: params.operationId,
          sourceMetadata: params.attachment.metadata,
          binding: params.binding,
          fileId: params.fileId,
          token: params.token,
        });
      }
      throw safeDriveError(uploadRes.status, 'DRIVE_UPLOAD_FAILED');
    }

    // Authoritative post-upload readback verification
    return this.reconcileStoredArchive({
      operationId: params.operationId,
      sourceMetadata: params.attachment.metadata,
      binding: params.binding,
      fileId: params.fileId,
      token: params.token,
    });
  }
}
