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
  driveId?: string;
}

/**
 * Isolated Google Drive API v3 mock server for testing PDF archival and readback.
 */
export class DriveMirror {
  public server: http.Server | null = null;
  public port = 0;
  public baseUrl = '';
  public uploadBaseUrl = '';

  public files = new Map<string, StoredDriveFile>();
  public requestLog: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];

  async start(): Promise<{ baseUrl: string; uploadBaseUrl: string; port: number }> {
    return new Promise((resolve, reject) => {
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
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server?.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  reset(): void {
    this.files.clear();
    this.requestLog = [];
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      this.requestLog.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
      });

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

    // 1. Multipart upload
    if (url.includes('/upload/drive/v3/files') && method === 'POST') {
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
      const fileId = meta.id || crypto.randomUUID();
      const sha256Checksum = crypto.createHash('sha256').update(fileBytes).digest('hex');

      const stored: StoredDriveFile = {
        id: fileId,
        name: meta.name || 'document.pdf',
        mimeType: meta.mimeType || 'application/pdf',
        size: fileBytes.byteLength,
        parents: meta.parents || [],
        sha256Checksum,
        bytes: fileBytes,
        driveId: 'shared-drive-001',
      };

      this.files.set(fileId, stored);
      sendJson(200, {
        id: fileId,
        name: stored.name,
        mimeType: stored.mimeType,
        size: String(stored.size),
        parents: stored.parents,
        sha256Checksum: stored.sha256Checksum,
      });
      return;
    }

    // 2. File readback
    const fileGetMatch = url.match(/\/drive\/v3\/files\/([^?]+)/);
    if (fileGetMatch && method === 'GET') {
      const fileId = decodeURIComponent(fileGetMatch[1]);
      const file = this.files.get(fileId);
      if (!file) {
        sendJson(404, { error: { message: `File ${fileId} not found` } });
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

      sendJson(200, {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: String(file.size),
        parents: file.parents,
        sha256Checksum: file.sha256Checksum,
        driveId: file.driveId,
      });
      return;
    }

    sendJson(404, { error: { message: `Route not found: ${method} ${url}` } });
  }

  private parseMultipart(body: Buffer, boundary: string): Array<{ headers: Record<string, string>; data: Buffer }> {
    const delimiter = Buffer.from(`--${boundary}`);
    const parts: Array<{ headers: Record<string, string>; data: Buffer }> = [];
    let start = body.indexOf(delimiter);

    while (start !== -1) {
      start += delimiter.length;
      if (body.subarray(start, start + 2).toString() === '--') {
        break; // end boundary
      }
      if (body.subarray(start, start + 2).toString() === '\r\n') {
        start += 2;
      }

      const next = body.indexOf(delimiter, start);
      if (next === -1) break;

      const partBuf = body.subarray(start, next - 2); // strip trailing \r\n
      const headerEnd = partBuf.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd !== -1) {
        const headerStr = partBuf.subarray(0, headerEnd).toString('utf-8');
        const data = partBuf.subarray(headerEnd + 4);
        const headers: Record<string, string> = {};
        for (const line of headerStr.split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon !== -1) {
            headers[line.substring(0, colon).trim().toLowerCase()] = line.substring(colon + 1).trim();
          }
        }
        parts.push({ headers, data });
      }

      start = next;
    }

    return parts;
  }
}
