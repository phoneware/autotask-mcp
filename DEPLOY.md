# Deploying the Phoneware-hosted Autotask MCP

Phoneware's fork of [`veeemlab/autotask-mcp`](https://github.com/veeemlab/autotask-mcp),
run as a hosted MCP on Cloud Run in `phoneware-edge`, mirroring
`phoneware/bandwidth-mcp` and `phoneware/peplink-mcp`.

## Architecture / security

- **Transport.** MCP Streamable HTTP at `POST/GET/DELETE /mcp`, one MCP session
  per client. Sessions live in instance memory, so the service runs
  `--min-instances=1 --max-instances=1 --session-affinity`. Do not scale it out
  or to zero: a session stranded on another instance is a dead session.
- **Auth: Google sign-in.** OAuth 2.1 in front of `/mcp`, with Google as the
  upstream identity provider and a domain allowlist. Autotask has **no OAuth,
  no SSO and no per-user credentials**, so Google is not standing in for
  Autotask auth: its only job is to produce a verified email.
- **Attribution.** That email is matched against Autotask `Resources` and the
  resource id rides out on `ImpersonationResourceId`, so a ticket note reads as
  the person who asked rather than as the API user. Autotask supports
  impersonation on **create** operations only, and only for tickets, ticket and
  task notes, attachments, project notes and status, and service calls, so the
  header is restricted to entity creates. Sign-in requires the email to resolve
  to exactly one **active** resource: no match, a deactivated record, a
  duplicate, or a service-account security level are all refused, because none
  of them identify a single person we can act as, and a write we cannot
  attribute is a root-level write with nobody's name on it.
- **Authorization.** The REST API authenticates as one API user with full
  system-administrator rights, and those rights apply to every call whoever
  asked. Impersonation does not narrow them, so this server narrows them
  itself: capabilities (read / create / update / delete) are derived from the
  person's Autotask `userType`, tools beyond them are never registered for that
  session, and the call is checked again at runtime. Autotask does not expose
  the permission matrix behind its security levels over REST, so the mapping in
  `src/auth/capabilities.ts` is a conservative approximation of it and is the
  one place to change it. Rights are re-derived on every token refresh.
  Without this, every `@phoneware.us` account had the API user's full access.
- **No shared bearer.** Google sign-in is the only way in. A static token with
  no identity, no expiry and no domain allowlist would be a weaker parallel
  door, and its writes would land as the API user, which is the audit hole
  sign-in exists to close. A future headless caller should present a Google
  service-account ID token, not a shared secret.
- **Token and client durability.** Issued tokens and DCR client registrations
  live in Firestore (the `(default)` database in `phoneware-edge`, collections
  `autotask_mcp_oauth_clients` and `autotask_mcp_oauth_tokens`), so a deploy
  neither logs anyone out nor breaks an existing connection. This is not a
  nicety: an MCP client registers once, caches the `client_id` it was issued,
  and presents it forever after. When those registrations lived in instance
  memory, every deploy invalidated every already-connected client, which then
  got `{"error":"invalid_client"}` from `/authorize` with no way to know it
  should register again. Firestore is chosen automatically wherever Cloud Run
  is detected (`K_SERVICE`); `AUTOTASK_PERSISTENCE` overrides it, and `/health`
  reports which backend is live. Do not set it to `memory` on Cloud Run.
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

> **Running these:** the `phoneware-edge` project is not visible to the
> default `jason.waldrip@wifiwithoutwalls.com` gcloud account. Either add
> `--account=jasonw@phoneware.us` to each command or
> `gcloud config set account jasonw@phoneware.us` first.

## One-time setup

