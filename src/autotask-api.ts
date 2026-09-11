import { ZoneInformation } from './types.js';
import { governor } from './governor.js';
import { currentCaller } from './auth/context.js';

// Unauthenticated endpoint used to discover which Autotask zone (data center)
// an account lives in. Returns the correct REST base URL for that account.
const ZONE_INFO_URL = 'https://webservices.autotask.net/atservicesrest/V1.0/zoneInformation';

const MAX_RETRIES = 3;
const ERROR_BODY_MAX_LEN = 500;
const REDACT_PLACEHOLDER = '[REDACTED]';

// GET/DELETE are safe to retry on transient 5xx: GET has no side effects and
// Autotask DELETE is idempotent (a repeat call on a removed record returns 404
// rather than corrupting state). POST/PATCH/PUT are never auto-retried on 5xx.
const RETRYABLE_5XX_METHODS = new Set(['GET', 'DELETE']);

// Autotask's complaint when a create is attributed to an impersonated resource
// the API user's security level may not impersonate onto that entity. "The
// logged in Resource" is the *impersonated* person, not the API user, which is
// why the same call succeeds unattributed. Matched loosely: Autotask has
// reworded this string before and the wrapping JSON varies by entity.
const IMPERSONATION_REFUSAL = /adequate permissions to (create|add)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip credential-like values from text before it reaches logs or tool output. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  // 1) key:value / key=value style leaks.
  let out = text.replace(
    /("?(?:secret|password|apiintegrationcode|integration[_-]?code|username|api[_-]?key|token|authorization)"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
    `$1${REDACT_PLACEHOLDER}`,
  );
  // 2) Exact current credential values, wherever they appear (free-text leaks
  //    like "invalid secret <value>" that the key:value pattern would miss).
  for (const envName of ['AUTOTASK_SECRET', 'AUTOTASK_INTEGRATION_CODE']) {
    const value = process.env[envName];
    if (value && value.length >= 4) {
      out = out.replace(new RegExp(escapeRegExp(value), 'g'), REDACT_PLACEHOLDER);
    }
  }
  if (out.length > ERROR_BODY_MAX_LEN) {
    out = out.slice(0, ERROR_BODY_MAX_LEN) + '…[truncated]';
  }
  return out;
}

/**
 * Whether ImpersonationResourceId may be sent for this call.
 *
 * Autotask supports impersonation on *create* operations only, and only for a
 * subset of entities (tickets, ticket/task notes, attachments, project notes
 * and status, service calls). It also requires the API user's security level to
 * permit impersonation on that entity type, so sending the header where it is
 * not supported risks failing a call that would otherwise have worked. Restrict
 * it to entity creates: a POST that is not one of the /query reads.
 *
 * The query string is stripped before matching. Paging cursors are POSTs that
 * carry one (`/query/next?paging=...`), and impersonating one makes Autotask
 * judge the *impersonated* resource's rights on a read, which it answers with
 * `500 The logged in Resource does not have the adequate permissions to query
 * this entity type`.
 */
export function isImpersonatableWrite(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  const clean = path.split('?')[0].replace(/\/+$/, '').toLowerCase();
  if (/\/query(\/count|\/next)?$/.test(clean)) return false;
  if (/\/contacts$/.test(clean)) return false;
  return true;
}

export class AutotaskApi {
  private username: string;
  private secret: string;
  private integrationCode: string;
  private baseUrl: string | null;
  private zonePromise: Promise<string> | null = null;

  constructor() {
    this.username = process.env.AUTOTASK_USERNAME || '';
    this.secret = process.env.AUTOTASK_SECRET || '';
    this.integrationCode = process.env.AUTOTASK_INTEGRATION_CODE || '';

    if (!this.username || !this.secret || !this.integrationCode) {
      throw new Error(
        'AUTOTASK_USERNAME, AUTOTASK_SECRET and AUTOTASK_INTEGRATION_CODE environment variables are required',
      );
    }

    // Allow pinning the zone URL to skip auto-detection (e.g. in gateways).
    const pinned = process.env.AUTOTASK_API_URL;
    this.baseUrl = pinned ? this.normalizeBase(pinned) : null;
  }

  private normalizeBase(url: string): string {
    // Autotask zoneInformation returns "https://webservicesN.autotask.net/atservicesrest/".
    // Normalize so a single trailing slash separates it from "V1.0/...".
    return url.endsWith('/') ? url : `${url}/`;
  }

