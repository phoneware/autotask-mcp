#!/usr/bin/env tsx

import { spawn, type ChildProcess } from 'node:child_process';
import { Firestore } from '@google-cloud/firestore';
import { AutotaskMirror } from '../test-support/autotask-mirror.js';
import { DriveMirror } from '../test-support/drive-mirror.js';
import { GoogleCredentialsMirror } from '../test-support/google-credentials-mirror.js';
import { runProvisioningScenarios } from './provisioning-scenarios.js';

async function waitForHealth(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // Retry
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 200);
    await promise;
  }
  throw new Error(`Timeout waiting for server at ${url}/health`);
}

async function run(): Promise<void> {
  console.log('=== Starting Contained Provisioning Proof (Two Processes) ===');

  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
  const projectId = 'test-phoneware-edge';
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  process.env.FIRESTORE_PROJECT_ID = projectId;

  const firestore = new Firestore({
    projectId,
    host: emulatorHost,
    ssl: false,
  });

  // 1. Start Vendor Mirrors
  const autotaskMirror = new AutotaskMirror();
  const atStarted = await autotaskMirror.start();

  const driveMirror = new DriveMirror();
  const driveStarted = await driveMirror.start();

  const credentialsMirror = new GoogleCredentialsMirror();
  const credsStarted = await credentialsMirror.start();

  console.log(`Autotask Mirror: ${atStarted.url}`);
  console.log(`Drive Mirror: ${driveStarted.baseUrl}`);
  console.log(`IAM Credentials Mirror: ${credsStarted.baseUrl}`);

  // 2. Seed synthetic OAuth token in Firestore
  const seededToken = 'test-token-tech-77';
  const tokenRecord = {
    accessToken: seededToken,
    refreshToken: 'test-refresh-tech-77',
    clientId: 'mcp-client-1',
    email: 'tech@phoneware.us',
    resourceId: 77,
    userType: 14,
    capabilities: ['read', 'create', 'update', 'delete'],
    expiresAt: Date.now() + 3600 * 1000,
    scopes: ['https://www.googleapis.com/auth/userinfo.email'],
  };

  await firestore.collection('autotask_mcp_tokens').doc(seededToken).set(tokenRecord);

  // 3. Spawn Two Independent HTTP Processes
  const port1 = 9811;
  const port2 = 9812;
  const proc1Url = `http://127.0.0.1:${port1}`;
  const proc2Url = `http://127.0.0.1:${port2}`;

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AUTOTASK_TRANSPORT: 'http',
    AUTOTASK_PERSISTENCE: 'firestore',
    AUTOTASK_USERNAME: 'tech@phoneware.us',
    AUTOTASK_SECRET: 'test-secret',
    AUTOTASK_INTEGRATION_CODE: 'TESTCODE',
    AUTOTASK_API_URL: atStarted.url,
    DRIVE_API_BASE_URL: driveStarted.baseUrl,
    DRIVE_UPLOAD_BASE_URL: driveStarted.uploadBaseUrl,
    IAM_API_BASE_URL: credsStarted.baseUrl,
    AUTOTASK_HTTP_HOST: '127.0.0.1',
    AUTOTASK_OAUTH_CLIENT_ID: 'google-client-id',
    AUTOTASK_OAUTH_CLIENT_SECRET: 'google-client-secret',
    AUTOTASK_OAUTH_ALLOWED_DOMAINS: 'phoneware.us',
  };

  const p1: ChildProcess = spawn('tsx', ['src/index.ts'], {
    env: { ...baseEnv, PORT: String(port1), AUTOTASK_HTTP_PORT: String(port1) },
    stdio: 'inherit',
  });

  const p2: ChildProcess = spawn('tsx', ['src/index.ts'], {
    env: { ...baseEnv, PORT: String(port2), AUTOTASK_HTTP_PORT: String(port2) },
    stdio: 'inherit',
  });

  try {
    console.log('Waiting for both processes to become healthy...');
    await Promise.all([waitForHealth(proc1Url), waitForHealth(proc2Url)]);
    console.log('Both processes are live and healthy.');

    // 4. Run Scenarios
    await runProvisioningScenarios({
      process1Url: proc1Url,
      process2Url: proc2Url,
      autotaskMirror,
      driveMirror,
      credentialsMirror,
      firestore,
      seededToken,
    });

    console.log('=== Contained Provisioning Proof Completed Successfully! ===');
  } finally {
    p1.kill();
    p2.kill();
    await autotaskMirror.stop();
    await driveMirror.stop();
    await credentialsMirror.stop();
  }
}

run().catch((err) => {
  console.error('[proof] Failed:', err);
  process.exit(1);
});
