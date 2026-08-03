/**
 * HTTP (Streamable HTTP) transport for the Autotask MCP server.
 *
 * One MCP session per client. The SDK's StreamableHTTPServerTransport is a
 * *per-session* object: it latches its session id on the first `initialize` and
 * rejects both a second `initialize` and any request carrying a different
 * Mcp-Session-Id. Sharing one transport across clients therefore serves exactly
 * one client and 400s everyone else, so each `initialize` here mints its own
 * McpServer + transport pair and registers it in a session store.
 *
 * Auth is a single shared bearer token. Autotask has no OAuth, no SSO and no
 * per-user credentials (see README), so there is no user identity to bind a
 * session to yet; every action is attributed to the API user. When that
 * changes, the place to hook per-user identity is the bearer check in
 * `createRouter`, and whatever it resolves would ride onto the session and out
 * as Autotask's ImpersonationResourceId header.
 */

import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildServer } from './server.js';
import { isReadonly } from './security.js';
import { missingCredentials } from './autotask-api.js';
import { governor } from './governor.js';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const REAP_INTERVAL_MS = 60_000;
const MIN_TOKEN_LENGTH = 16;

// --- small helpers -----------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Constant-time bearer comparison. */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Path without query string. Bare paths keep working behind load balancers. */
export function parsePath(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function bearerFrom(headers: IncomingMessage['headers']): string {
  const auth = headers['authorization'];
  if (typeof auth !== 'string') return '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

/**
 * Origin policy. Our intended clients (Claude Code, server-side connectors) do
 * not send an Origin header at all; only browsers do. So an unset allowlist
 * denies every browser origin rather than allowing them, which is what closes
 * the DNS-rebinding hole without needing a separate switch.
 */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  return allowed.includes(origin);
}

/** Host allowlist for DNS-rebinding protection. Unset means "trust the proxy". */
export function isHostAllowed(host: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!host) return false;
  return allowed.includes(host) || allowed.includes(host.split(':')[0]);
}

/** Rate-limit bucket key: the real client when behind a proxy, else the socket. */
export function clientKey(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// --- rate limiting -----------------------------------------------------------

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number = RATE_WINDOW_MS,
  ) {}

  /** True when the request is allowed. Fixed window per key. */
  check(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  reap(now: number = Date.now()): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }
}

// --- session store -----------------------------------------------------------

export interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
    readonly ttlMs: number = DEFAULT_SESSION_TTL_MS,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  get full(): boolean {
    return this.sessions.size >= this.maxSessions;
  }

  /** Fetch and mark active. Returns undefined for unknown ids. */
  get(id: string, now: number = Date.now()): Session | undefined {
    const session = this.sessions.get(id);
    if (session) session.lastSeen = now;
    return session;
  }

  set(session: Session): void {
    this.sessions.set(session.id, session);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Close sessions idle past the TTL. Returns how many were reaped. */
  async reap(now: number = Date.now()): Promise<number> {
    const stale = [...this.sessions.values()].filter((s) => now - s.lastSeen > this.ttlMs);
    for (const session of stale) {
      this.sessions.delete(session.id);
      await closeQuietly(session);
    }
    return stale.length;
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map(closeQuietly));
  }
}

async function closeQuietly(session: Session): Promise<void> {
  try {
    await session.transport.close();
  } catch {
    // A session that fails to close cleanly must not block shutdown or reaping.
  }
}

// --- request/response plumbing ----------------------------------------------

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

/** JSON-RPC shaped error, so MCP clients surface something useful. */
function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Read and parse a JSON body, refusing anything over the size cap. */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

// --- the router --------------------------------------------------------------

export interface RouterDeps {
  token: string;
  sessions: SessionStore;
  limiter: RateLimiter | null;
  allowedOrigins: string[];
  allowedHosts: string[];
  maxBodyBytes: number;
  /** Injected so tests can build sessions without the real tool layer. */
  createSession: SessionFactory;
}

/**
 * The transport's session hooks are constructor-only in the SDK, so the
 * factory takes them as arguments rather than the router assigning them after
 * construction.
 */
export interface SessionHooks {
  onsessioninitialized: (id: string) => void;
  onsessionclosed: (id: string) => void;
}

export type SessionFactory = (hooks: SessionHooks) => {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

/** Default session factory: a fresh, fully configured MCP server per client. */
export const defaultCreateSession: SessionFactory = (hooks) => {
  const { server } = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: hooks.onsessioninitialized,
    onsessionclosed: hooks.onsessionclosed,
  });
  return { server, transport };
};

