/**
 * Sealed OAuth state.
 *
 * A pending sign-in and an authorization code are not kept in this process.
 * Each is sealed with AES-256-GCM into a value that any instance can open,
 * because the only shared input is AUTOTASK_SECRET. A sign-in can therefore
 * start on one instance and finish on another, and a restart, a scale-to-zero,
 * or a deploy loses nothing that is in flight.
 *
 * Keys are derived per purpose with HMAC-SHA256 over the secret, so the secret
 * is never used directly as a cipher key, and a value sealed for one purpose
 * cannot be opened as another. The purpose is also bound as additional
 * authenticated data. Sealing proves a value was issued here. It does not make
 * a value single use; that is recorded in the token store.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export const SEAL_PURPOSES = {
  pendingAuthorization: 'pending-authorization',
  authorizationCode: 'authorization-code',
} as const;

export type SealPurpose = (typeof SEAL_PURPOSES)[keyof typeof SEAL_PURPOSES];

/** The shortest secret that may key sealing. Shorter ones refuse to start. */
export const MIN_SEALING_SECRET_BYTES = 32;

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
  const bytes = Buffer.byteLength(secret, 'utf8');
  if (bytes < MIN_SEALING_SECRET_BYTES) {
    throw new Error(
      `AUTOTASK_SECRET must be at least ${MIN_SEALING_SECRET_BYTES} bytes to key OAuth sealing; it is ${bytes}. The value is not printed.`,
    );
  }
  return secret;
}

function aadFor(purpose: SealPurpose): string {
  return `autotask-mcp/seal/v1/${purpose}`;
}

export class Sealer {
  private readonly secret: string;
  private readonly keys = new Map<SealPurpose, Buffer>();

  constructor(secret: string) {
    this.secret = assertSealingSecret(secret);
  }

  /** Seal a JSON-serialisable payload. Output is base64url: iv, tag, ciphertext. */
  seal(purpose: SealPurpose, payload: object): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keyFor(purpose), iv);
    cipher.setAAD(Buffer.from(aadFor(purpose), 'utf8'));
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
      decipher.setAAD(Buffer.from(aadFor(purpose), 'utf8'));
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
      key = createHmac('sha256', this.secret).update(aadFor(purpose), 'utf8').digest();
      this.keys.set(purpose, key);
    }
    return key;
  }
}
