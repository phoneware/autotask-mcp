import crypto from 'node:crypto';

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

  return permit;
}

export function computeBodyDigest(body: unknown): string {
  if (body === undefined || body === null) {
    return crypto.createHash('sha256').update('').digest('hex');
  }
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

export interface RouteClassification {
  isProtected: boolean;
  reason?: string;
  curatedTool?: string;
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
  const normMethod = method.toUpperCase().trim();
  const cleanPath = rawPath.replace(/^\/+/, '').trim();

  // Read-only methods
  if (normMethod === 'GET' || normMethod === 'HEAD') {
    return { isProtected: false };
  }

  // 1. TicketNotes (root or child collections)
  if (
    /(?:^|\/)ticketnotes(?:\/|$)/i.test(cleanPath) ||
    /tickets\/[^/]+\/notes(?:\/|$)/i.test(cleanPath)
  ) {
    return {
      isProtected: true,
      reason: 'Creating or modifying ticket notes is a protected evidence mutation',
      curatedTool: 'record-ticket-evidence',
    };
  }

  // 2. ChecklistItems (root or child collections)
  if (
    /(?:^|\/)ticketchecklistitems(?:\/|$)/i.test(cleanPath) ||
    /tickets\/[^/]+\/checklistitems(?:\/|$)/i.test(cleanPath)
  ) {
    return {
      isProtected: true,
      reason: 'Modifying checklist items is a protected checklist mutation',
      curatedTool: 'set-ticket-checklist-item',
    };
  }

  // 3. Ticket resolution updates or replacement-style writes
  if (/(?:^|\/)tickets(?:\/|$)/i.test(cleanPath)) {
    if (normMethod === 'DELETE') {
      return {
        isProtected: true,
        reason: 'Ticket deletion destroys evidence and requires coordinated dispatch',
      };
    }

    if (normMethod === 'PUT') {
      return {
        isProtected: true,
        reason: 'Replacement-style ticket PUT writes are protected mutations',
        curatedTool: 'append-ticket-resolution',
      };
    }

    if (normMethod === 'PATCH' && body && typeof body === 'object') {
      const keys = Object.keys(body as Record<string, unknown>).map((k) => k.toLowerCase());
      if (
        keys.includes('resolution') ||
        keys.includes('resolutiondetails') ||
        keys.includes('resolutionplan')
      ) {
        return {
          isProtected: true,
          reason: 'Modifying ticket resolution is a protected resolution mutation',
          curatedTool: 'append-ticket-resolution',
        };
      }
    }
  }

  return { isProtected: false };
}
