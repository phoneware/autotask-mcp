import http from 'node:http';
import { AddressInfo } from 'node:net';

export class GoogleCredentialsMirror {
  public server: http.Server | null = null;
  public port = 0;
  public baseUrl = '';

  public arrivalJournal: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: unknown;
    receivedAt: number;
  }> = [];

  public appliedJournal: Array<{
    principal: string;
    token: string;
    appliedAt: number;
  }> = [];

  async start(): Promise<{ baseUrl: string; port: number }> {
    const { promise, resolve, reject } = Promise.withResolvers<{
      baseUrl: string;
      port: number;
    }>();

    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf-8');
        let bodyJson: unknown = null;
        try {
          bodyJson = bodyStr ? JSON.parse(bodyStr) : null;
        } catch {
          // Ignore
        }

        this.arrivalJournal.push({
          method: req.method || 'GET',
          url: req.url || '/',
          headers: req.headers,
          body: bodyJson,
          receivedAt: Date.now(),
        });

        const url = req.url || '/';
        if (url.includes(':generateAccessToken') && req.method === 'POST') {
          const auth = req.headers['authorization'] || '';
          if (!auth.startsWith('Bearer ')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing ADC bearer token' }));
            return;
          }

          const match = url.match(/serviceAccounts\/([^:]+):generateAccessToken/);
          const principal = match ? decodeURIComponent(match[1]) : 'default-sa';
          const token = `synthetic-drive-token-${principal}-${Date.now()}`;
          const expireTime = new Date(Date.now() + 3600 * 1000).toISOString();

          this.appliedJournal.push({
            principal,
            token,
            appliedAt: Date.now(),
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accessToken: token, expireTime }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });
    });

    this.server.on('error', reject);

    this.server.listen(0, '127.0.0.1', () => {
      const addr = this.server?.address() as AddressInfo;
      this.port = addr.port;
      this.baseUrl = `http://127.0.0.1:${this.port}/v1`;
      resolve({ baseUrl: this.baseUrl, port: this.port });
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
    this.arrivalJournal = [];
    this.appliedJournal = [];
  }
}
