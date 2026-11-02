import crypto from 'node:crypto';
import { assertSafeNumericId } from '../security.js';

export interface DispatchPermitToken {
  readonly __brand: unique symbol;
}

export interface DispatchPermitDetails {
  dispatchId: string;
  provider: 'autotask' | 'google-drive';
  accountKey: string;
  target: string;
  method: string;
  route: string;
  exactBodyDigest: string;
  policyFingerprint?: string;
  issuedAt: number;
}

// Module-private WeakMap ensures tokens cannot be forged, inspected, or serialized
const permitStore = new WeakMap<object, DispatchPermitDetails>();

/**
 * Issue a runtime-opaque, single-use dispatch permit after transactional arming.
 */
export function issueDispatchPermit(details: DispatchPermitDetails): DispatchPermitToken {
  const token = Object.freeze({});
  permitStore.set(token, details);
  return token as unknown as DispatchPermitToken;
}

/**
 * Consume a dispatch permit immediately before outbound network fetch.
 * Validates request parameters against the armed permit and enforces single-use semantics.
 */
export function consumeDispatchPermit(
  token: DispatchPermitToken | undefined,
  request: {
    provider: 'autotask' | 'google-drive';
    accountKey?: string;
    target?: string;
    dispatchId?: string;
    method: string;
    route: string;
    bodyDigest: string;
  },
): DispatchPermitDetails {
  if (!token || typeof token !== 'object') {
    throw new Error('Refused: protected mutation requires a valid dispatch permit');
  }

  const permit = permitStore.get(token as object);
  if (!permit) {
    throw new Error('Refused: dispatch permit is invalid, already consumed, or expired');
  }

  // Single-use: delete immediately upon consumption attempt
  permitStore.delete(token as object);

  const now = Date.now();
  if (now - permit.issuedAt > 60_000) {
    throw new Error('Refused: dispatch permit has expired');
  }

  if (permit.provider !== request.provider) {
    throw new Error(
      `Permit mismatch: expected provider "${permit.provider}", got "${request.provider}"`,
    );
  }

  if (permit.method.toUpperCase() !== request.method.toUpperCase()) {
    throw new Error(
      `Permit mismatch: expected HTTP method "${permit.method}", got "${request.method}"`,
    );
  }

  const normPermitRoute = permit.route.replace(/^\/+/, '').toLowerCase();
  const normReqRoute = request.route.replace(/^\/+/, '').toLowerCase();
  if (normPermitRoute !== normReqRoute) {
    throw new Error(
      `Permit mismatch: route mismatch (permit: "${permit.route}", request: "${request.route}")`,
    );
  }

  if (permit.exactBodyDigest !== request.bodyDigest) {
    throw new Error('Permit mismatch: exact outbound request body digest does not match armed permit');
  }

  if (request.accountKey && permit.accountKey !== request.accountKey) {
    throw new Error(
      `Permit mismatch: accountKey mismatch (permit: "${permit.accountKey}", request: "${request.accountKey}")`,
    );
  }

  if (request.target && permit.target !== request.target) {
    throw new Error(
      `Permit mismatch: target mismatch (permit: "${permit.target}", request: "${request.target}")`,
    );
  }

  if (request.dispatchId && permit.dispatchId !== request.dispatchId) {
    throw new Error(
      `Permit mismatch: dispatchId mismatch (permit: "${permit.dispatchId}", request: "${request.dispatchId}")`,
    );
  }

  return permit;
}

