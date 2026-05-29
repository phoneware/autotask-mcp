import { ZoneInformation } from './types.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip credential-like values from text before it reaches logs or tool output. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(
    /("?(?:secret|password|apiintegrationcode|integration[_-]?code|username|api[_-]?key|token|authorization)"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
    `$1${REDACT_PLACEHOLDER}`,
  );
  if (out.length > ERROR_BODY_MAX_LEN) {
    out = out.slice(0, ERROR_BODY_MAX_LEN) + '…[truncated]';
  }
  return out;
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

  private authHeaders(): Record<string, string> {
    return {
      ApiIntegrationCode: this.integrationCode,
      UserName: this.username,
      Secret: this.secret,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
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
   */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const base = await this.getBaseUrl();
    const url = `${base}${path.replace(/^\//, '')}`;
    let attempt = 0;

    while (true) {
      const options: RequestInit = { method, headers: this.authHeaders() };
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
      if (resp.status === 429 && attempt < MAX_RETRIES) {
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
        attempt < MAX_RETRIES
      ) {
        await sleep(Math.random() * 1000 * Math.pow(2, attempt));
        attempt++;
        continue;
      }

      const text = await resp.text();
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
    return this.request('POST', `V1.0/${this.encodePath(entity)}`, fields);
  }

  /** Partially update a record. Body must include the record `id`. */
  async update(entity: string, fields: unknown): Promise<unknown> {
    return this.request('PATCH', `V1.0/${this.encodePath(entity)}`, fields);
  }

  /** Delete a record by id. */
  async deleteById(entity: string, id: string): Promise<unknown> {
    return this.request('DELETE', `V1.0/${this.encodePath(entity)}/${encodeURIComponent(id)}`);
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

export const api = new AutotaskApi();
