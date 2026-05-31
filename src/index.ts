#!/usr/bin/env node

import { runStdio, runHttp } from './server.js';

async function main(): Promise<void> {
  if ((process.env.AUTOTASK_TRANSPORT || '').toLowerCase() === 'http') {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error('[autotask-mcp] fatal:', err);
  process.exit(1);
});