  private authHeaders(method: string, path: string, impersonate = true): Record<string, string> {
    const headers: Record<string, string> = {
      ApiIntegrationCode: this.integrationCode,
      UserName: this.username,
      Secret: this.secret,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // Attribute the record to the signed-in person instead of the API user.
    const caller = currentCaller();
    if (impersonate && caller?.resourceId !== undefined && isImpersonatableWrite(method, path)) {
      headers.ImpersonationResourceId = String(caller.resourceId);
    }
    return headers;
  }

  /** Resolve (and cache) the account's REST base URL via zone detection. */
  private async getBaseUrl(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    if (this.zonePromise) return this.zonePromise;

    this.zonePromise = this.detectZone().finally(() => {
      this.zonePromise = null;
    });
    return this.zonePromise;
  }

  private async detectZone(): Promise<string> {
    const url = `${ZONE_INFO_URL}?user=${encodeURIComponent(this.username)}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zone detection failed (${resp.status}): ${redactSecrets(text)}`);
    }
    const zone = (await resp.json()) as ZoneInformation;
    if (!zone.url) {
      throw new Error('Zone detection returned no URL. Set AUTOTASK_API_URL to pin the zone.');
    }
    this.baseUrl = this.normalizeBase(zone.url);
    return this.baseUrl;
  }

  /**
   * Low-level REST call. `path` is relative to the zone base, e.g.
   * "V1.0/Tickets/query". Retries GET/DELETE on 5xx and any method on 429.
   *
   * Every call passes through the governor, which caps our concurrency at
   * Autotask's per-endpoint thread limit and refuses to spend the last of the
   * tenant-wide hourly budget. `internal` bypasses it for the governor's own
   * ThresholdInformation probe, which would otherwise recurse.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { internal?: boolean; maxRetries?: number } = {},
  ): Promise<unknown> {
    if (opts.internal) {
      return this.execute(method, path, body, opts.maxRetries);
    }
    await governor.assertBudget(() => this.fetchThresholdRaw());
    return governor.withSlot(path, () => this.execute(method, path, body, opts.maxRetries));
  }

  /**
   * The governor's own budget probe. Never governed (it would deadlock), and
   * never retried: the governor fails open on error, so retrying a failing
   * ThresholdInformation would stall every tool call behind seconds of backoff
   * to reach the same "allow it through" answer.
   */
  private fetchThresholdRaw(): Promise<unknown> {
    return this.request('GET', 'V1.0/ThresholdInformation', undefined, {
      internal: true,
      maxRetries: 0,
    });
  }

  private async execute(
    method: string,
    path: string,
    body?: unknown,
    maxRetries = MAX_RETRIES,
  ): Promise<unknown> {
    const base = await this.getBaseUrl();
    const url = `${base}${path.replace(/^\//, '')}`;
    let attempt = 0;
    // Cleared permanently for this call once Autotask refuses the impersonated
    // create, so the retry and any later backoff attempt go unattributed too.
    let impersonate = true;

    while (true) {
      const headers = this.authHeaders(method, path, impersonate);
      const options: RequestInit = { method, headers };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const resp = await fetch(url, options);

      if (resp.status === 204) return { success: true };
      if (resp.ok) {
        const text = await resp.text();
        return text ? JSON.parse(text) : { success: true };
      }

      // 429: Autotask API threshold reached. Honor Retry-After, then back off.
      if (resp.status === 429 && attempt < maxRetries) {
        const retryAfter = resp.headers.get('Retry-After');
        const delayMs = retryAfter
          ? Math.max(0, parseInt(retryAfter, 10) * 1000)
          : 1000 * Math.pow(2, attempt);
        await sleep(delayMs);
        attempt++;
        continue;
      }

      // 5xx: only retry safe/idempotent methods, with full-jitter backoff.
      if (
        resp.status >= 500 &&
        resp.status < 600 &&
        RETRYABLE_5XX_METHODS.has(method) &&
        attempt < maxRetries
      ) {
        await sleep(Math.random() * 1000 * Math.pow(2, attempt));
        attempt++;
        continue;
      }

      const text = await resp.text();

      // An impersonated create Autotask will not attribute. The record itself
      // is permitted (the API user can create it); only the attribution is
      // refused, so retry once unattributed rather than failing work the caller
      // is entitled to do. Losing the byline beats losing the ticket.
      if (headers.ImpersonationResourceId !== undefined && IMPERSONATION_REFUSAL.test(text)) {
        impersonate = false;
        continue;
      }

      throw new Error(`Autotask API error (${resp.status}): ${redactSecrets(text)}`);
    }
  }

  // --- Generic entity operations -----------------------------------------

  /**
   * Encode an entity path segment-by-segment so child-collection paths such as
   * "Tickets/123/Notes" keep their slashes (encodeURIComponent on the whole
   * string would turn "/" into "%2F" and break the URL).
   */
  private encodePath(entity: string): string {
    return entity
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  /** Query records of an entity. `query` is the Autotask search object. */
  async query(entity: string, query: unknown): Promise<unknown> {
    return this.request('POST', `V1.0/${this.encodePath(entity)}/query`, query);
  }

  /**
   * Follow a `pageDetails.nextPageUrl` returned by a previous query.
   *
   * POST with the original query model, both learned from the live API:
   * `query` posts, so the cursor comes back as `/query/next?paging=...`, which
   * answers a GET with `405 does not support http method 'GET'`, and answers a
   * bodyless POST with `500 Value cannot be null. Parameter name: queryModel`.
   * The URL carries only the page position; the query itself still travels in
   * the body, and per Autotask it must be unchanged between pages.
   *
   * The URL comes from the agent, so it must live under this account's zone
   * base; without that check the tool is a fetch-anything proxy wearing
   * Autotask credentials. Re-entering `request` keeps the governor, retries and
   * auth headers in play.
   */
  async getPage(url: string, query: unknown): Promise<unknown> {
    const base = await this.getBaseUrl();
    if (!url.startsWith(base)) {
      throw new Error(`nextPageUrl must start with ${base}`);
    }
    return this.request('POST', url.slice(base.length), query);
  }

  /** Count records matching a query, without fetching them. */
  async queryCount(entity: string, query: unknown): Promise<unknown> {
    return this.request('POST', `V1.0/${this.encodePath(entity)}/query/count`, query);
  }

  /** Fetch a single record by id. */
  async getById(entity: string, id: string): Promise<unknown> {
    return this.request('GET', `V1.0/${this.encodePath(entity)}/${encodeURIComponent(id)}`);
  }

  /** Create a record. */
  async create(entity: string, fields: unknown): Promise<unknown> {
    let resolvedEntity = entity;
    if (resolvedEntity.toLowerCase() === 'contacts' && fields && typeof fields === 'object') {
      const rec = fields as Record<string, unknown>;
      const companyID = rec.companyID ?? rec.CompanyID;
      if (
        typeof companyID === 'number' ||
        (typeof companyID === 'string' && /^\d+$/.test(companyID))
      ) {
        resolvedEntity = `Companies/${companyID}/Contacts`;
      }
    }
    return this.request('POST', `V1.0/${this.encodePath(resolvedEntity)}`, fields);
  }

  /** Partially update a record. Body must include the record `id`. */
  async update(entity: string, fields: unknown): Promise<unknown> {
    let resolvedEntity = entity;
    if (resolvedEntity.toLowerCase() === 'contacts' && fields && typeof fields === 'object') {
      const rec = fields as Record<string, unknown>;
      let companyID = rec.companyID ?? rec.CompanyID;
      if (companyID === undefined && rec.id !== undefined) {
        try {
          const existing = (await this.getById('Contacts', String(rec.id))) as {
            item?: { companyID?: number };
          };
          companyID = existing?.item?.companyID;
        } catch {
          // Fall through to original entity path
        }
      }
      if (companyID !== undefined) {
        resolvedEntity = `Companies/${companyID}/Contacts`;
      }
    }
    return this.request('PATCH', `V1.0/${this.encodePath(resolvedEntity)}`, fields);
  }

  /** Delete a record by id. */
  async deleteById(entity: string, id: string): Promise<unknown> {
    let resolvedEntity = entity;
    if (resolvedEntity.toLowerCase() === 'contacts') {
      try {
        const existing = (await this.getById('Contacts', id)) as {
          item?: { companyID?: number };
        };
        const companyID = existing?.item?.companyID;
        if (companyID !== undefined) {
          resolvedEntity = `Companies/${companyID}/Contacts`;
        }
      } catch {
        // Fall through to original entity path
      }
    }
    return this.request(
      'DELETE',
      `V1.0/${this.encodePath(resolvedEntity)}/${encodeURIComponent(id)}`,
    );
  }

  /** Describe an entity's fields (names, types, picklist values). */
  async entityFields(entity: string): Promise<unknown> {
    return this.request('GET', `V1.0/${this.encodePath(entity)}/entityInformation/fields`);
  }

  /** Current API usage against the integration-code rate threshold. */
  async thresholdInformation(): Promise<unknown> {
    return this.request('GET', 'V1.0/ThresholdInformation');
  }

  /** REST API version string. Cheap connectivity / diagnostic check. */
  async version(): Promise<unknown> {
    return this.request('GET', 'V1.0/Version');
  }
}

