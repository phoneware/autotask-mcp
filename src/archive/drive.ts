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

export class DriveArchiveProvider {
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly token: string | null;

  constructor(config?: DriveUploaderConfig) {
    this.apiBase = (config?.apiBaseUrl || process.env.DRIVE_API_BASE_URL || 'https://www.googleapis.com/drive/v3').replace(/\/+$/, '');
    this.uploadBase = (config?.uploadBaseUrl || process.env.DRIVE_UPLOAD_BASE_URL || 'https://www.googleapis.com/upload/drive/v3').replace(/\/+$/, '');
    this.token = config?.accessToken || process.env.DRIVE_ARCHIVE_ACCESS_TOKEN || null;
  }

  async uploadAndVerify(params: {
    operationId: string;
    attachment: PrivateAttachment;
    binding: CompanyArchiveBinding;
  }): Promise<ArchiveReceipt> {
    const isLocalMirror = this.apiBase.includes('127.0.0.1') || this.apiBase.includes('localhost');
    if (!this.token && !isLocalMirror) {
      throw new Error(
        'Google Drive archive credentials unavailable: dedicated archive service account token required for archival. ' +
          'In test environments, configure DRIVE_API_BASE_URL to point to an isolated Drive mirror.',
      );
    }

    const { metadata, bytes } = params.attachment;
    const fileId = crypto.randomUUID();

    // 1. Multipart upload body
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

    // 2. Outbound upload request
    const uploadUrl = `${this.uploadBase}/files?uploadType=multipart&supportsAllDrives=true`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: multipartBody,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Drive upload failed (${uploadRes.status}): ${errText}`);
    }

    const uploadedJson = (await uploadRes.json()) as { id?: string };
    const effectiveFileId = uploadedJson.id || fileId;

    // 3. Authoritative readback and integrity verification
    const getUrl = `${this.apiBase}/files/${encodeURIComponent(effectiveFileId)}?fields=id,name,mimeType,size,sha256Checksum,parents,driveId&supportsAllDrives=true`;
    const readHeaders: Record<string, string> = {};
    if (this.token) {
      readHeaders['Authorization'] = `Bearer ${this.token}`;
    }

    const readRes = await fetch(getUrl, {
      method: 'GET',
      headers: readHeaders,
    });

    if (!readRes.ok) {
      const errText = await readRes.text();
      throw new Error(`Drive readback verification failed (${readRes.status}): ${errText}`);
    }

    const readMeta = (await readRes.json()) as {
      id?: string;
      mimeType?: string;
      size?: string | number;
      sha256Checksum?: string;
      parents?: string[];
      driveId?: string;
    };

    // Verify parent folder placement
    if (!readMeta.parents || !readMeta.parents.includes(params.binding.folderId)) {
      throw new Error(
        `Drive verification failed: uploaded file parents do not include approved folderId ${params.binding.folderId}`,
      );
    }

    // Verify MIME
    if (readMeta.mimeType !== 'application/pdf') {
      throw new Error(`Drive verification failed: readback mimeType "${readMeta.mimeType}" is not application/pdf`);
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
      // If Drive omitted checksum, fetch binary media to verify
      const mediaUrl = `${this.apiBase}/files/${encodeURIComponent(effectiveFileId)}?alt=media&supportsAllDrives=true`;
      const mediaRes = await fetch(mediaUrl, { headers: readHeaders });
      if (!mediaRes.ok) {
        throw new Error(`Drive media fetch failed during checksum verification (${mediaRes.status})`);
      }
      const mediaBuf = Buffer.from(await mediaRes.arrayBuffer());
      observedSha256 = crypto.createHash('sha256').update(mediaBuf).digest('hex');
    }

    if (observedSha256.toLowerCase() !== metadata.sha256.toLowerCase()) {
      throw new Error(
        `Drive verification failed: readback SHA-256 ${observedSha256} does not match source SHA-256 ${metadata.sha256}`,
      );
    }

    // 4. Return strict verified receipt metadata only
    const receipt: ArchiveReceipt = {
      operationId: params.operationId,
      status: 'verified',
      source: metadata,
      destination: {
        provider: 'google-drive',
        driveId: params.binding.driveId,
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