> **Status.** The pipeline itself is done and green: WIF authorizes this repo
> (monorepo #504), the `autotask-mcp` Artifact Registry repository exists
> (monorepo #505), and the service builds, pushes and deploys. What is left is
> configuration, and it needs Autotask admin access plus Secret Manager write,
> so it cannot be automated from CI.
>
> Until it lands, the service boots and stays up: `/health` returns 200 with
> `"configured": false` and names every missing variable, and `/mcp` refuses
> every request with 503. It deliberately does not crash, because a
> crash-looping revision hides the reason, and it cannot run open, because the
> refusal happens before any token comparison.
>
> The image also defaults to the HTTP transport and binds `0.0.0.0` whenever
> `K_SERVICE` is set, so a Cloud Run revision comes up without needing
> `AUTOTASK_TRANSPORT` and `AUTOTASK_HTTP_HOST` to be set by hand first.

1. **Dedicated Autotask API user.** In Autotask: Admin → Resources/Users →
   new API-only user. Copy the default `API User (system) (API-only)` security
   level, scope the copy, and assign it. Record the username, secret, and the
   27-character integration code (tracking identifier).
2. **Map the public hostname.** The DNS CNAME already exists (monorepo
   `infra/terraform/godaddy.tf`, `mcp_autotask_cname`), but without a Cloud Run
   domain mapping the hostname serves nothing. Do this _before_ the Google
   client and the env vars: the hostname is the OAuth issuer and the origin of
   the redirect Google validates, so changing it later means redoing both.

   ```bash
   gcloud beta run domain-mappings create \
     --service=autotask-mcp \
     --domain=mcp.autotask.phoneware.cloud \
     --region=us-central1 --project=phoneware-edge
   ```

   Wait for the managed certificate before continuing:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.autotask.phoneware.cloud/health
   ```

3. **Google OAuth client.** Google Cloud console → APIs & Services →
   Credentials → Create OAuth client ID → Web application. Authorized redirect
   URI: `https://mcp.autotask.phoneware.cloud/callback`, which must equal
   `AUTOTASK_BASE_URL` + `/callback` exactly. Record the client id and secret.
4. **Secrets** in Secret Manager (`phoneware-edge`):
   ```bash
   printf %s '<autotask-secret>' | gcloud secrets create autotask-mcp-secret \
     --data-file=- --project=phoneware-edge
   printf %s '<google-oauth-client-secret>' | gcloud secrets create autotask-mcp-google-secret \
     --data-file=- --project=phoneware-edge
   ```
5. Grant the Cloud Run runtime service account read access on both
   secrets. The service currently runs as the project's default compute SA:

   ```bash
   for SECRET in autotask-mcp-secret autotask-mcp-google-secret; do
     gcloud secrets add-iam-policy-binding "$SECRET" \
       --member=serviceAccount:859122914438-compute@developer.gserviceaccount.com \
       --role=roles/secretmanager.secretAccessor \
       --project=phoneware-edge
   done
   ```

6. **Configure the service.** These persist across deploys, and
   `cloudbuild.yaml` deliberately never passes `--set-env-vars`, which would
   wipe them:

   ```bash
   gcloud run services update autotask-mcp --region=us-central1 \
     --update-env-vars=\
   AUTOTASK_TRANSPORT=http,\
   AUTOTASK_HTTP_HOST=0.0.0.0,\
   AUTOTASK_USERNAME=<api-user>,\
   AUTOTASK_INTEGRATION_CODE=<tracking-id>,\
   AUTOTASK_HTTP_ALLOWED_HOSTS=mcp.autotask.phoneware.cloud,\
   AUTOTASK_BASE_URL=https://mcp.autotask.phoneware.cloud,\
   AUTOTASK_OAUTH_CLIENT_ID=<google-client-id>,\
   AUTOTASK_OAUTH_ALLOWED_DOMAINS=phoneware.us \
     --update-secrets=\
   AUTOTASK_SECRET=autotask-mcp-secret:latest,\
   AUTOTASK_OAUTH_CLIENT_SECRET=autotask-mcp-google-secret:latest
   ```

   > `AUTOTASK_BASE_URL` must be the **public** hostname, not the Cloud Run
   > `*.run.app` one: it is the OAuth issuer and the origin of the redirect
   > Google validates. That is why the domain mapping is step 2.

   Then confirm `/health` reports `"configured": true` and
   `"auth": {"google": true}`.

7. Restart-free check: `gcloud run services update` creates a new revision, so
   the new configuration is live as soon as the command returns.

### Already done (recorded so nobody repeats it)

- **WIF.** The shared `github` provider allowlists repositories explicitly.
  `phoneware/autotask-mcp` was added to its `attribute_condition`, with the
  matching `roles/iam.workloadIdentityUser` binding on `edge-tf-deployer`
  (`infra/terraform/github-actions.tf` in the monorepo).
- **Artifact Registry.** `autotask-mcp` in `us-central1`, tracked in
  `infra/terraform/main.tf` rather than created by hand.
- **Firestore.** The `(default)` database already exists in `phoneware-edge`
  (Native mode, `us-central1`) and is already used by `peplink-mcp`. The Cloud
  Run runtime service account (`859122914438-compute@developer.gserviceaccount.com`)
  already holds `roles/datastore.user`. OAuth persistence therefore needed no
  new database, no new binding, and no environment variable: it turns itself on
  from `K_SERVICE`. Collections are created on first write.

## Deploy

Push to `main`. `.github/workflows/deploy.yml` authenticates with Workload
Identity Federation and submits `cloudbuild.yaml`, which runs lint, format
check, tests and build before it builds the image. Never deploy from a
workstation.

## Connect

Claude Code, or any client that can set a header:

```bash
claude mcp add autotask --transport http https://mcp.autotask.phoneware.cloud/mcp
```

claude.ai → Settings → Connectors → Add custom connector, URL
`https://mcp.autotask.phoneware.cloud/mcp`. It discovers the OAuth metadata,
registers itself, and sends you to Google. No client id or secret to paste.

There is no static-bearer alternative: every caller signs in, and every write is
attributed to a person.

## Verify

- `GET /health` returns `{"ok":true,...}` with `mode`, `sessions` and
  `autotaskUsagePct`.
- `POST /mcp` with no bearer returns 401 with a `WWW-Authenticate` header
  carrying `resource_metadata=...`.
- Two clients connected at once each get their own `Mcp-Session-Id` and both
  work (covered by `tests/http.test.ts`).
- `get-threshold-information` reports the tenant's current API usage.

## Local smoke test

```bash
npm ci && npm run build
AUTOTASK_TRANSPORT=http \
AUTOTASK_BASE_URL=http://127.0.0.1:3000 \
AUTOTASK_OAUTH_CLIENT_ID=... AUTOTASK_OAUTH_CLIENT_SECRET=... \
AUTOTASK_OAUTH_ALLOWED_DOMAINS=phoneware.us \
AUTOTASK_USERNAME=... AUTOTASK_SECRET=... AUTOTASK_INTEGRATION_CODE=... \
node dist/index.js
# In another shell:
curl -s localhost:3000/health
curl -si -X POST localhost:3000/mcp | head -1   # expect 401
```