/** The three credentials every Autotask REST call needs. */
const REQUIRED_ENV = ['AUTOTASK_USERNAME', 'AUTOTASK_SECRET', 'AUTOTASK_INTEGRATION_CODE'] as const;

/** Which required credentials are missing. Empty means fully configured. */
export function missingCredentials(): string[] {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

export function isConfigured(): boolean {
  return missingCredentials().length === 0;
}

let instance: AutotaskApi | null = null;

/**
 * Construct (once) and return the shared client.
 *
 * Deliberately lazy. Building it at module load meant a container with missing
 * credentials threw during import and exited before the HTTP server could bind,
 * so Cloud Run only ever saw a start-up timeout and `/health` could never say
 * why. Deferring construction to the first actual Autotask call lets the server
 * boot, report `configured: false` on `/health`, and fail individual tool calls
 * with a message that names the missing variables.
 */
export function getApi(): AutotaskApi {
  if (!instance) instance = new AutotaskApi();
  return instance;
}

/** Drop the memoized client. Tests use this to pick up changed credentials. */
export function resetApi(): void {
  instance = null;
}

/**
 * Call-site-compatible handle on the lazily built client: `api.query(...)`
 * constructs it on first use rather than at import.
 */
export const api = new Proxy({} as AutotaskApi, {
  get(_target, prop, receiver) {
    const real = getApi();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});
