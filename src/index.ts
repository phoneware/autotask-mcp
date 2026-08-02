#!/usr/bin/env node

import { runStdio } from './server.js';

async function main(): Promise<void> {
  if ((process.env.AUTOTASK_TRANSPORT || '').toLowerCase() === 'http') {
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
