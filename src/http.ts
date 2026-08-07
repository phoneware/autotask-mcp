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
 * Google sign-in is the only way in. Autotask has no OAuth of its own, so
 * Google is not standing in for Autotask auth: its only job is to produce a
 * verified email, which is matched to an Autotask Resource so writes carry
 * ImpersonationResourceId and are attributed to a real person.
 *
 * There is deliberately no shared static bearer alongside it. A second token
 * with no identity, no expiry and no domain allowlist would be a weaker
 * parallel door into the same building, and every write through it would land
 * as the API user, which is the audit hole Google sign-in exists to close.
 * Headless callers, if they ever appear, should present a verifiable identity
 * (a Google service-account ID token) rather than a shared secret.
 */

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { buildServer } from './server.js';
import { isReadonly } from './security.js';
import { missingCredentials } from './autotask-api.js';
import { governor } from './governor.js';
import { GoogleAuthProvider } from './auth/google-provider.js';
import { MemoryClientsStore, TokenStore, type TokenStoreLike } from './auth/stores.js';
import { FirestoreClientsStore, FirestoreTokenStore } from './auth/firestore-stores.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { withCaller, type CallerIdentity } from './auth/context.js';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const REAP_INTERVAL_MS = 60_000;

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

export function bearerFrom(headers: Request['headers']): string {
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
export function clientKey(req: Request): string {
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

// --- session factory ---------------------------------------------------------

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

// --- app wiring --------------------------------------------------------------

export interface AppOptions {
  /** Google bridge, or null when Google sign-in is not configured. */
  googleProvider: GoogleAuthProvider | null;
  /** Public base URL. Required for OAuth (it is the issuer). */
  baseUrl?: URL;
  sessions: SessionStore;
  limiter: RateLimiter | null;
  allowedOrigins: string[];
  allowedHosts: string[];
  maxBodyBytes: number;
  createSession: SessionFactory;
  /** Where OAuth clients and tokens live. Surfaced on /health. */
  persistence?: Persistence;
}

/** Everything still missing before the server can actually serve. */
export function missingConfig(opts: Pick<AppOptions, 'googleProvider'>): string[] {
  const missing = [...missingCredentials()];
  if (!opts.googleProvider) missing.push('Google sign-in (AUTOTASK_OAUTH_*)');
  return missing;
}

export function createApp(opts: AppOptions): Express {
  const app = express();
  // Cloud Run terminates TLS and forwards the client IP; without this the rate
  // limiter would bucket every request under the proxy's address.
  app.set('trust proxy', 1);

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isHostAllowed(req.headers['host'], opts.allowedHosts)) {
      res.status(403).json({ error: 'Host not allowed' });
      return;
    }
    const origin = req.headers['origin'];
    if (!isOriginAllowed(origin, opts.allowedOrigins)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    // CORS headers only ever go to an explicitly allowlisted origin.
    // Mcp-Session-Id must be exposed or a browser client can never read its
    // own session id.
    if (origin && opts.allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept, Last-Event-ID',
      );
      res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get('/health', (_req: Request, res: Response) => {
    const snap = governor.lastSnapshot;
    const missing = missingConfig(opts);
    // Still 200 when unconfigured: the process is alive and this is the one
    // endpoint that can explain what is wrong. Failing the probe would
    // crash-loop the revision and hide the reason.
    res.json({
      ok: true,
      configured: missing.length === 0,
      missingConfig: missing,
      auth: { google: Boolean(opts.googleProvider) },
      // 'memory' here means every registered client dies with this process, so
      // it needs to be visible from outside rather than inferred from a deploy.
      persistence: opts.persistence ?? 'memory',
      mode: isReadonly() ? 'readonly' : 'full',
      uptimeSeconds: Math.floor(process.uptime()),
      sessions: opts.sessions.size,
      autotaskUsagePct: snap ? Number(snap.usedPct.toFixed(1)) : null,
    });
  });

  app.use(express.json({ limit: opts.maxBodyBytes }));
  app.use(express.urlencoded({ extended: false }));

  // OAuth 2.1 authorization-server endpoints: discovery, /authorize, /token,
  // /register (DCR, which claude.ai relies on) and /revoke.
  if (opts.googleProvider && opts.baseUrl) {
    const mcpUrl = new URL('/mcp', opts.baseUrl);

    // An unknown client_id is a dead end the person in the browser can actually
    // fix, by removing and re-adding the connector so it registers again. The
    // SDK answers it with a bare {"error":"invalid_client"} JSON body, which
    // tells them nothing, so intercept it first and say what to do.
    app.all('/authorize', (req: Request, res: Response, next: NextFunction) => {
      void explainUnknownClient(req, res, next, opts.googleProvider!);
    });

    app.use(
      mcpAuthRouter({
        provider: opts.googleProvider,
        issuerUrl: opts.baseUrl,
        resourceServerUrl: mcpUrl,
        resourceName: 'Autotask MCP',
        scopesSupported: ['openid', 'email'],
      }),
    );
    // RFC 9728 discovery is path-suffixed (/.well-known/oauth-protected-resource/mcp)
    // and the WWW-Authenticate challenge points there. Some clients still probe
    // the bare path first, so answer that too.
    app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
      res.json({
        resource: mcpUrl.href,
        authorization_servers: [opts.baseUrl!.href],
        scopes_supported: ['openid', 'email'],
        resource_name: 'Autotask MCP',
      });
    });

    app.get('/callback', opts.googleProvider.handleCallback);
  }

  const authenticate = makeAuthMiddleware(opts);

  app.post('/mcp', rateLimit(opts), authenticate, (req: Request, res: Response) => {
    void handlePost(req, res, opts);
  });

  // GET opens the SSE stream, DELETE terminates the session. Both need an
  // established session.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', rateLimit(opts), authenticate, (req: Request, res: Response) => {
      void handleSessionScoped(req, res, opts, method === 'delete');
    });
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * Answer /authorize for a client_id we have never heard of with something a
 * person can act on, then get out of the way for every other request.
 *
 * A client reaches this state by holding a registration that no longer exists:
 * one issued before client persistence landed, or one deleted since. The OAuth
 * remedy is for the client to register again, which claude.ai only does when
 * the connector is removed and re-added, so that is what this page asks for.
 */
