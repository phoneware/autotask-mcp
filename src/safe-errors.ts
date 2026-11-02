/**
 * Bounded safe error formatters for public and persisted errors.
 * Guarantees that raw upstream response bodies, authorization tokens,
 * internal server paths, or secret canary tokens are never exposed.
 */

export class SafeError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly safeDetails?: Record<string, string | number | boolean>;

  constructor(
    code: string,
    message: string,
    status?: number,
    safeDetails?: Record<string, string | number | boolean>,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'SafeError';
    this.code = code;
    this.status = status;
    this.safeDetails = safeDetails;
  }
}

/**
 * Remove sensitive tokens, file paths, and authorization headers from error strings.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (!raw) return 'An unexpected error occurred';
  let clean = String(raw);

  // Redact bearer tokens and authorization headers
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  clean = clean.replace(/(?:key|token|secret|password|auth|apiKey)=([A-Za-z0-9._~+/-]+)/gi, '$1=[REDACTED]');

  // Redact local absolute file paths (Unix / macOS)
  clean = clean.replace(/(?:\/[a-zA-Z0-9._-]+){2,}/g, '[REDACTED_PATH]');

  // Bound length to avoid huge payload disclosures
  if (clean.length > 500) {
    clean = `${clean.slice(0, 500)}... [TRUNCATED]`;
  }

  return clean;
}

export function safeAutotaskError(
  status: number,
  safeCode: string,
  context?: Record<string, string | number | boolean>,
): SafeError {
  let defaultMsg = `Autotask request failed with HTTP ${status}`;
  if (status === 404) defaultMsg = 'Requested Autotask entity not found';
  if (status === 401 || status === 403) defaultMsg = 'Autotask authentication or permission denied';
  if (status === 429) defaultMsg = 'Autotask API rate limit exceeded';
  if (status >= 500) defaultMsg = 'Autotask upstream service unavailable';

  return new SafeError(safeCode, defaultMsg, status, context);
}

export function safeDriveError(
  status: number,
  safeCode: string,
  context?: Record<string, string | number | boolean>,
): SafeError {
  let defaultMsg = `Google Drive operation failed with HTTP ${status}`;
  if (status === 404) defaultMsg = 'Target Google Drive resource not found or inaccessible';
  if (status === 403) defaultMsg = 'Permission denied for Google Drive operation';
  if (status === 409) defaultMsg = 'Google Drive resource conflict';
  if (status >= 500) defaultMsg = 'Google Drive service unavailable';

  return new SafeError(safeCode, defaultMsg, status, context);
}

export function safeCoordinatorError(
  code: string,
  message: string,
  context?: Record<string, string | number | boolean>,
): SafeError {
  return new SafeError(code, message, 409, context);
}
