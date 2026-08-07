/**
 * What a signed-in person is allowed to do, derived from their Autotask
 * security level.
 *
 * Why this layer has to exist at all: the Autotask REST API authenticates as a
 * single API user, and that user's security level applies to every call no
 * matter who asked for it. `ImpersonationResourceId` changes *attribution* on
 * creates; it does not change *rights*. So without something here, everyone who
 * clears the Google domain check inherits the API user's full
 * system-administrator access, merely labelled with their own name. Autotask
 * cannot enforce the person's own permissions for us, so we enforce them.
 *
 * The signal we have is `Resource.userType`, Autotask's own security-level
 * reference. Autotask does not expose the permission matrix behind those levels
 * over REST (`SecurityPolicies` is not a queryable entity and there is no
 * `securityLevelID` field on Resources), so this cannot mirror Autotask exactly.
 * It is a deliberate, conservative approximation of it, and the mapping below is
 * the authority.
 *
 * Anything not listed gets read-only. A security level nobody has classified
 * must never inherit write access by default.
 */

/** The four things a tool can do to Autotask. */
export type Capability = 'read' | 'create' | 'update' | 'delete';

export const ALL_CAPABILITIES: readonly Capability[] = ['read', 'create', 'update', 'delete'];

/** Read-only is the floor for anyone who is allowed in at all. */
export const READ_ONLY: readonly Capability[] = ['read'];

/**
 * Autotask `userType` values, for logs and error messages. These are Autotask's
 * system security levels as reported by the Resources entity picklist.
 */
export const USER_TYPE_LABELS: ReadonlyMap<number, string> = new Map([
  [10, 'Full Access'],
  [11, 'Dashboard User'],
  [12, 'Minimal Access'],
  [13, 'API User'],
  [14, 'System Administrator'],
  [15, 'Manager'],
  [16, 'Project Manager'],
  [17, 'Sales'],
  [18, 'Team Member'],
  [19, 'Contractor'],
  [20, 'Service Desk User'],
  [21, 'Private CRM'],
  [22, 'Time and Attendance'],
  [23, 'Co-managed Help Desk'],
  [24, "API User Can't Read Costs"],
]);

/**
 * Security levels that are service accounts, not people. A human signing in
 * must never be impersonated onto one: it would mean a person borrowing an
 * integration's identity, and integration identities are what this whole
 * mechanism exists to stop writes being attributed to.
 */
export const SERVICE_ACCOUNT_USER_TYPES: ReadonlySet<number> = new Set([13, 24]);

/**
 * userType to capabilities. Chosen with Jason 2026-08-07; change it here and
 * nowhere else.
 */
const CAPABILITIES_BY_USER_TYPE: ReadonlyMap<number, readonly Capability[]> = new Map([
  [14, ['read', 'create', 'update', 'delete']], // System Administrator
  [10, ['read', 'create', 'update', 'delete']], // Full Access
  [15, ['read', 'create', 'update']], // Manager
  [16, ['read', 'create', 'update']], // Project Manager
  [20, ['read', 'create']], // Service Desk User
  [18, ['read', 'create']], // Team Member
  [17, ['read', 'create']], // Sales
  [12, READ_ONLY], // Minimal Access
  [11, READ_ONLY], // Dashboard User
  [19, READ_ONLY], // Contractor
  [23, READ_ONLY], // Co-managed Help Desk
  [21, READ_ONLY], // Private CRM
  [22, READ_ONLY], // Time and Attendance
]);

/** Human-readable name for a userType, for logs and messages. */
export function labelForUserType(userType: number | undefined): string {
  if (userType === undefined) return 'unknown';
  return USER_TYPE_LABELS.get(userType) ?? `userType ${userType}`;
}

/** Whether this security level belongs to an integration rather than a person. */
export function isServiceAccount(userType: number | undefined): boolean {
  return userType !== undefined && SERVICE_ACCOUNT_USER_TYPES.has(userType);
}

/**
 * Capabilities for an Autotask security level.
 *
 * An unrecognised level is read-only, not refused: a new or custom security
 * level should not lock someone out of looking things up, but it must not hand
 * them write access nobody granted either.
 */
export function capabilitiesForUserType(userType: number | undefined): readonly Capability[] {
  if (userType === undefined) return READ_ONLY;
  return CAPABILITIES_BY_USER_TYPE.get(userType) ?? READ_ONLY;
}

/** Whether `capabilities` permits `needed`. */
export function permits(capabilities: readonly Capability[], needed: Capability): boolean {
  return capabilities.includes(needed);
}
