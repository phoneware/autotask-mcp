import http from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';

export interface StoredDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  parents: string[];
  sha256Checksum: string;
  bytes: Buffer;
  driveId: string;
  trashed: boolean;
}

export interface StoredDriveFolder {
  id: string;
  name: string;
  mimeType: string;
  driveId: string;
  trashed: boolean;
  capabilities: { canAddChildren: boolean };
}

/**
 * Isolated Google Drive API v3 mock server for testing PDF archival and readback.
 * Enforces Shared Drive membership, affirmative trash observations, capabilities,
 * and maintains separate arrival and applied journals.
 */
export class DriveMirror {
  public server: http.Server | null = null;
  public port = 0;
  public baseUrl = '';
  public uploadBaseUrl = '';

  public files = new Map<string, StoredDriveFile>();
  public folders = new Map<string, StoredDriveFolder>();

  public arrivalJournal: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    bodyLength: number;
    receivedAt: number;
  }> = [];

  public appliedJournal: Array<{
    operation: 'generateIds' | 'upload' | 'get';
    fileId: string;
    appliedAt: number;
  }> = [];

  // Fault injection hooks
  public simulate409OnNextUpload = false;
  public simulateNetworkDropOnUpload = false;
  public simulateHeldBeforeApplyMs = 0;

  constructor() {
    this.seedDefaultFolder('folder-hazelbrook-approved', 'shared-drive-hazelbrook');
  }

  seedDefaultFolder(folderId: string, driveId: string): void {
    this.folders.set(folderId, {
      id: folderId,
      name: 'Customer Archive Folder',
      mimeType: 'application/vnd.google-apps.folder',
      driveId,
      trashed: false,
      capabilities: { canAddChildren: true },
    });
  }

  async start(): Promise<{ baseUrl: string; uploadBaseUrl: string; port: number }> {
    const { promise, resolve, reject } = Promise.withResolvers<{
      baseUrl: string;
      uploadBaseUrl: string;
      port: number;
    }>();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.on('error', reject);

    this.server.listen(0, '127.0.0.1', () => {
      const addr = this.server?.address() as AddressInfo;
      this.port = addr.port;
      this.baseUrl = `http://127.0.0.1:${this.port}/drive/v3`;
      this.uploadBaseUrl = `http://127.0.0.1:${this.port}/upload/drive/v3`;
      resolve({ baseUrl: this.baseUrl, uploadBaseUrl: this.uploadBaseUrl, port: this.port });
    });

    return promise;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => {
      this.server = null;
      resolve();
    });
    return promise;
  }

  reset(): void {
    this.files.clear();
    this.folders.clear();
    this.arrivalJournal = [];
    this.appliedJournal = [];
    this.simulate409OnNextUpload = false;
    this.simulateNetworkDropOnUpload = false;
    this.simulateHeldBeforeApplyMs = 0;
    this.seedDefaultFolder('folder-hazelbrook-approved', 'shared-drive-hazelbrook');
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      this.arrivalJournal.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
        bodyLength: rawBody.byteLength,
        receivedAt: Date.now(),
      });

      if (this.simulateHeldBeforeApplyMs > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, this.simulateHeldBeforeApplyMs);
        await promise;
      }

      this.route(req, res, rawBody);
    });
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const url = req.url || '/';
    const method = req.method?.toUpperCase() || 'GET';

    const sendJson = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) {
      sendJson(401, { error: { message: 'Missing or invalid Authorization header' } });
      return;
    }
    // 0. ID generation
    if (url.includes('/drive/v3/files/generateIds') && method === 'GET') {
      const allocatedId = `drive-id-${crypto.randomUUID()}`;
      this.appliedJournal.push({
        operation: 'generateIds',
        fileId: allocatedId,
        appliedAt: Date.now(),
      });
      sendJson(200, { ids: [allocatedId] });
      return;
    }

    // 1. Multipart upload
    if (url.includes('/upload/drive/v3/files') && method === 'POST') {
      if (this.simulate409OnNextUpload) {
        this.simulate409OnNextUpload = false;
        sendJson(409, { error: { message: 'Conflict: file ID already exists' } });
        return;
      }
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=([^;]+)/);
      if (!boundaryMatch) {
        sendJson(400, { error: { message: 'Missing multipart boundary' } });
        return;
      }
      const boundary = boundaryMatch[1];
      const parts = this.parseMultipart(body, boundary);

      if (parts.length < 2) {
        sendJson(400, { error: { message: 'Expected metadata and media parts' } });
        return;
      }

      let meta: { id?: string; name?: string; mimeType?: string; parents?: string[] } = {};
      try {
        meta = JSON.parse(parts[0].data.toString('utf-8'));
      } catch {
        // ignore
      }

      const fileBytes = parts[1].data;
      const fileId = meta.id || `drive-file-${crypto.randomUUID()}`;
      if (this.files.has(fileId)) {
        sendJson(409, { error: { message: `Conflict: file ID "${fileId}" already exists` } });
        return;
      }

      const sha256Checksum = crypto.createHash('sha256').update(fileBytes).digest('hex');
      const parentFolderId = meta.parents?.[0];
      if (!parentFolderId || !this.folders.has(parentFolderId)) {
        sendJson(404, { error: { message: `Parent folder "${parentFolderId}" not found` } });
        return;
      }
      const folder = this.folders.get(parentFolderId);

      const stored: StoredDriveFile = {
        id: fileId,
        name: meta.name || 'document.pdf',
        mimeType: meta.mimeType || 'application/pdf',
        size: fileBytes.byteLength,
        parents: [parentFolderId],
        sha256Checksum,
        bytes: fileBytes,
        driveId: folder?.driveId || 'shared-drive-hazelbrook',
        trashed: false,
      };

      this.files.set(fileId, stored);
      this.appliedJournal.push({
        operation: 'upload',
        fileId,
        appliedAt: Date.now(),
      });

      if (this.simulateNetworkDropOnUpload) {
        req.socket.destroy();
        return;
      }

      sendJson(200, {
        id: fileId,
        name: stored.name,
        mimeType: stored.mimeType,
        size: String(stored.size),
        parents: stored.parents,
        sha256Checksum: stored.sha256Checksum,
        driveId: stored.driveId,
        trashed: false,
      });
      return;
    }
    // 2. File and Folder readback
    const fileGetMatch = url.match(/\/drive\/v3\/files\/([^?]+)/);
    if (fileGetMatch && method === 'GET') {
      const targetId = decodeURIComponent(fileGetMatch[1]);

      // Check folder store
      if (this.folders.has(targetId)) {
        sendJson(200, this.folders.get(targetId));
        return;
      }

      const file = this.files.get(targetId);
      if (!file) {
        sendJson(404, { error: { message: `File ${targetId} not found` } });
        return;
      }

      if (url.includes('alt=media')) {
        res.writeHead(200, {
          'Content-Type': file.mimeType,
          'Content-Length': String(file.bytes.byteLength),
        });
        res.end(file.bytes);
        return;
      }

      this.appliedJournal.push({
        operation: 'get',
        fileId: targetId,
        appliedAt: Date.now(),
      });

      sendJson(200, {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: String(file.size),
        parents: file.parents,
        sha256Checksum: file.sha256Checksum,
        driveId: file.driveId,
        trashed: file.trashed,
      });
      return;
    }

    sendJson(404, { error: { message: `Route not found: ${method} ${url}` } });
  }

  private parseMultipart(
    body: Buffer,
    boundary: string,
  ): Array<{ headers: Record<string, string>; data: Buffer }> {
    const delimiter = Buffer.from(`--${boundary}`);
    const parts: Array<{ headers: Record<string, string>; data: Buffer }> = [];
    let start = body.indexOf(delimiter);

    while (start !== -1) {
      start += delimiter.length;
      if (body.subarray(start, start + 2).toString() === '--') {
        break;
      }
      if (body.subarray(start, start + 2).toString() === '\r\n') {
        start += 2;
      }

      const next = body.indexOf(delimiter, start);
      if (next === -1) break;

      const partBuf = body.subarray(start, next - 2);
      const headerEnd = partBuf.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd !== -1) {
        const headerStr = partBuf.subarray(0, headerEnd).toString('utf-8');
        const data = partBuf.subarray(headerEnd + 4);
        const headers: Record<string, string> = {};
        for (const line of headerStr.split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon !== -1) {
            headers[line.substring(0, colon).trim().toLowerCase()] = line
              .substring(colon + 1)
              .trim();
          }
        }
        parts.push({ headers, data });
      }

      start = next;
    }

    return parts;
  }
}
