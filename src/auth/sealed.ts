/**
 * Sealed OAuth state.
 *
 * A pending sign-in and an authorization code are not kept in this process.
 * Each is sealed with AES-256-GCM into a value that any instance can open,
 * because the only shared input is AUTOTASK_SECRET. A sign-in can therefore
 * start on one instance and finish on another, and a restart, a scale-to-zero,
 * or a deploy loses nothing that is in flight.
 *
 * Each purpose gets its own key: HKDF-SHA256 (RFC 5869) over the secret, with a
 * fixed salt that only separates this use and a per-purpose info string. The
 * purpose is also bound as additional authenticated data, so a value sealed for
 * one purpose does not open as another. Sealing proves a value was issued here.
 * It does not make a value single use; that is recorded in the token store.
 *
 * The floor below refuses values that are obviously too short or too repetitive.
 * It is not an entropy measure: the secret's own entropy is what protects the
 * keys. Sealed values live for minutes, so changing the derivation only ends
 * sign-ins that are already in flight.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const SEAL_PURPOSES = {
  pendingAuthorization: 'pending-authorization',
  authorizationCode: 'authorization-code',
} as const;

export type SealPurpose = (typeof SEAL_PURPOSES)[keyof typeof SEAL_PURPOSES];

/**
 * The shortest secret that may key sealing. It is set below the length production
 * passes today. Measure the live value before raising it: a floor above the live
 * secret refuses to start the service.
 */
export const MIN_SEALING_SECRET_BYTES = 16;

/** The fewest distinct byte values a secret may contain, whatever its length. */
export const MIN_SEALING_SECRET_DISTINCT_BYTES = 12;

/** Example values a deployment can be left with. Refused by name. */
const PLACEHOLDER_SECRETS: Record<string, true> = {
  changeme: true,
  'change-me': true,
  change_me: true,
  placeholder: true,
  password: true,
  secret: true,
  'your-secret-here': true,
  'super-secret-value': true,
  'test-secret': true,
};

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Fixed and public. It only separates this use of HKDF from any other use. */
const KDF_SALT = Buffer.from('autotask-mcp/oauth-seal/salt/v2', 'utf8');

/**
 * Return the secret if it can key sealing, otherwise throw. The message names
 * the variable and never the value.
 */
export function assertSealingSecret(secret: string | undefined): string {
  if (!secret) {
    throw new Error(
      'AUTOTASK_SECRET is not set. It keys the sealing of OAuth sign-in state, so Google sign-in cannot start without it.',
    );
  }
  if (PLACEHOLDER_SECRETS[secret.toLowerCase()] === true) {
    throw new Error('AUTOTASK_SECRET is a placeholder value. Set a real secret.');
  }
  const bytes = Buffer.from(secret, 'utf8');
  if (bytes.length < MIN_SEALING_SECRET_BYTES) {
    throw new Error(
      `AUTOTASK_SECRET must be at least ${MIN_SEALING_SECRET_BYTES} bytes to key OAuth sealing; it is ${bytes.length}. The value is not printed.`,
    );
  }
  const distinct = new Set(bytes).size;
  if (distinct < MIN_SEALING_SECRET_DISTINCT_BYTES) {
    throw new Error(
      `AUTOTASK_SECRET has ${distinct} distinct byte values; at least ${MIN_SEALING_SECRET_DISTINCT_BYTES} are required. The value is not printed.`,
    );
  }
  return secret;
}

/** The HKDF info string and the AEAD associated data for one purpose. */
function labelFor(purpose: SealPurpose): string {
  return `autotask-mcp/seal/v2/${purpose}`;
}

export class Sealer {
  private readonly secret: Buffer;
  private readonly keys = new Map<SealPurpose, Buffer>();

  constructor(secret: string) {
    this.secret = Buffer.from(assertSealingSecret(secret), 'utf8');
  }

  /** Seal a JSON-serialisable payload. Output is base64url: iv, tag, ciphertext. */
  seal(purpose: SealPurpose, payload: object): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keyFor(purpose), iv);
    cipher.setAAD(Buffer.from(labelFor(purpose), 'utf8'));
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  /**
   * The payload that was sealed, or undefined when the value is malformed,
   * altered, sealed under another secret, or sealed for another purpose.
   */
  unseal(purpose: SealPurpose, sealed: string): unknown {
    try {
      const bytes = Buffer.from(sealed, 'base64url');
      if (bytes.length <= IV_BYTES + TAG_BYTES) return undefined;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.keyFor(purpose),
        bytes.subarray(0, IV_BYTES),
      );
      decipher.setAAD(Buffer.from(labelFor(purpose), 'utf8'));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  private keyFor(purpose: SealPurpose): Buffer {
    let key = this.keys.get(purpose);
    if (!key) {
      key = Buffer.from(
        hkdfSync(
          'sha256',
          this.secret,
          KDF_SALT,
          Buffer.from(labelFor(purpose), 'utf8'),
          KEY_BYTES,
        ),
      );
      this.keys.set(purpose, key);
    }
    return key;
  }
}
