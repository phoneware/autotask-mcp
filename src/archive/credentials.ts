import { GoogleAuth } from 'google-auth-library';
import { readBoundedText, MAX_IAM_JSON_BYTES } from '../bounded-response.js';
import { safeDriveError } from '../safe-errors.js';

export interface ArchiveCredentialProviderConfig {
  iamBaseUrl?: string;
}

export interface EphemeralDriveCredential {
  accessToken: string;
  principal: string;
  scope: string;
  expiresAt: number;
}

export class ArchiveCredentialProvider {
  private readonly iamBaseUrl: string;
  private readonly cache = new Map<string, EphemeralDriveCredential>();

  constructor(config?: ArchiveCredentialProviderConfig) {
    this.iamBaseUrl = (
      config?.iamBaseUrl ||
      process.env.IAM_API_BASE_URL ||
      'https://iamcredentials.googleapis.com/v1'
    ).replace(/\/+$/, '');
  }

  async getDriveCredential(
    archivePrincipal: string,
    safetyMarginMs = 300_000,
  ): Promise<EphemeralDriveCredential> {
    const principal = archivePrincipal.trim();
    if (!principal) {
      throw new Error('archivePrincipal is required to obtain Drive credentials');
    }

    const scope = 'https://www.googleapis.com/auth/drive';
    const cacheKey = `${principal}:${scope}`;
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt - now > safetyMarginMs) {
      return cached;
    }

    // Acquire Google Cloud runtime Application Default Credentials
    let adcToken: string | null = null;
    try {
      const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      const client = await auth.getClient();
      const tokenRes = await client.getAccessToken();
      adcToken = tokenRes.token ?? null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ADC credentials unavailable: Google Cloud runtime identity required: ${sanitizeErrorMessage(msg)}`,
      );
    }

    if (!adcToken) {
      throw new Error('ADC credentials unavailable: GoogleAuth returned no access token');
    }

    const url = `${this.iamBaseUrl}/projects/-/serviceAccounts/${encodeURIComponent(
      principal,
    )}:generateAccessToken`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adcToken}`,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          scope: [scope],
          lifetime: '3600s',
        }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`IAM credentials request failed: ${sanitizeErrorMessage(msg)}`);
    }

    if (!res.ok) {
      throw safeDriveError(res.status, 'IAM_CREDENTIAL_ERROR');
    }

    const text = await readBoundedText(res, MAX_IAM_JSON_BYTES, 'IAM generateAccessToken');
    let json: { accessToken?: string; expireTime?: string } = {};
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('IAM credentials endpoint returned malformed JSON');
    }

    if (!json.accessToken || typeof json.accessToken !== 'string') {
      throw new Error('IAM credentials endpoint returned no accessToken');
    }

    if (!json.expireTime || typeof json.expireTime !== 'string') {
      throw new Error('IAM credentials endpoint returned no valid expireTime');
    }

    const freshNow = Date.now();
    const expiresAt = new Date(json.expireTime).getTime();
    if (Number.isNaN(expiresAt) || expiresAt - freshNow <= safetyMarginMs) {
      throw new Error(
        `IAM credentials endpoint returned token with insufficient validity (expires in ${Math.round(
          (expiresAt - freshNow) / 1000,
        )}s, requires margin of ${Math.round(safetyMarginMs / 1000)}s)`,
      );
    }
    const cred: EphemeralDriveCredential = {
      accessToken: json.accessToken,
      principal,
      scope,
      expiresAt,
    };

    this.cache.set(cacheKey, cred);
    return cred;
  }

  async getDriveAccessToken(archivePrincipal: string): Promise<string> {
    const cred = await this.getDriveCredential(archivePrincipal);
    return cred.accessToken;
  }
}
