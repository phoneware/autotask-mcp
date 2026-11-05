import crypto from 'node:crypto';
import type {
  ArchiveReceipt,
  CompanyArchiveBinding,
  PrivateAttachment,
} from '../provisioning/contracts.js';

export interface DriveUploaderConfig {
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  accessToken?: string;
}

function truncateError(raw: string): string {
  const clean = raw.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]').trim();
  return clean.length > 140 ? clean.slice(0, 140) + '...[truncated]' : clean;
}

export class DriveArchiveProvider {
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly token: string | null;

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
    this.token = config?.accessToken || process.env.DRIVE_ARCHIVE_ACCESS_TOKEN || null;
  }

  async generateFileId(): Promise<string> {
    const url = `${this.apiBase}/files/generateIds?count=1&supportsAllDrives=true`;
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (res.ok) {
        const json = (await res.json()) as { ids?: string[] };
        if (Array.isArray(json.ids) && json.ids[0]) {
          return json.ids[0];
        }
      }
    } catch {
      // Fallback for isolated test mirrors
    }
    return crypto.randomUUID();
  }

  async uploadAndVerify(params: {
    operationId: string;
    attachment: PrivateAttachment;
    binding: CompanyArchiveBinding;
    fileId?: string;
  }): Promise<ArchiveReceipt> {
    const isLocalMirror = this.apiBase.includes('127.0.0.1') || this.apiBase.includes('localhost');
    if (!this.token && !isLocalMirror) {
      throw new Error(
        'Google Drive archive credentials unavailable: dedicated archive service account token required for archival. ' +
          'In test environments, configure DRIVE_API_BASE_URL to point to an isolated Drive mirror.',
      );
    }

    const { metadata, bytes } = params.attachment;
    const readHeaders: Record<string, string> = {};
    if (this.token) readHeaders['Authorization'] = `Bearer ${this.token}`;

    // 1. Verify destination folder in Google Drive before attempting upload
    const folderUrl = `${this.apiBase}/files/${encodeURIComponent(
      params.binding.folderId,
    )}?fields=id,name,mimeType,trashed,driveId,capabilities&supportsAllDrives=true`;

    const folderRes = await fetch(folderUrl, { method: 'GET', headers: readHeaders });
    if (!folderRes.ok) {
      const errText = truncateError(await folderRes.text());
      throw new Error(
        `Drive destination folder verification failed (${folderRes.status}): ${errText}`,
      );
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

    if (
      folderMeta.driveId &&
      params.binding.driveId &&
      folderMeta.driveId !== params.binding.driveId
    ) {
      throw new Error(
        `Drive Shared Drive mismatch: folder belongs to drive ${folderMeta.driveId}, binding requires ${params.binding.driveId}`,
      );
    }

    if (folderMeta.capabilities && folderMeta.capabilities.canAddChildren === false) {
      throw new Error(
        `Drive destination folder ${params.binding.folderId} does not permit adding children for the archive principal`,
      );
    }

    // 2. Pre-allocated or caller-persisted Drive file ID
    const fileId = params.fileId || (await this.generateFileId());

    // 3. Check if file was already uploaded under this fileId (read-only reconciliation)
    const checkUrl = `${this.apiBase}/files/${encodeURIComponent(
      fileId,
    )}?fields=id,name,mimeType,size,sha256Checksum,parents,driveId,trashed&supportsAllDrives=true`;

    const checkRes = await fetch(checkUrl, { method: 'GET', headers: readHeaders });
    if (checkRes.ok) {
      const existingMeta = (await checkRes.json()) as {
        id?: string;
        size?: string | number;
        sha256Checksum?: string;
        parents?: string[];
        driveId?: string;
        trashed?: boolean;
      };

      if (!existingMeta.trashed) {
        const existingSize =
          typeof existingMeta.size === 'string' ? Number(existingMeta.size) : existingMeta.size;
        const checksumMatch =
          existingMeta.sha256Checksum?.toLowerCase() === metadata.sha256.toLowerCase();
        const parentMatch =
          Array.isArray(existingMeta.parents) &&
          existingMeta.parents.length === 1 &&
          existingMeta.parents[0] === params.binding.folderId;
        const driveMatch =
          !params.binding.driveId || existingMeta.driveId === params.binding.driveId;

        if (existingSize === bytes.byteLength && checksumMatch && parentMatch && driveMatch) {
          // Reconcile already-uploaded file directly without duplicate upload!
          return {
            operationId: params.operationId,
            status: 'verified',
            source: metadata,
            destination: {
              provider: 'google-drive',
              driveId: existingMeta.driveId || params.binding.driveId,
              folderId: params.binding.folderId,
              fileId,
              byteLength: bytes.byteLength,
              sha256: metadata.sha256.toLowerCase(),
            },
            observedAt: new Date().toISOString(),
          };
        }
      }
    }

    // 4. Multipart upload body
    const boundary = `----DriveBoundary${crypto.randomBytes(16).toString('hex')}`;
    const fileMetadata = {
      id: fileId,
      name: metadata.filename,
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
      bytes,
      Buffer.from(footer, 'utf-8'),
    ]);

    const headers: Record<string, string> = {
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(multipartBody.byteLength),
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const uploadUrl = `${this.uploadBase}/files?uploadType=multipart&supportsAllDrives=true`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: multipartBody,
    });

    if (!uploadRes.ok) {
      if (uploadRes.status === 409) {
        // Read back on conflict
        const getAfter409 = await fetch(checkUrl, { method: 'GET', headers: readHeaders });
        if (getAfter409.ok) {
          const m = (await getAfter409.json()) as {
            size?: number;
            sha256Checksum?: string;
            parents?: string[];
            driveId?: string;
          };
          if (
            m.sha256Checksum?.toLowerCase() === metadata.sha256.toLowerCase() &&
            m.parents?.[0] === params.binding.folderId
          ) {
            return {
              operationId: params.operationId,
              status: 'verified',
              source: metadata,
              destination: {
                provider: 'google-drive',
                driveId: m.driveId || params.binding.driveId,
                folderId: params.binding.folderId,
                fileId,
                byteLength: bytes.byteLength,
                sha256: metadata.sha256.toLowerCase(),
              },
              observedAt: new Date().toISOString(),
            };
          }
        }
      }
      const errText = truncateError(await uploadRes.text());
      throw new Error(`Drive upload failed (${uploadRes.status}): ${errText}`);
    }

    const uploadedJson = (await uploadRes.json()) as { id?: string };
    const effectiveFileId = uploadedJson.id || fileId;

    // 5. Authoritative readback and integrity verification
    const readUrl = `${this.apiBase}/files/${encodeURIComponent(
      effectiveFileId,
    )}?fields=id,name,mimeType,size,sha256Checksum,parents,driveId,trashed&supportsAllDrives=true`;

    const readRes = await fetch(readUrl, {
      method: 'GET',
      headers: readHeaders,
    });

    if (!readRes.ok) {
      const errText = truncateError(await readRes.text());
      throw new Error(`Drive readback verification failed (${readRes.status}): ${errText}`);
    }

    const readMeta = (await readRes.json()) as {
      id?: string;
      mimeType?: string;
      size?: string | number;
      sha256Checksum?: string;
      parents?: string[];
      driveId?: string;
      trashed?: boolean;
    };

    if (readMeta.trashed) {
      throw new Error(`Drive verification failed: uploaded file ${effectiveFileId} is in trash`);
    }

    // Exact parent folder placement
    if (
      !Array.isArray(readMeta.parents) ||
      readMeta.parents.length !== 1 ||
      readMeta.parents[0] !== params.binding.folderId
    ) {
      throw new Error(
        `Drive verification failed: uploaded file parents do not match approved folderId ${params.binding.folderId}`,
      );
    }

    // Exact Shared Drive verification
    if (params.binding.driveId && readMeta.driveId && readMeta.driveId !== params.binding.driveId) {
      throw new Error(
        `Drive verification failed: uploaded file driveId "${readMeta.driveId}" does not match binding "${params.binding.driveId}"`,
      );
    }

    // Verify MIME
    if (readMeta.mimeType !== 'application/pdf') {
      throw new Error(
        `Drive verification failed: readback mimeType "${readMeta.mimeType}" is not application/pdf`,
      );
    }

    // Verify size
    const readSize = typeof readMeta.size === 'string' ? Number(readMeta.size) : readMeta.size;
    if (readSize !== bytes.byteLength) {
      throw new Error(
        `Drive verification failed: readback size ${readSize} does not match uploaded size ${bytes.byteLength}`,
      );
    }

    // Verify SHA-256
    let observedSha256 = readMeta.sha256Checksum;
    if (!observedSha256) {
      const mediaUrl = `${this.apiBase}/files/${encodeURIComponent(
        effectiveFileId,
      )}?alt=media&supportsAllDrives=true`;
      const mediaRes = await fetch(mediaUrl, { headers: readHeaders });
      if (!mediaRes.ok) {
        throw new Error(
          `Drive media fetch failed during checksum verification (${mediaRes.status})`,
        );
      }
      const mediaBuf = Buffer.from(await mediaRes.arrayBuffer());
      if (mediaBuf.byteLength > 5_000_000) {
        throw new Error(`Drive media exceeds 5 MB size ceiling during verification`);
      }
      observedSha256 = crypto.createHash('sha256').update(mediaBuf).digest('hex');
    }

    if (observedSha256.toLowerCase() !== metadata.sha256.toLowerCase()) {
      throw new Error(
        `Drive verification failed: readback SHA-256 ${observedSha256} does not match source SHA-256 ${metadata.sha256}`,
      );
    }

    const receipt: ArchiveReceipt = {
      operationId: params.operationId,
      status: 'verified',
      source: metadata,
      destination: {
        provider: 'google-drive',
        driveId: readMeta.driveId || params.binding.driveId,
        folderId: params.binding.folderId,
        fileId: effectiveFileId,
        byteLength: bytes.byteLength,
        sha256: observedSha256.toLowerCase(),
      },
      observedAt: new Date().toISOString(),
    };

    return receipt;
  }
}