async function explainUnknownClient(
  req: Request,
  res: Response,
  next: NextFunction,
  provider: GoogleAuthProvider,
): Promise<void> {
  const fromQuery = req.query.client_id;
  const fromBody = (req.body as { client_id?: unknown } | undefined)?.client_id;
  const clientId =
    typeof fromQuery === 'string' ? fromQuery : typeof fromBody === 'string' ? fromBody : undefined;

  // No client_id at all is the SDK's error to report, not ours.
  if (!clientId) {
    next();
    return;
  }

  try {
    if (await provider.clientsStore.getClient(clientId)) {
      next();
      return;
    }
  } catch (err) {
    // A store that is down is a server problem, not an unknown client. Let the
    // SDK run so the failure is reported as one.
    console.error(`[autotask-mcp] client lookup failed: ${(err as Error).message}`);
    next();
    return;
  }

  console.error(`[autotask-mcp] /authorize for unregistered client_id ${clientId}`);
  res.status(400).type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reconnect Autotask MCP</title>
<style>
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 34rem; margin: 12vh auto; padding: 0 1.5rem; color: #1c1c1c; }
  h1 { font-size: 1.35rem; margin-bottom: .5rem; }
  code { background: #f0f0f0; padding: .1rem .35rem; border-radius: 3px; font-size: .85em; }
  ol { padding-left: 1.2rem; }
  li { margin-bottom: .4rem; }
  .muted { color: #666; font-size: .85rem; margin-top: 2rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #161616; color: #e8e8e8; }
    code { background: #2a2a2a; }
    .muted { color: #999; }
  }
</style>
</head>
<body>
<h1>This connector needs to be added again</h1>
<p>Autotask MCP does not recognise the app that sent you here, so there is
nothing to sign in to yet. Its registration no longer exists on the server.</p>
<ol>
  <li>Open your connector settings.</li>
  <li>Remove the Autotask connector.</li>
  <li>Add it back, pointing at <code>${escapeHtml(new URL('/mcp', `${req.protocol}://${req.get('host') ?? ''}`).href)}</code>.</li>
  <li>Sign in with your Phoneware Google account when prompted.</li>
</ol>
<p>Adding it back registers a fresh client, and sign-in will work from there.</p>
<p class="muted">Unrecognised client_id: <code>${escapeHtml(clientId)}</code></p>
</body>
</html>`);
}

function rateLimit(opts: AppOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (opts.limiter && !opts.limiter.check(clientKey(req))) {
      res.setHeader('Retry-After', '60');
      rpcError(res, 429, -32003, 'Rate limit exceeded');
      return;
    }
    next();
  };
}

/**
 * Verify a Google-issued token. On failure, point the client at the
 * protected-resource metadata so it can start a sign-in.
 */
function makeAuthMiddleware(opts: AppOptions) {
  const resourceMetadataUrl =
    opts.googleProvider && opts.baseUrl
      ? getOAuthProtectedResourceMetadataUrl(new URL('/mcp', opts.baseUrl))
      : undefined;

  const challenge = (): string => {
    const parts = ['Bearer realm="autotask-mcp"'];
    if (resourceMetadataUrl) parts.push(`resource_metadata="${resourceMetadataUrl}"`);
    return parts.join(', ');
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const provider = opts.googleProvider;
    if (!provider) {
      rpcError(
        res,
        503,
        -32002,
        'Server not configured: Google sign-in is not set up, so /mcp cannot serve. ' +
          'See /health for everything still missing.',
      );
      return;
    }

    const presented = bearerFrom(req.headers);
    if (presented) {
      try {
        (req as Request & { auth?: unknown }).auth = await provider.verifyAccessToken(presented);
        next();
        return;
      } catch {
        // Fall through to the 401 below.
      }
    }

    res.setHeader('WWW-Authenticate', challenge());
    rpcError(res, 401, -32001, 'Unauthorized');
  };
}

/** The signed-in person for this request, if there is one. */
export function callerFrom(req: Request): CallerIdentity | undefined {
  const auth = (req as Request & { auth?: { extra?: Record<string, unknown> } }).auth;
  const email = auth?.extra?.email;
  if (typeof email !== 'string') return undefined;
  const resourceId = auth?.extra?.resourceId;
  return { email, resourceId: typeof resourceId === 'number' ? resourceId : undefined };
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

async function handlePost(req: Request, res: Response, opts: AppOptions): Promise<void> {
  const caller = callerFrom(req);
  const sid = req.headers['mcp-session-id'];
  const sessionId = typeof sid === 'string' ? sid : undefined;

  try {
    if (isInitializeRequest(req.body)) {
      if (opts.sessions.full) {
        rpcError(res, 503, -32004, 'Server at session capacity, try again later');
        return;
      }

      // Registration happens in onsessioninitialized so the id is the one the
      // transport actually assigned, not one we guessed. `holder` closes the
      // loop between the hooks and the objects the factory is constructing.
      const holder: { server?: McpServer; transport?: StreamableHTTPServerTransport } = {};
      const { server, transport } = opts.createSession({
        onsessioninitialized: (id) => {
          opts.sessions.set({
            id,
            transport: holder.transport!,
            server: holder.server!,
            lastSeen: Date.now(),
          });
        },
        onsessionclosed: (id) => opts.sessions.delete(id),
      });
      holder.server = server;
      holder.transport = transport;

      await server.connect(transport);
      await withCaller(caller, () => transport.handleRequest(req, res, req.body));
      return;
    }

    const session = sessionId ? opts.sessions.get(sessionId) : undefined;
    if (!session) {
      rpcError(
        res,
        404,
        -32001,
        sessionId ? 'Session not found or expired' : 'Missing Mcp-Session-Id header',
      );
      return;
    }
    // Identity is bound per request, not per session: the same session's later
    // calls still carry whoever is making them.
    await withCaller(caller, () => session.transport.handleRequest(req, res, req.body));
  } catch (err) {
    failed(res, err);
  }
}

async function handleSessionScoped(
  req: Request,
  res: Response,
  opts: AppOptions,
  terminate: boolean,
): Promise<void> {
  const sid = req.headers['mcp-session-id'];
  const sessionId = typeof sid === 'string' ? sid : undefined;
  const session = sessionId ? opts.sessions.get(sessionId) : undefined;
  if (!session) {
    rpcError(res, 404, -32001, 'Session not found');
    return;
  }
  try {
    await withCaller(callerFrom(req), () => session.transport.handleRequest(req, res));
    if (terminate) opts.sessions.delete(session.id);
  } catch (err) {
    failed(res, err);
  }
}

function failed(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!res.headersSent) {
    rpcError(res, 500, -32603, message);
  } else {
    res.end();
  }
}

// --- bootstrap ---------------------------------------------------------------

export interface RunningServer {
  httpServer: HttpServer;
  sessions: SessionStore;
  close: () => Promise<void>;
}

export type Persistence = 'firestore' | 'memory';

/**
 * Decide where OAuth clients and tokens live.
 *
 * Firestore is the default anywhere Cloud Run is detected (K_SERVICE), because
 * in-memory registration there is a known-broken configuration: the instance is
 * replaced on every deploy, and each replacement silently invalidates every
 * client that had already registered. Local runs and tests stay in memory,
 * where a restart is expected and Firestore credentials are usually absent.
 * AUTOTASK_PERSISTENCE overrides the choice in either direction.
 */
export function resolvePersistence(env: NodeJS.ProcessEnv = process.env): Persistence {
  const requested = env.AUTOTASK_PERSISTENCE?.trim().toLowerCase();
  if (requested === 'firestore' || requested === 'memory') return requested;
  if (requested) {
    console.error(
      `[autotask-mcp] ignoring AUTOTASK_PERSISTENCE=${requested}: expected 'firestore' or 'memory'`,
    );
  }
  return env.K_SERVICE ? 'firestore' : 'memory';
}

export function buildStores(persistence: Persistence): {
  tokenStore: TokenStoreLike;
  clientsStore: OAuthRegisteredClientsStore;
} {
  if (persistence === 'firestore') {
    // The Firestore client resolves credentials lazily, at query time, so
    // constructing it cannot fail the boot of a misconfigured deployment.
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    return {
      tokenStore: new FirestoreTokenStore({ projectId }),
      clientsStore: new FirestoreClientsStore({ projectId }),
    };
  }
  return { tokenStore: new TokenStore(), clientsStore: new MemoryClientsStore() };
}

/** Build the Google bridge from the environment, or null when not configured. */
export function googleProviderFromEnv(
  baseUrl: URL | undefined,
  tokenStore: TokenStoreLike,
  clientsStore: OAuthRegisteredClientsStore,
): GoogleAuthProvider | null {
  const clientId = process.env.AUTOTASK_OAUTH_CLIENT_ID;
  const clientSecret = process.env.AUTOTASK_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (!baseUrl) {
    console.error(
      '[autotask-mcp] Google sign-in is configured but AUTOTASK_BASE_URL is not set. ' +
        'It is the OAuth issuer and the callback origin, so sign-in stays disabled until it is.',
    );
    return null;
  }

  return new GoogleAuthProvider({
    clientId,
    clientSecret,
    callbackUrl: new URL('/callback', baseUrl).href,
    allowedDomains: envList('AUTOTASK_OAUTH_ALLOWED_DOMAINS'),
    allowedEmails: envList('AUTOTASK_OAUTH_ALLOWED_EMAILS'),
    clientsStore,
    tokenStore,
    tokenTtlSeconds: envInt('AUTOTASK_OAUTH_TOKEN_TTL_SECONDS', 12 * 60 * 60),
  });
}

export async function runHttp(): Promise<RunningServer> {
  const rawBase = process.env.AUTOTASK_BASE_URL;
  const baseUrl = rawBase ? new URL(rawBase) : undefined;
  const persistence = resolvePersistence();
  const { tokenStore, clientsStore } = buildStores(persistence);

  let googleProvider: GoogleAuthProvider | null = null;
  try {
    googleProvider = googleProviderFromEnv(baseUrl, tokenStore, clientsStore);
  } catch (err) {
    // A misconfigured allowlist must not silently downgrade to "any Google
    // account can sign in": refuse to enable Google auth and say why.
    console.error(`[autotask-mcp] Google sign-in disabled: ${(err as Error).message}`);
  }

  if (!googleProvider) {
    // Deliberately not fatal. Exiting crash-loops the Cloud Run revision before
    // /health can say why, and makes "deploy, then configure" impossible. /mcp
    // refuses every request in this state, so starting cannot expose anything.
    console.error(
      '[autotask-mcp] WARNING: Google sign-in is not configured. Starting anyway so /health ' +
        'can report it, but /mcp will refuse every request with 503 until it is.',
    );
  }

  // Loopback is unreachable from outside a container, so serverless runtimes
  // (which set K_SERVICE) bind all interfaces unless told otherwise.
  const host = process.env.AUTOTASK_HTTP_HOST ?? (process.env.K_SERVICE ? '0.0.0.0' : DEFAULT_HOST);
  const port = envInt('PORT', DEFAULT_PORT);
  const rateLimitPerMinute = envInt('AUTOTASK_RATE_LIMIT', DEFAULT_RATE_LIMIT);
  const limiter = rateLimitPerMinute > 0 ? new RateLimiter(rateLimitPerMinute) : null;
  const sessions = new SessionStore(
    envInt('AUTOTASK_MAX_SESSIONS', DEFAULT_MAX_SESSIONS),
    envInt('AUTOTASK_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS),
  );

  const opts: AppOptions = {
    googleProvider,
    baseUrl,
    sessions,
    limiter,
    allowedOrigins: envList('AUTOTASK_HTTP_ALLOWED_ORIGINS'),
    allowedHosts: envList('AUTOTASK_HTTP_ALLOWED_HOSTS'),
    maxBodyBytes: envInt('AUTOTASK_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    createSession: defaultCreateSession,
    persistence,
  };

  const app = createApp(opts);

  const reaper = setInterval(() => {
    void sessions.reap();
    limiter?.reap();
    // Persistent stores sweep over the network, so a failure here must not
    // reject into an unhandled rejection and take the process down.
    void Promise.resolve(tokenStore.sweep()).catch((err: Error) => {
      console.error(`[autotask-mcp] token sweep failed: ${err.message}`);
    });
  }, REAP_INTERVAL_MS);
  reaper.unref();

  const { registeredCount, skipped } = buildServer();
  const httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });

  const missing = missingConfig(opts);
  console.error(
    `[autotask-mcp] HTTP transport on ${host}:${port} (mode: ${isReadonly() ? 'READONLY' : 'full'}, ` +
      `auth: ${googleProvider ? 'google' : 'none'}, persistence: ${persistence}, ` +
      `${registeredCount} tools, ${skipped} write tools skipped` +
      `${missing.length ? `, UNCONFIGURED: ${missing.join(', ')}` : ''})`,
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
