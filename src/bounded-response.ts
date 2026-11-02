import crypto from 'node:crypto';

export const MAX_AUTOTASK_JSON_BYTES = 7_000_000;
export const MAX_PDF_MEDIA_BYTES = 5_000_000;
export const MAX_IMAGE_DECODED_BYTES = 3 * 1024 * 1024;
export const MAX_IAM_JSON_BYTES = 65_536;
export const MAX_DRIVE_METADATA_BYTES = 262_144;

export class ResponseCeilingExceededError extends Error {
  readonly ceiling: number;
  readonly bytesRead: number;

  constructor(ceiling: number, bytesRead: number, contextLabel = 'Response') {
    super(
      `${contextLabel} exceeded maximum permitted response ceiling of ${ceiling} bytes (read at least ${bytesRead} bytes)`,
    );
    this.name = 'ResponseCeilingExceededError';
    this.ceiling = ceiling;
    this.bytesRead = bytesRead;
  }
}

/**
 * Read a response body as a Buffer, strictly enforcing an upper bound on received bytes.
 * If the body exceeds maxBytes, streaming is aborted immediately.
 */
export async function readBoundedBuffer(
  resp: Response,
  maxBytes: number,
  contextLabel = 'Response',
  timeoutMs = 15000,
): Promise<Buffer> {
  const contentLength = resp.headers.get('content-length');
  if (contentLength) {
    const declared = parseInt(contentLength, 10);
    if (!Number.isNaN(declared) && declared > maxBytes) {
      if (resp.body) {
        try {
          await resp.body.cancel();
        } catch {
          // Ignore cancel error
        }
      }
      throw new ResponseCeilingExceededError(maxBytes, declared, contextLabel);
    }
  }

  if (!resp.body) {
    return Buffer.alloc(0);
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  let timer: NodeJS.Timeout | undefined;
  try {
    const { promise: streamPromise, reject: timeoutReject } = Promise.withResolvers<never>();
    timer = setTimeout(async () => {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel error
      }
      timeoutReject(new Error(`${contextLabel} timed out after ${timeoutMs}ms while reading stream`));
    }, timeoutMs);

    const readChunks = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new ResponseCeilingExceededError(maxBytes, totalBytes, contextLabel);
          }
          chunks.push(value);
        }
      }
    };

    await Promise.race([readChunks(), streamPromise]);
  } catch (err) {
    if (err instanceof ResponseCeilingExceededError) {
      throw err;
    }
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel error
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return Buffer.concat(chunks);
}

/**
 * Read response body as UTF-8 text with strict byte ceiling.
 */
export async function readBoundedText(
  resp: Response,
  maxBytes: number,
  contextLabel = 'Response',
): Promise<string> {
  const buf = await readBoundedBuffer(resp, maxBytes, contextLabel);
  return buf.toString('utf8');
}

/**
 * Read and parse JSON from response body with strict byte ceiling.
 */
export async function readBoundedJson<T = unknown>(
  resp: Response,
  maxBytes: number,
  contextLabel = 'JSON response',
): Promise<T> {
  const text = await readBoundedText(resp, maxBytes, contextLabel);
  if (!text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

/**
 * Streamingly compute SHA-256 hash and byte length of a response body without
 * buffering the entire payload in memory. Strictly enforces maxBytes.
 */
export async function readBoundedAndHash(
  resp: Response,
  maxBytes: number,
  contextLabel = 'Media stream',
  timeoutMs = 15000,
): Promise<{ sha256: string; byteLength: number }> {
  if (!resp.body) {
    return {
      sha256: crypto.createHash('sha256').digest('hex'),
      byteLength: 0,
    };
  }

  const reader = resp.body.getReader();
  const hash = crypto.createHash('sha256');
  let byteLength = 0;

  let timer: NodeJS.Timeout | undefined;
  try {
    const { promise: streamPromise, reject: timeoutReject } = Promise.withResolvers<never>();
    timer = setTimeout(async () => {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel error
      }
      timeoutReject(new Error(`${contextLabel} timed out after ${timeoutMs}ms while reading stream`));
    }, timeoutMs);

    const readAndHash = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          byteLength += value.byteLength;
          if (byteLength > maxBytes) {
            await reader.cancel();
            throw new ResponseCeilingExceededError(maxBytes, byteLength, contextLabel);
          }
          hash.update(value);
        }
      }
    };

    await Promise.race([readAndHash(), streamPromise]);
  } catch (err) {
    if (err instanceof ResponseCeilingExceededError) {
      throw err;
    }
    try {
      await reader.cancel();
    } catch {
      // Ignore
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return {
    sha256: hash.digest('hex'),
    byteLength,
  };
}
