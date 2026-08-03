# Deploying the Phoneware-hosted Autotask MCP

Phoneware's fork of [`veeemlab/autotask-mcp`](https://github.com/veeemlab/autotask-mcp),
run as a hosted MCP on Cloud Run in `phoneware-edge`, mirroring
`phoneware/bandwidth-mcp` and `phoneware/peplink-mcp`.

## Architecture / security

- **Transport.** MCP Streamable HTTP at `POST/GET/DELETE /mcp`, one MCP session
  per client. Sessions live in instance memory, so the service runs
  `--min-instances=1 --max-instances=1 --session-affinity`. Do not scale it out
  or to zero: a session stranded on another instance is a dead session.
- **Auth.** A single shared bearer token (`AUTOTASK_HTTP_TOKEN`, Secret
  Manager), checked in constant time, with a `WWW-Authenticate` challenge on
  failure. Autotask has **no OAuth, no SSO and no per-user credentials**, so
  there is no user identity to bind a session to yet.
- **Attribution caveat.** Because there is no user identity, every write is
  attributed to the API user, not to the person who asked for it. Autotask's
  `ImpersonationResourceId` request header is how that gets fixed later (it is
  supported on Tickets, TicketNotes, TaskNotes, Attachments, project notes and
  status, and service calls, on create). The hook point is the bearer check in
  `createRouter` in `src/http.ts`: whatever it resolves to a user would be
  carried onto the session and out as that header.
- **The Autotask credential is root.** The API User (API-only) security level
  grants full system administrator access to Autotask data over REST, and it
  never expires. Give this service its **own dedicated API user** on a custom
  API security level scoped to the tool surface. API users are free and
  unlimited, and Autotask allows up to 50 custom API security levels, so there
  is no reason to share one.
- **Writes are enabled** (`AUTOTASK_READ_ONLY` unset) and every mutating tool
  still requires its explicit confirm token. Set `AUTOTASK_READ_ONLY=true` to
  de-register the write tools entirely.
- **Budget governor.** Autotask's limits are tenant-wide, not per-integration:
  10,000 requests/hour counted per _database_ across every integration, and 3
  concurrent requests per object endpoint per tracking identifier. Blowing the
  hourly budget suspends API access for the entire Autotask tenant, so an agent
  loop here would take down every other Phoneware integration. The server caps
  its own concurrency at 3 per endpoint and stops serving Autotask calls at 90%
  of the hourly budget. Current usage is on `/health`.

## One-time setup

> **Status.** The pipeline itself is done and green: WIF authorizes this repo
> (monorepo #504), the `autotask-mcp` Artifact Registry repository exists
> (monorepo #505), and the service builds, pushes and deploys. What is left is
> configuration, and it needs Autotask admin access plus Secret Manager write,
> so it cannot be automated from CI.
>
> Until it lands, the service boots but reports `"configured": false` on
> `/health` and names the missing variables. It deliberately does not crash:
> a crash-looping revision hides the reason.

1. **Dedicated Autotask API user.** In Autotask: Admin → Resources/Users →
   new API-only user. Copy the default `API User (system) (API-only)` security
   level, scope the copy, and assign it. Record the username, secret, and the
   27-character integration code (tracking identifier).
2. **Secrets** in Secret Manager (`phoneware-edge`):
   ```bash
   printf %s '<autotask-secret>' | gcloud secrets create autotask-mcp-secret \
     --data-file=- --project=phoneware-edge
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets create autotask-mcp-http-token \
     --data-file=- --project=phoneware-edge
   ```
3. Grant the Cloud Run runtime SA `roles/secretmanager.secretAccessor` on both
   secrets.
4. **Configure the service.** These persist across deploys, and
   `cloudbuild.yaml` deliberately never passes `--set-env-vars`, which would
   wipe them:
   ```bash
   gcloud run services update autotask-mcp --region=us-central1 \
     --update-env-vars=\
   AUTOTASK_TRANSPORT=http,\
   AUTOTASK_HTTP_HOST=0.0.0.0,\
   AUTOTASK_USERNAME=<api-user>,\
   AUTOTASK_INTEGRATION_CODE=<tracking-id>,\
   AUTOTASK_HTTP_ALLOWED_HOSTS=mcp.autotask.phoneware.cloud \
     --update-secrets=\
   AUTOTASK_SECRET=autotask-mcp-secret:latest,\
   AUTOTASK_HTTP_TOKEN=autotask-mcp-http-token:latest
   ```
   Then confirm `/health` reports `"configured": true`.
5. Optionally map DNS `mcp.autotask.phoneware.cloud` (CNAME in the monorepo
   `godaddy.tf`, mirroring `mcp.peplink` and `mcp.bandwidth`).

### Already done (recorded so nobody repeats it)

- **WIF.** The shared `github` provider allowlists repositories explicitly.
  `phoneware/autotask-mcp` was added to its `attribute_condition`, with the
  matching `roles/iam.workloadIdentityUser` binding on `edge-tf-deployer`
  (`infra/terraform/github-actions.tf` in the monorepo).
- **Artifact Registry.** `autotask-mcp` in `us-central1`, tracked in
  `infra/terraform/main.tf` rather than created by hand.

## Deploy

Push to `main`. `.github/workflows/deploy.yml` authenticates with Workload
Identity Federation and submits `cloudbuild.yaml`, which runs lint, format
check, tests and build before it builds the image. Never deploy from a
workstation.

## Connect

Claude Code, or any client that can set a header:

```bash
claude mcp add autotask --transport http \
  https://mcp.autotask.phoneware.cloud/mcp \
  --header "Authorization: Bearer <AUTOTASK_HTTP_TOKEN>"
```

A claude.ai custom connector will **not** work against this deployment: that UI
performs OAuth discovery, and this server presents a static bearer challenge. It
needs the OAuth gate described above before it can be added as a connector.

## Verify

- `GET /health` returns `{"ok":true,...}` with `mode`, `sessions` and
  `autotaskUsagePct`.
- `POST /mcp` with no bearer returns 401 with a `WWW-Authenticate` header.
- Two clients connected at once each get their own `Mcp-Session-Id` and both
  work (covered by `tests/http.test.ts`).
- `get-threshold-information` reports the tenant's current API usage.

## Local smoke test

```bash
npm ci && npm run build
AUTOTASK_TRANSPORT=http \
AUTOTASK_HTTP_TOKEN=$(openssl rand -hex 24) \
AUTOTASK_USERNAME=... AUTOTASK_SECRET=... AUTOTASK_INTEGRATION_CODE=... \
node dist/index.js
# In another shell:
curl -s localhost:3000/health
curl -si -X POST localhost:3000/mcp | head -1   # expect 401
```
