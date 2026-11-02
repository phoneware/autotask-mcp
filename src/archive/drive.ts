import crypto from 'node:crypto';
import type {
  ArchiveReceipt,
  AttachmentMetadata,
  CompanyArchiveBinding,
  PrivateAttachment,
} from '../provisioning/contracts.js';
import { ArchiveCredentialProvider } from './credentials.js';

export interface DriveUploaderConfig {
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  accessToken?: string;
}

function truncateError(raw: string): string {
  const clean = raw.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]').trim();
  return clean.length > 140 ? clean.slice(0, 140) + '...[truncated]' : clean;
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

export class DriveArchiveProvider {
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly staticToken: string | null;

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
    this.staticToken = config?.accessToken || process.env.DRIVE_ARCHIVE_ACCESS_TOKEN || null;
  }

  async resolveAccessToken(archivePrincipal?: string): Promise<string> {
    if (this.staticToken) return this.staticToken;
    const isLocalMirror = this.apiBase.includes('127.0.0.1') || this.apiBase.includes('localhost');
    if (isLocalMirror) return 'synthetic-mirror-token';
    if (!archivePrincipal) {
      throw new Error('archivePrincipal is required to resolve Drive access token');
    }
    const credProvider = new ArchiveCredentialProvider();
    return credProvider.getDriveAccessToken(archivePrincipal);
  }

  async generateFileId(archivePrincipal?: string): Promise<string> {
    const isLocalMirror = this.apiBase.includes('127.0.0.1') || this.apiBase.includes('localhost');
    const token = await this.resolveAccessToken(archivePrincipal);

    const url = `${this.apiBase}/files/generateIds?count=1&supportsAllDrives=true`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (res.ok) {
        const json = (await res.json()) as { ids?: string[] };
        if (Array.isArray(json.ids) && json.ids[0]) {
          return json.ids[0];
        }
      }
    } catch (err: unknown) {
      if (isLocalMirror) {
        return crypto.randomUUID();
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to allocate Drive file ID from files.generateIds: ${truncateError(msg)}`);
    }

    if (isLocalMirror) {
      return crypto.randomUUID();
    }
    throw new Error('Failed to allocate Drive file ID from files.generateIds: empty response');
  }

  /**
   * One strict verifier for initial upload, existing-file recovery, and collision recovery.
   * Requires affirmative observed Shared Drive ID, exact single parent, PDF MIME, exact size, and SHA-256.
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

    if (meta.trashed) {
      throw new Error(`Drive verification failed: file ${params.expectedFileId} is in trash`);
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
        `Drive verification failed: file is not in a Shared Drive (missing driveId in observation)`,
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
      });
      if (!mediaRes.ok) {
        throw new Error(
          `Drive media fetch failed during checksum verification (${mediaRes.status})`,
        );
      }
      const mediaBuf = Buffer.from(await mediaRes.arrayBuffer());
      if (mediaBuf.byteLength > 5_000_000) {
        throw new Error('Drive media exceeds 5 MB size ceiling during verification');
      }
      observedSha256 = crypto.createHash('sha256').update(mediaBuf).digest('hex');
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
   */
  async reconcileStoredArchive(params: {
    operationId: string;
    sourceMetadata: AttachmentMetadata;
    binding: CompanyArchiveBinding;
    fileId: string;
  }): Promise<ArchiveReceipt> {
    const token = await this.resolveAccessToken(params.binding.archivePrincipal);
    const readUrl = `${this.apiBase}/files/${encodeURIComponent(
      params.fileId,
    )}?fields=id,name,mimeType,size,sha256Checksum,parents,driveId,trashed&supportsAllDrives=true`;

    const res = await fetch(readUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Drive file readback returned status ${res.status}`);
    }

    const meta = (await res.json()) as RawDriveFileMeta;
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
      source: params.sourceMetadata,
      destination: {
        provider: 'google-drive',
        driveId: verified.driveId,
        folderId: params.binding.folderId,
        fileId: params.fileId,
        byteLength: params.sourceMetadata.byteLength,
        sha256: verified.sha256,
      },
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Initial upload path. Calls single multipart POST and authoritative verify.
   */
  async uploadPreparedOnce(params: {
    operationId: string;
    attachment: PrivateAttachment;
    binding: CompanyArchiveBinding;
    fileId: string;
  }): Promise<ArchiveReceipt> {
    const token = await this.resolveAccessToken(params.binding.archivePrincipal);

    // 1. Verify destination folder in Google Drive before attempting upload
    const folderUrl = `${this.apiBase}/files/${encodeURIComponent(
      params.binding.folderId,
    )}?fields=id,name,mimeType,trashed,driveId,capabilities&supportsAllDrives=true`;

    const folderRes = await fetch(folderUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!folderRes.ok) {
      const errText = truncateError(await folderRes.text());
      throw new Error(`Drive destination folder verification failed (${folderRes.status}): ${errText}`);
    }

    const folderMeta = (await folderRes.json()) as {
      id?: string;
      mimeType?: string;
      trashed?: boolean;
      driveId?: string;
      capabilities?: { canAddChildren?: boolean };
    };

    if (folderMeta.trashed) {
      throw new Error(
        `Drive destination folder ${params.binding.folderId} is in trash; archival refused`,
      );
    }

    if (!folderMeta.driveId || folderMeta.driveId !== params.binding.driveId) {
      throw new Error(
        `Drive Shared Drive mismatch: folder belongs to drive "${folderMeta.driveId ?? 'My Drive'}", binding requires "${params.binding.driveId}"`,
      );
    }

    if (folderMeta.capabilities && folderMeta.capabilities.canAddChildren === false) {
      throw new Error(
        `Drive destination folder ${params.binding.folderId} does not permit adding children for the archive principal`,
      );
    }

    // 2. Multipart upload body
    const boundary = `----DriveBoundary${crypto.randomBytes(16).toString('hex')}`;
    const fileMetadata = {
      id: params.fileId,
      name: params.attachment.metadata.filename,
      mimeType: 'application/pdf',
      parents: [params.binding.folderId],
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
      params.attachment.bytes,
      Buffer.from(footer, 'utf-8'),
    ]);

    const uploadHeaders: Record<string, string> = {
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(multipartBody.byteLength),
      Authorization: `Bearer ${token}`, // Fresh token included!
    };

    const uploadUrl = `${this.uploadBase}/files?uploadType=multipart&supportsAllDrives=true`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: uploadHeaders,
      body: multipartBody,
    });

    if (!uploadRes.ok) {
      if (uploadRes.status === 409) {
        // Read back on 409 conflict using the exact strict verifier
        return this.reconcileStoredArchive({
          operationId: params.operationId,
          sourceMetadata: params.attachment.metadata,
          binding: params.binding,
          fileId: params.fileId,
        });
      }
      const errText = truncateError(await uploadRes.text());
      throw new Error(`Drive upload failed (${uploadRes.status}): ${errText}`);
    }

    // 3. Authoritative post-upload readback verification
    return this.reconcileStoredArchive({
      operationId: params.operationId,
      sourceMetadata: params.attachment.metadata,
      binding: params.binding,
      fileId: params.fileId,
    });
  }
}