export function computeBodyDigest(body: unknown): string {
  if (body === undefined || body === null) {
    return crypto.createHash('sha256').update('').digest('hex');
  }
  if (Buffer.isBuffer(body)) {
    return crypto.createHash('sha256').update(body).digest('hex');
  }
  if (body instanceof Uint8Array) {
    return crypto
      .createHash('sha256')
      .update(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
      .digest('hex');
  }
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHash('sha256').update(Buffer.from(serialized, 'utf-8')).digest('hex');
}

export interface RouteClassification {
  isProtected: boolean;
  reason?: string;
  curatedTool?: string;
}

export interface CanonicalRouteResolution {
  canonicalRoute: string;
  isProtected: boolean;
  isQuery: boolean;
  entity: string;
  childEntity?: string;
  parentId?: string;
  id?: string;
  reason?: string;
  curatedTool?: string;
}

/**
 * Resolve and canonicalize an Autotask API route/method/body combination.
 * Enforces canonical numeric IDs, consistent parent identities, query separation,
 * and rejection of traversal, backslashes, fragments, userinfo, and encoded separators.
 */
export function resolveCanonicalRoute(
  method: string,
  rawPath: string,
  body?: unknown,
): CanonicalRouteResolution {
  const normMethod = method.toUpperCase().trim();
  const allowedMethods = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'];
  if (!allowedMethods.includes(normMethod)) {
    throw new Error(`Refused: unsupported HTTP method "${method}"`);
  }

  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('Refused: path must be a non-empty string');
  }

  // Security checks: backslash, userinfo, fragment, encoded separators, traversal, malformed percent
  if (rawPath.includes('\\')) {
    throw new Error('Refused: path contains backslash');
  }
  if (rawPath.includes('@')) {
    throw new Error('Refused: path contains userinfo');
  }
  if (rawPath.includes('#')) {
    throw new Error('Refused: path contains fragment');
  }
  if (/%2f|%5c/i.test(rawPath)) {
    throw new Error('Refused: path contains encoded path separator');
  }
  if (/(?:^|\/)\.\.(?:\/|$)/.test(rawPath) || /(?:^|\/)\.(?:\/|$)/.test(rawPath)) {
    throw new Error('Refused: path contains directory traversal');
  }
  if (/%(?![0-9a-fA-F]{2})/.test(rawPath)) {
    throw new Error('Refused: path contains invalid percent-encoding');
  }

  // Separate pathname and query string
  const qIndex = rawPath.indexOf('?');
  let pathname = qIndex !== -1 ? rawPath.slice(0, qIndex) : rawPath;
  const queryString = qIndex !== -1 ? rawPath.slice(qIndex + 1) : '';

  if (queryString) {
    const pairs = queryString.split('&').filter(Boolean);
    const seenKeys = new Map<string, string>();
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      const rawKey = eqIdx !== -1 ? pair.slice(0, eqIdx) : pair;
      const rawVal = eqIdx !== -1 ? pair.slice(eqIdx + 1) : '';
      const key = decodeURIComponent(rawKey);
      const val = decodeURIComponent(rawVal);
      if (seenKeys.has(key) && seenKeys.get(key) !== val) {
        throw new Error(`Refused: duplicate conflicting query parameter "${key}"`);
      }
      seenKeys.set(key, val);
    }
  }

  pathname = pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const rawSegments = pathname.split('/').filter(Boolean);
  if (rawSegments.length === 0) {
    throw new Error('Refused: empty path');
  }

  const segments: string[] = [];
  for (const s of rawSegments) {
    const dec = decodeURIComponent(s);
    if (dec === '.' || dec === '..' || dec.includes('/') || dec.includes('\\')) {
      throw new Error('Refused: invalid path segment');
    }
    segments.push(dec);
  }

  if (segments[0].toLowerCase() === 'thresholdinformation') {
    segments.unshift('V1.0');
  } else if (segments[0].toUpperCase() === 'V1.0') {
    segments[0] = 'V1.0';
  } else {
    throw new Error(`Refused: unsupported API prefix "${segments[0]}", must start with V1.0`);
  }

  const pathAfter = segments.slice(1);
  if (pathAfter.length === 0) {
    throw new Error('Refused: route has no entity or resource specified');
  }

  // 1. ThresholdInformation
  if (pathAfter.length === 1 && pathAfter[0].toLowerCase() === 'thresholdinformation') {
    if (normMethod !== 'GET') {
      throw new Error('Refused: ThresholdInformation only supports GET');
    }
    return {
      canonicalRoute: 'V1.0/ThresholdInformation',
      isProtected: false,
      isQuery: false,
      entity: 'ThresholdInformation',
    };
  }

  const entity = pathAfter[0];
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(entity)) {
    throw new Error(`Refused: invalid entity name "${entity}"`);
  }

  // Check registered query routes
  // Flat queries: V1.0/<Entity>/query, V1.0/<Entity>/query/count, V1.0/<Entity>/query/next
  const isFlatQuery =
    (pathAfter.length === 2 && pathAfter[1].toLowerCase() === 'query') ||
    (pathAfter.length === 3 &&
      pathAfter[1].toLowerCase() === 'query' &&
      (pathAfter[2].toLowerCase() === 'count' || pathAfter[2].toLowerCase() === 'next'));

  // Child queries: V1.0/<ParentEntity>/<parentId>/<ChildEntity>/query, .../count, .../next
  let isChildQuery = false;
  let childEntity: string | undefined;
  let parentId: string | undefined;

  if (
    pathAfter.length >= 4 &&
    /^[A-Za-z][A-Za-z0-9_]*$/.test(pathAfter[2]) &&
    pathAfter[3].toLowerCase() === 'query'
  ) {
    if (
      pathAfter.length === 4 ||
      (pathAfter.length === 5 &&
        (pathAfter[4].toLowerCase() === 'count' || pathAfter[4].toLowerCase() === 'next'))
    ) {
      isChildQuery = true;
      parentId = assertSafeNumericId(pathAfter[1], 'parentId');
      childEntity = pathAfter[2];
    }
  }

  if (isFlatQuery || isChildQuery) {
    if (normMethod === 'POST') {
      // Documented search/count/next read queries are exempt from mutation protection
      const canonicalRoute = `V1.0/${pathAfter.join('/')}${queryString ? `?${queryString}` : ''}`;
      return {
        canonicalRoute,
        isProtected: false,
        isQuery: true,
        entity,
        childEntity,
        parentId,
      };
    }
  }

  // If method is GET or HEAD, read-only
  if (normMethod === 'GET' || normMethod === 'HEAD') {
    const canonicalRoute = `V1.0/${pathAfter.join('/')}${queryString ? `?${queryString}` : ''}`;
    return {
      canonicalRoute,
      isProtected: false,
      isQuery: false,
      entity,
      childEntity,
      parentId,
    };
  }

  // Validate parentId / id consistency on mutations
  if (pathAfter.length >= 2) {
    // Could be child collection or item ID
    if (/^\d+$/.test(pathAfter[1])) {
      parentId = assertSafeNumericId(pathAfter[1], 'parentId');
      if (pathAfter.length >= 3) {
        childEntity = pathAfter[2];
      }
    }
  }

  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    // Check parent FK consistency if present
    if (parentId !== undefined) {
      const bodyParentId =
        rec.ticketID ?? rec.ticketId ?? rec.companyID ?? rec.companyId ?? rec.parentId;
      if (bodyParentId !== undefined && bodyParentId !== null) {
        const canonicalBodyParentId = assertSafeNumericId(String(bodyParentId), 'bodyParentId');
        if (canonicalBodyParentId !== parentId) {
          throw new Error(
            `Refused: parent ID mismatch between path (${parentId}) and body (${canonicalBodyParentId})`,
          );
        }
      }
    }
  }

  const canonicalRoute = `V1.0/${pathAfter.join('/')}${queryString ? `?${queryString}` : ''}`;

  // Evaluate protected mutation classification
  // 1. TicketNotes (root or child collections)
  if (
    entity.toLowerCase() === 'ticketnotes' ||
    (childEntity && childEntity.toLowerCase() === 'notes' && entity.toLowerCase() === 'tickets')
  ) {
    return {
      canonicalRoute,
      isProtected: true,
      isQuery: false,
      entity,
      childEntity,
      parentId,
      reason: 'Creating or modifying ticket notes is a protected evidence mutation',
      curatedTool: 'record-ticket-evidence',
    };
  }

  // 2. ChecklistItems (root or child collections)
  if (
    entity.toLowerCase() === 'ticketchecklistitems' ||
    (childEntity &&
      childEntity.toLowerCase() === 'checklistitems' &&
      entity.toLowerCase() === 'tickets')
  ) {
    return {
      canonicalRoute,
      isProtected: true,
      isQuery: false,
      entity,
      childEntity,
      parentId,
      reason: 'Modifying checklist items is a protected checklist mutation',
      curatedTool: 'set-ticket-checklist-item',
    };
  }

  // 3. Tickets resolution, PUT replacement, or DELETE
  if (entity.toLowerCase() === 'tickets') {
    if (normMethod === 'DELETE') {
      return {
        canonicalRoute,
        isProtected: true,
        isQuery: false,
        entity,
        reason: 'Ticket deletion destroys evidence and requires coordinated dispatch',
      };
    }

    if (normMethod === 'PUT') {
      return {
        canonicalRoute,
        isProtected: true,
        isQuery: false,
        entity,
        reason: 'Replacement-style ticket PUT writes are protected mutations',
        curatedTool: 'append-ticket-resolution',
      };
    }

    if (normMethod === 'PATCH' && body && typeof body === 'object') {
      const keys = Object.keys(body as Record<string, unknown>).map((k) => k.toLowerCase());
      if (
        keys.includes('resolution') ||
        keys.includes('resolutiondetails') ||
        keys.includes('resolutionplan') ||
        keys.includes('resolutiondetail')
      ) {
        return {
          canonicalRoute,
          isProtected: true,
          isQuery: false,
          entity,
          reason: 'Modifying ticket resolution is a protected resolution mutation',
          curatedTool: 'append-ticket-resolution',
        };
      }
    }
  }

  return {
    canonicalRoute,
    isProtected: false,
    isQuery: false,
    entity,
    childEntity,
    parentId,
  };
}

/**
 * Classify whether an Autotask API route/method/payload represents a protected mutation
 * that MUST NOT bypass the coordinated single-dispatch admission framework.
 */
export function classifyRouteMutation(
  method: string,
  rawPath: string,
  body?: unknown,
): RouteClassification {
  const resolution = resolveCanonicalRoute(method, rawPath, body);
  return {
    isProtected: resolution.isProtected,
    reason: resolution.reason,
    curatedTool: resolution.curatedTool,
  };
}
