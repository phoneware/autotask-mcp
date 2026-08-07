/**
 * Which redirect URIs this authorization server will send an authorization code
 * to.
 *
 * This is the security boundary that dynamic client registration does not
 * provide. `/register` is open and unauthenticated, as MCP clients require, so
 * anyone can obtain a client_id; a registration proves nothing about who is
 * asking. What actually matters is where the code is delivered, because that is
 * the one step where a successful sign-in turns into someone else's access.
 *
 * Without a policy here, an attacker can register a client whose redirect_uri
 * points at their own server, send a phoneware.us user the resulting authorize
 * link, and collect the code the moment that person completes Google sign-in.
 * Every other control we have (PKCE, the domain allowlist, the Autotask
 * resource check) is satisfied in that flow, because the victim really is who
 * they say they are. Constraining the destination is what stops it.
 *
 * The default set covers how MCP clients actually work:
 *   - loopback on any port, which is the native-app pattern in RFC 8252 and
 *     what Claude Code uses (the port is chosen per attempt, so it cannot be
 *     pinned)
 *   - the hosted claude.ai connector callback
 * Anything else has to be named explicitly in AUTOTASK_OAUTH_REDIRECT_ALLOWLIST.
 */

/** Redirect targets permitted in addition to loopback, unless overridden. */
export const DEFAULT_REDIRECT_ALLOWLIST: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
];

function loopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Whether a code may be delivered to `raw`.
 *
 * Loopback is matched by host only, since the port is assigned per sign-in
 * attempt. Everything else must match an allowlisted entry exactly, after
 * normalisation, so a lookalike host or an appended path cannot slip through.
 */
export function isAllowedRedirectUri(
  raw: string,
  allowlist: readonly string[] = DEFAULT_REDIRECT_ALLOWLIST,
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // A redirect carrying its own credentials is never something we issued.
  if (url.username || url.password) return false;

  if (loopback(url.hostname)) {
    // http is expected here: a loopback listener has no certificate. https is
    // fine too, and nothing else is.
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  // Off-machine, only TLS, and only somewhere named.
  if (url.protocol !== 'https:') return false;
  return allowlist.some((entry) => {
    let allowed: URL;
    try {
      allowed = new URL(entry);
    } catch {
      return false;
    }
    return (
      allowed.protocol === url.protocol &&
      allowed.host === url.host &&
      allowed.pathname.replace(/\/$/, '') === url.pathname.replace(/\/$/, '')
    );
  });
}

/**
 * A client id we are willing to store and echo back.
 *
 * Adopting an id a client proposes means writing it as a document key and
 * putting it in log lines, so it has to be an opaque identifier rather than
 * anything with structure. Real ones are UUIDs; this is deliberately a little
 * wider than that and no wider.
 */
export function isPlausibleClientId(value: string): boolean {
  return /^[A-Za-z0-9._~-]{8,128}$/.test(value);
}