export function createRouter(deps: RouterDeps) {
  return async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = parsePath(req.url);
    const origin = req.headers['origin'] as string | undefined;

    if (!isHostAllowed(req.headers['host'] as string | undefined, deps.allowedHosts)) {
      sendJson(res, 403, { error: 'Host not allowed' });
      return;
    }
    if (!isOriginAllowed(origin, deps.allowedOrigins)) {
      sendJson(res, 403, { error: 'Origin not allowed' });
      return;
    }

    // CORS: only ever echoed for an explicitly allowlisted origin. Mcp-Session-Id
    // must be exposed or a browser client can never read its own session id.
    if (origin && deps.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept, Last-Event-ID',
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (path === '/health') {
      const snap = governor.lastSnapshot;
      const missing = missingCredentials();
      // Still 200 when credentials are absent: the process is alive and this is
      // the one endpoint that can explain what is wrong. Failing the probe here
      // would crash-loop the revision and hide the reason.
      sendJson(res, 200, {
        ok: true,
        configured: missing.length === 0,
        missingConfig: missing,
        mode: isReadonly() ? 'readonly' : 'full',
        uptimeSeconds: Math.floor(process.uptime()),
        sessions: deps.sessions.size,
        autotaskUsagePct: snap ? Number(snap.usedPct.toFixed(1)) : null,
      });
      return;
    }

    if (path !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // --- /mcp from here down --------------------------------------------------
    const presented = bearerFrom(req.headers);
    if (!presented || !tokensMatch(presented, deps.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="autotask-mcp"');
      sendRpcError(res, 401, -32001, 'Unauthorized');
      return;
    }

    if (deps.limiter && !deps.limiter.check(clientKey(req))) {
      res.setHeader('Retry-After', '60');
      sendRpcError(res, 429, -32003, 'Rate limit exceeded');
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const sid = typeof sessionId === 'string' ? sessionId : undefined;

    try {
      if (req.method === 'POST') {
        await handlePost(req, res, deps, sid);
        return;
      }

      // GET opens the SSE stream, DELETE terminates the session. Both require
      // an established session.
      if (req.method === 'GET' || req.method === 'DELETE') {
        const session = sid ? deps.sessions.get(sid) : undefined;
        if (!session) {
          sendRpcError(res, 404, -32001, 'Session not found');
          return;
        }
        await session.transport.handleRequest(req, res);
        if (req.method === 'DELETE') deps.sessions.delete(session.id);
        return;
      }

      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      sendRpcError(res, 405, -32000, 'Method not allowed');
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendRpcError(res, statusCode, -32603, message);
      } else {
        res.end();
      }
    }
  };
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouterDeps,
  sid: string | undefined,
): Promise<void> {
  const body = await readJsonBody(req, deps.maxBodyBytes);

  if (isInitializeRequest(body)) {
    if (deps.sessions.full) {
      sendRpcError(res, 503, -32004, 'Server at session capacity, try again later');
      return;
    }

    // Registration happens in onsessioninitialized so the id is the one the
    // transport actually assigned, not one we guessed. `holder` closes the loop
    // between the hooks and the objects the factory is still constructing.
    const holder: { server?: McpServer; transport?: StreamableHTTPServerTransport } = {};
    const { server, transport } = deps.createSession({
      onsessioninitialized: (id) => {
        deps.sessions.set({
          id,
          transport: holder.transport!,
          server: holder.server!,
          lastSeen: Date.now(),
        });
      },
      onsessionclosed: (id) => {
        deps.sessions.delete(id);
      },
    });
    holder.server = server;
    holder.transport = transport;

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  const session = sid ? deps.sessions.get(sid) : undefined;
  if (!session) {
    sendRpcError(
      res,
      404,
      -32001,
      sid ? 'Session not found or expired' : 'Missing Mcp-Session-Id header',
    );
    return;
  }
  await session.transport.handleRequest(req, res, body);
}

// --- bootstrap ---------------------------------------------------------------

export interface RunningServer {
  httpServer: HttpServer;
  sessions: SessionStore;
  close: () => Promise<void>;
}

export async function runHttp(): Promise<RunningServer> {
  const token = process.env.AUTOTASK_HTTP_TOKEN;
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    console.error(
      `[autotask-mcp] AUTOTASK_TRANSPORT=http requires AUTOTASK_HTTP_TOKEN (>= ${MIN_TOKEN_LENGTH} chars). ` +
        'Aborting: refusing to expose /mcp without auth.',
    );
    process.exit(1);
  }

  const host = process.env.AUTOTASK_HTTP_HOST ?? DEFAULT_HOST;
  const port = envInt('PORT', DEFAULT_PORT);
  const rateLimit = envInt('AUTOTASK_RATE_LIMIT', DEFAULT_RATE_LIMIT);
  const limiter = rateLimit > 0 ? new RateLimiter(rateLimit) : null;
  const sessions = new SessionStore(
    envInt('AUTOTASK_MAX_SESSIONS', DEFAULT_MAX_SESSIONS),
    envInt('AUTOTASK_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS),
  );

  const router = createRouter({
    token,
    sessions,
    limiter,
    allowedOrigins: envList('AUTOTASK_HTTP_ALLOWED_ORIGINS'),
    allowedHosts: envList('AUTOTASK_HTTP_ALLOWED_HOSTS'),
    maxBodyBytes: envInt('AUTOTASK_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    createSession: defaultCreateSession,
  });

  const http = await import('node:http');
  const httpServer = http.createServer((req, res) => {
    void router(req, res);
  });

  const reaper = setInterval(() => {
    void sessions.reap();
    limiter?.reap();
  }, REAP_INTERVAL_MS);
  reaper.unref();

  // Report what the tool surface looks like once, at boot.
  const { registeredCount, skipped } = buildServer();

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  console.error(
    `[autotask-mcp] HTTP transport on ${host}:${port} (mode: ${isReadonly() ? 'READONLY' : 'full'}, ` +
      `${registeredCount} tools, ${skipped} write tools skipped)`,
  );

  const close = async (): Promise<void> => {
    clearInterval(reaper);
    await sessions.closeAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  // Cloud Run sends SIGTERM before pulling an instance; drain rather than drop
  // live sessions mid-call.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      console.error(`[autotask-mcp] ${signal} received, draining sessions`);
      void close().then(() => process.exit(0));
    });
  }

  return { httpServer, sessions, close };
}
