#!/usr/bin/env node

import { runStdio } from './server.js';

/**
 * Cloud Run (and Knative generally) sets K_SERVICE. It also health-checks the
 * container by connecting to $PORT, which stdio never binds, so a serverless
 * container that defaulted to stdio would start, log, exit 0, and fail its
 * start-up probe forever. Default to HTTP there instead. An explicit
 * AUTOTASK_TRANSPORT always wins, so `docker run -i ... -e
 * AUTOTASK_TRANSPORT=stdio` still works anywhere.
 */
function resolveTransport(): 'http' | 'stdio' {
  const explicit = (process.env.AUTOTASK_TRANSPORT || '').toLowerCase();
  if (explicit === 'http') return 'http';
  if (explicit === 'stdio') return 'stdio';
  return process.env.K_SERVICE ? 'http' : 'stdio';
}

async function main(): Promise<void> {
  if (resolveTransport() === 'http') {
    // Loaded lazily so the stdio path never pays for the HTTP transport.
    const { runHttp } = await import('./http.js');
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error('[autotask-mcp] fatal:', err);
  process.exit(1);
});
