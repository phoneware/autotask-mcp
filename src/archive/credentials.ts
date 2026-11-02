import { GoogleAuth } from 'google-auth-library';

export interface ArchiveCredentialProviderConfig {
  iamBaseUrl?: string;
  staticToken?: string;
}

export class ArchiveCredentialProvider {
  private readonly iamBaseUrl: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config?: ArchiveCredentialProviderConfig) {
    this.iamBaseUrl = (
      config?.iamBaseUrl ||
      process.env.IAM_API_BASE_URL ||
      'https://iamcredentials.googleapis.com/v1'
    ).replace(/\/+$/, '');
    this.cachedToken = config?.staticToken || process.env.DRIVE_ARCHIVE_ACCESS_TOKEN || null;
  }

  async getDriveAccessToken(archivePrincipal: string): Promise<string> {
    const now = Date.now();
    // Return cached token if valid for at least 5 more minutes
    if (this.cachedToken && this.tokenExpiresAt - now > 5 * 60 * 1000) {
      return this.cachedToken;
    }

    const isLocal =
      this.iamBaseUrl.includes('127.0.0.1') || this.iamBaseUrl.includes('localhost');

    let adcToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || null;
    if (!adcToken) {
      try {
        const auth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
        const client = await auth.getClient();
        const tokenRes = await client.getAccessToken();
        adcToken = tokenRes.token ?? null;
      } catch (err: unknown) {
        if (!isLocal) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `ADC credentials unavailable: Google Cloud runtime identity required for IAM token generation: ${msg}`,
          );
        }
      }
    }

    const url = `${this.iamBaseUrl}/projects/-/serviceAccounts/${encodeURIComponent(
      archivePrincipal,
    )}:generateAccessToken`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (adcToken) {
      headers['Authorization'] = `Bearer ${adcToken}`;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          scope: ['https://www.googleapis.com/auth/drive'],
          lifetime: '3600s',
        }),
      });

      if (res.ok) {
        const json = (await res.json()) as { accessToken?: string; expireTime?: string };
        if (json.accessToken) {
          this.cachedToken = json.accessToken;
          this.tokenExpiresAt = json.expireTime
            ? new Date(json.expireTime).getTime()
            : now + 3600 * 1000;
          return this.cachedToken;
        }
      }
    } catch (err: unknown) {
      if (!isLocal) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to generate Drive credentials for principal ${archivePrincipal}: ${msg}`,
        );
      }
    }

    if (isLocal || this.cachedToken) {
      return this.cachedToken || 'synthetic-mirror-drive-token';
    }

    throw new Error(
      `Failed to generate Drive access token for archive principal "${archivePrincipal}". ` +
        'Ensure Cloud Run runtime service account has roles/iam.serviceAccountTokenCreator on the target principal.',
    );
  }
}
