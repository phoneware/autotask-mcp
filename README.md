# Autotask MCP Server

[![CI](https://github.com/phoneware/autotask-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/phoneware/autotask-mcp/actions/workflows/ci.yml)
[![Deploy](https://github.com/phoneware/autotask-mcp/actions/workflows/deploy.yml/badge.svg)](https://github.com/phoneware/autotask-mcp/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Phoneware's fork of [`veeemlab/autotask-mcp`](https://github.com/veeemlab/autotask-mcp),
> run as a hosted MCP on Cloud Run. See [DEPLOY.md](DEPLOY.md). This fork is not
> published to npm; install it from source or the container image.

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Kaseya Autotask PSA**. It lets MCP-compatible AI clients (Claude Desktop, Claude Code, and others) read and write Autotask data through a small, AI-safe tool surface.

Instead of hand-coding one tool per Autotask entity, this server exposes a **generic entity layer** (query / get / create / update / delete against any of Autotask's 180+ REST entities) plus **convenience tools** for the entities you touch most: tickets, companies, contacts, projects, tasks and time entries.

> **Compact, AI-safe Autotask MCP server with full generic REST entity coverage and confirm-gated writes.**

## Why this server?

Most Autotask MCP servers expose many hand-written tools. This one takes a different approach:

- **Compact tool surface** — fewer tools for the model to choose from, so it picks the right one more reliably.
- **Full REST entity coverage** through generic `query` / `get` / `create` / `update` / `delete` tools — any of Autotask's 180+ entities, not just the ones someone hand-wrote.
- **Safer writes** — every mutation requires an explicit confirmation token.
- **Real read-only mode** — in read-only mode, write tools are not merely blocked at runtime; they are never registered with the MCP server at all.
- **Conservative retry policy** — `POST` / `PATCH` are never retried automatically, so a write can't be silently duplicated.

## Design philosophy

This project prioritizes a compact, AI-safe tool surface over exposing one tool per Autotask entity.

Instead of hundreds of entity-specific tools, it exposes a small generic layer that works across Autotask REST entities, plus convenience tools for common workflows. Fewer tools means less for the model to misuse and less code to maintain — the breadth comes from the generic layer, not from tool count.

## When to use this

Use this server when you want an MCP client to safely inspect or operate Autotask data without exposing hundreds of entity-specific tools to the model.

It is especially suited for:

- ticket lookup and triage
- company / contact search
- read-only Autotask assistants
- controlled ticket creation / update workflows
- containerized MCP deployments

## Features

- **Full API coverage via a generic layer** — `query-entity`, `get-entity`, `create-entity`, `update-entity`, `delete-entity` and `describe-entity-fields` work against any Autotask entity by name.
- **Convenience tools** for tickets, companies, contacts, projects/tasks and time entries with named, LLM-friendly parameters.
- **Automatic zone detection** — the correct Autotask data-center URL is discovered from your username; no need to know your zone.
- **AI-safe by design**
  - Read-only mode (`AUTOTASK_READ_ONLY=true`) physically de-registers every write tool.
  - Every mutating tool (`create-*`, `update-*`, `delete-*`) requires an explicit confirmation token.
  - Numeric arguments are validated — bad input is rejected, never sent to Autotask as `null`.
  - Secrets are redacted from all error output.
- **Resilient transport** — honors `429` rate-limit `Retry-After`, retries idempotent calls on transient `5xx` with backoff.
- **Two transports** — `stdio` (default, for desktop/CLI clients) and a multi-session, bearer-authenticated **HTTP** transport for remote/containerized use.
- **Tenant-safe by default** — a budget governor caps concurrency at Autotask's per-endpoint thread limit and stops short of exhausting the hourly request budget, which is shared by every integration on the database.

## Requirements

- Node.js >= 20
- An Autotask **API-only user** (Autotask → Admin → Resources/Users) with a username, secret, and an **integration code** (tracking identifier).

## Install

This fork is not published to npm. Build it from source:

```bash
git clone https://github.com/phoneware/autotask-mcp.git
cd autotask-mcp && npm ci && npm run build
```

## Quick start

Pass credentials as environment variables:

```bash
AUTOTASK_USERNAME=apiuser@example.com \
AUTOTASK_SECRET=your-secret \
AUTOTASK_INTEGRATION_CODE=your-integration-code \
node dist/index.js
```

> The Autotask **API User (API-only)** security level grants full system
> administrator access to Autotask data over REST, and the credential never
> expires. Give this server its own dedicated API user on a scoped custom
> security level. API users are free and unlimited.

### Claude Desktop / Claude Code (stdio)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "autotask": {
      "command": "node",
      "args": ["/absolute/path/to/autotask-mcp/dist/index.js"],
      "env": {
        "AUTOTASK_USERNAME": "apiuser@example.com",
        "AUTOTASK_SECRET": "your-secret",
        "AUTOTASK_INTEGRATION_CODE": "your-integration-code"
      }
    }
  }
}
```

### Connect to the hosted server (HTTP)

```bash
claude mcp add autotask --transport http https://mcp.autotask.phoneware.cloud/mcp
```

It runs the OAuth flow and signs you in with Google. claude.ai users add it
under Settings → Connectors → Add custom connector with the same URL.

## Run with Docker

Pre-built images are published to GitHub Container Registry on every release.

**stdio** (for a local MCP client that launches the container):

```bash
docker run --rm -i \
  -e AUTOTASK_USERNAME=apiuser@example.com \
  -e AUTOTASK_SECRET=your-secret \
  -e AUTOTASK_INTEGRATION_CODE=your-code \
  ghcr.io/phoneware/autotask-mcp
```

**HTTP** (remote / containerized):

```bash
docker run --rm -p 3000:3000 \
  -e AUTOTASK_TRANSPORT=http \
  -e AUTOTASK_HTTP_HOST=0.0.0.0 \
  -e AUTOTASK_BASE_URL=https://your.public.host \
  -e AUTOTASK_OAUTH_CLIENT_ID=... -e AUTOTASK_OAUTH_CLIENT_SECRET=... \
  -e AUTOTASK_OAUTH_ALLOWED_DOMAINS=example.com \
  -e AUTOTASK_USERNAME=apiuser@example.com \
  -e AUTOTASK_SECRET=your-secret \
  -e AUTOTASK_INTEGRATION_CODE=your-code \
  ghcr.io/phoneware/autotask-mcp
```

> The default HTTP bind host is `127.0.0.1`, except on Cloud Run / Knative (`K_SERVICE` set) where it is `0.0.0.0`. Inside any other container set `AUTOTASK_HTTP_HOST=0.0.0.0` for the published port to be reachable, and only behind your own network controls.

Or use `docker compose` (HTTP service with a `/health` healthcheck) — supply the credentials via a `.env` file:

```bash
docker compose up -d
```

## Configuration

| Variable                            | Required | Description                                                                                                                                    |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOTASK_USERNAME`                 | yes      | Autotask API user name                                                                                                                         |
| `AUTOTASK_SECRET`                   | yes      | Autotask API secret                                                                                                                            |
| `AUTOTASK_INTEGRATION_CODE`         | yes      | Integration code / API tracking identifier                                                                                                     |
| `AUTOTASK_API_URL`                  | no       | Pin the zone base URL and skip auto-detection (e.g. `https://webservices2.autotask.net/atservicesrest/`)                                       |
| `AUTOTASK_READ_ONLY`                | no       | `true` to disable all write tools                                                                                                              |
| `AUTOTASK_CLOSED_STATUS_IDS`        | no       | Ticket status codes treated as "closed" by `search-tickets openOnly` (default `5,16`)                                                          |
| `AUTOTASK_TRANSPORT`                | no       | `http` or `stdio`. Defaults to `stdio`, except on Cloud Run / Knative (`K_SERVICE` set) where it defaults to `http`                            |
| `AUTOTASK_HTTP_HOST`                | no       | HTTP bind host (default `127.0.0.1`, or `0.0.0.0` when `K_SERVICE` is set)                                                                     |
| `PORT`                              | no       | HTTP port (default `3000`)                                                                                                                     |
| `AUTOTASK_HTTP_ALLOWED_HOSTS`       | no       | Comma-separated `Host` allowlist (DNS-rebinding protection). Unset trusts the proxy                                                            |
| `AUTOTASK_HTTP_ALLOWED_ORIGINS`     | no       | Comma-separated browser `Origin` allowlist. **Unset denies every browser origin**                                                              |
| `AUTOTASK_RATE_LIMIT`               | no       | Requests per minute per client IP against `/mcp` (default `120`, `0` disables)                                                                 |
| `AUTOTASK_MAX_SESSIONS`             | no       | Concurrent MCP sessions before `/mcp` returns 503 (default `100`)                                                                              |
| `AUTOTASK_SESSION_TTL_MS`           | no       | Idle session lifetime (default `1800000`, 30 minutes)                                                                                          |
| `AUTOTASK_MAX_BODY_BYTES`           | no       | Max request body size (default `4194304`, 4 MB)                                                                                                |
| `AUTOTASK_THRESHOLD_STOP_PCT`       | no       | Refuse Autotask calls at this % of the tenant hourly budget (default `90`)                                                                     |
| `AUTOTASK_THRESHOLD_WARN_PCT`       | no       | Warn at this % (default `75`, where Autotask starts adding latency)                                                                            |
| `AUTOTASK_MAX_CONCURRENT`           | no       | Max in-flight calls per Autotask object endpoint (default `3`, Autotask's own thread limit)                                                    |
| `AUTOTASK_PERSISTENCE`              | no       | Where OAuth clients and tokens live: `firestore` or `memory`. Defaults to `firestore` on Cloud Run (`K_SERVICE` set), `memory` otherwise       |
| `AUTOTASK_OAUTH_REDIRECT_ALLOWLIST` | no       | Comma-separated non-loopback redirect URIs a client may use. Loopback is always allowed. Defaults to `https://claude.ai/api/mcp/auth_callback` |

### Who can do what

The Autotask REST API authenticates as a single API user, and that user's
security level applies to every call regardless of who asked for it.
`ImpersonationResourceId` changes _attribution_ on creates; it does not change
_permission_. Autotask therefore cannot enforce a signed-in person's own rights
for us, so this server enforces them itself.

Sign-in requires the Google email to resolve to **exactly one active Autotask
resource**. No match, only a deactivated record, more than one match, or an
API/service-account security level are each refused, because none of them
identify a single person we can legitimately act as. Capabilities then come
from that resource's Autotask `userType`:

| Autotask security level                      | read            | create | update | delete |
| -------------------------------------------- | --------------- | ------ | ------ | ------ |
| System Administrator, Full Access            | yes             | yes    | yes    | yes    |
| Manager, Project Manager                     | yes             | yes    | yes    | no     |
| Service Desk User, Team Member, Sales        | yes             | yes    | no     | no     |
| Anything else, including unrecognised levels | yes             | no     | no     | no     |
| API User                                     | sign-in refused |

Autotask does not expose the permission matrix behind its security levels over
REST, so this is a deliberate approximation of it rather than a mirror. The
mapping lives in `src/auth/capabilities.ts` and is the single place to change
it. Rights are re-derived on every token refresh, so a change in Autotask takes
effect without waiting for the session to expire.

Enforcement happens twice: tools a person may not use are never registered for
their session, and the call is checked again at runtime. Ask `whoami` to see
which Autotask person a session is acting as and what it is permitted to do.

> Autotask supports impersonation on **creates only**, so updates and deletes
> execute as the API user and cannot carry a person's name. That is an Autotask
> limit. What this layer controls is who can reach those operations at all.

### Where sign-ins may be returned to

Dynamic client registration (`/register`) is open and unauthenticated, because
MCP clients require it to be. A `client_id` therefore proves nothing about who
is asking, and is not treated as a secret: a client presenting one this server
does not have on file is adopted rather than refused, which is what stops a
client being permanently stuck holding a registration the server has lost.

The boundary that does matter is where the authorization code is delivered,
since that is the step where a genuine sign-in becomes someone else's access.
Codes are only ever returned to:

- **loopback** (`localhost`, `127.0.0.1`, `[::1]`) on any port, which is the
  native-app pattern in RFC 8252 and what Claude Code uses. The port is chosen
  per attempt, so it cannot be pre-registered.
- anything named in `AUTOTASK_OAUTH_REDIRECT_ALLOWLIST`, which defaults to the
  hosted connector callback `https://claude.ai/api/mcp/auth_callback`.

Everything else is refused at both `/register` and `/authorize`: lookalike
hosts, URLs carrying embedded credentials, plaintext off-machine, and non-HTTP
schemes. Reaching that refusal page means something sent you a link pointing at
a destination this server will not deliver to, so it tells you not to sign in.

### OAuth persistence

An MCP client registers once, caches the `client_id` it is issued, and presents
it on every later `/authorize`. If the store that minted it is gone, the client
is told `invalid_client` and has no way to know it should register again. So on
any long-lived deployment, registrations must outlive the process: leave
`AUTOTASK_PERSISTENCE` alone on Cloud Run, where it resolves to `firestore` and
uses the `autotask_mcp_oauth_clients` and `autotask_mcp_oauth_tokens`
collections in the project's default Firestore database. `memory` is for local
runs and tests, where a restart is expected. `/health` reports which is live.

## Tools

Which of these a session actually gets depends on the signed-in person's
Autotask rights; see [Who can do what](#who-can-do-what).

### Identity

| Tool     | Description                                                                          |
| -------- | ------------------------------------------------------------------------------------ |
| `whoami` | Which Autotask person this session acts as, their security level, and what it may do |

### Generic (any entity)

| Tool                        | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `list-known-entities`       | List commonly used entity names                      |
| `describe-entity-fields`    | Field names, types and picklist values for an entity |
| `query-entity`              | Query any entity with the Autotask filter syntax     |
| `count-entity`              | Count matching records without fetching them         |
| `get-next-page`             | Follow a `pageDetails.nextPageUrl` past the 500 cap  |
| `get-entity`                | Fetch a record by id                                 |
| `create-entity`             | Create a record (confirm token required)             |
| `update-entity`             | Update a record (confirm token required)             |
| `delete-entity`             | Delete a record (confirm token required)             |
| `get-threshold-information` | Current API usage vs. the rate threshold             |
| `get-version`               | Autotask REST API version (connectivity check)       |

`query-entity`, `count-entity`, `get-entity` and `create-entity` accept optional `parentEntity` + `parentId` to reach parent-scoped child collections such as `Tickets/{id}/Notes` or `Companies/{id}/Attachments`.

### Convenience

- **Tickets**: `search-tickets`, `get-ticket`, `create-ticket`, `update-ticket`, `create-ticket-note`
- **Companies**: `search-companies`, `get-company`, `create-company`, `update-company`
- **Contacts**: `search-contacts`, `get-contact`, `create-contact`, `update-contact`
- **Projects & Tasks**: `search-projects`, `get-project`, `search-tasks`, `get-task`
- **Time entries**: `search-time-entries`, `create-time-entry`

> Status, priority, queue and similar values are numeric picklist codes. Use `describe-entity-fields` to discover the valid codes for your Autotask instance.

Every `search-*` tool echoes the filter it actually applied and sets `unfiltered: true` when you supplied no criteria, so an arbitrary first page never reads like a search result. Autotask caps one query at 500 records; pass the response's `pageDetails.nextPageUrl` to `get-next-page` to read further.

## Resources

Read-only `autotask://` resources are also exposed: `autotask://threshold`, `autotask://companies`, `autotask://tickets`, `autotask://contacts`, and templated `autotask://{companies,tickets,contacts}/{id}`.

## Tool safety

**Read-only tools** (19) — never mutate data, always available:

- **Generic**: `list-known-entities`, `describe-entity-fields`, `query-entity`, `count-entity`, `get-next-page`, `get-entity`, `get-threshold-information`, `get-version`
- **Tickets**: `search-tickets`, `get-ticket`
- **Companies**: `search-companies`, `get-company`
- **Contacts**: `search-contacts`, `get-contact`
- **Projects & Tasks**: `search-projects`, `get-project`, `search-tasks`, `get-task`
- **Time entries**: `search-time-entries`

**Mutating tools** (11) — require a matching `confirm` token, and are not registered at all in read-only mode:

| Tool                 | Required `confirm`   |
| -------------------- | -------------------- |
| `create-entity`      | `CREATE_ENTITY`      |
| `update-entity`      | `UPDATE_ENTITY`      |
| `delete-entity`      | `DELETE_ENTITY`      |
| `create-ticket`      | `CREATE_TICKET`      |
| `update-ticket`      | `UPDATE_TICKET`      |
| `create-ticket-note` | `CREATE_TICKET_NOTE` |
| `create-company`     | `CREATE_COMPANY`     |
| `update-company`     | `UPDATE_COMPANY`     |
| `create-contact`     | `CREATE_CONTACT`     |
| `update-contact`     | `UPDATE_CONTACT`     |
| `create-time-entry`  | `CREATE_TIME_ENTRY`  |

## Examples

**Query a ticket by number** (`query-entity`):

```json
{
  "entity": "Tickets",
  "query": "{\"filter\":[{\"op\":\"eq\",\"field\":\"ticketNumber\",\"value\":\"T20240101.0001\"}],\"MaxRecords\":1}"
}
```

**Create a ticket** (`create-ticket`) — note the required `confirm` token:

```json
{
  "title": "VPN issue",
  "companyID": "123",
  "description": "User cannot connect to VPN",
  "confirm": "CREATE_TICKET"
}
```

**Find open, unassigned tickets** (`search-tickets`) — the reliable way to do triage. Use the `openOnly` + `unassigned` flags instead of enumerating statuses, so no open status is ever missed:

```json
{
  "openOnly": "true",
  "unassigned": "true",
  "maxRecords": "500"
}
```

This builds a single server-side filter — `assignedResourceID notExist` plus a closed-status denylist (`status != 5`, `status != 16` by default) — rather than a fragile per-status allowlist.

**Run read-only** (no write tools registered):

```bash
AUTOTASK_READ_ONLY=true node dist/index.js
```

**HTTP transport**:

```bash
# Liveness/readiness — no auth, safe for orchestrators
curl http://127.0.0.1:3000/health
# {"ok":true,"mode":"full","uptimeSeconds":41,"sessions":2,"autotaskUsagePct":12.4}

# MCP endpoint — requires a bearer from the Google sign-in flow
curl -i -X POST http://127.0.0.1:3000/mcp   # 401 + WWW-Authenticate: Bearer resource_metadata=...
```

## HTTP transport

Set `AUTOTASK_TRANSPORT=http` to serve MCP Streamable HTTP instead of stdio.

| Route         | Auth   | Purpose                                          |
| ------------- | ------ | ------------------------------------------------ |
| `POST /mcp`   | bearer | `initialize` opens a session; all other JSON-RPC |
| `GET /mcp`    | bearer | SSE stream for an established session            |
| `DELETE /mcp` | bearer | Terminate a session                              |
| `GET /health` | none   | Liveness, session count, current Autotask usage  |

**One session per client.** Each `initialize` mints its own MCP server and
transport, keyed by the `Mcp-Session-Id` the transport assigns. Sessions are
held in memory, reaped after `AUTOTASK_SESSION_TTL_MS` idle, capped at
`AUTOTASK_MAX_SESSIONS`, and drained on `SIGTERM`. Because they are in-memory,
run a single always-warm instance rather than scaling out (see
[DEPLOY.md](DEPLOY.md)).

**Origins are denied by default.** MCP clients that matter here (Claude Code,
server-side connectors) send no `Origin` header. So an unset
`AUTOTASK_HTTP_ALLOWED_ORIGINS` rejects every request that carries one, which
closes DNS rebinding without a separate switch. Set it only for a real browser
client; CORS headers, including `Access-Control-Expose-Headers: Mcp-Session-Id`,
are emitted only for an allowlisted origin.

**It starts even when unconfigured.** Missing Autotask credentials or missing
Google sign-in config do not stop the process. It boots, `/health` returns 200
with `configured: false` and a `missingConfig` list, and `/mcp` refuses every
request with 503. Exiting instead would crash-loop a container before anything
could report the reason, and would make "deploy, then configure" impossible.
Since `/mcp` is closed in that state, starting up cannot expose the tool
surface.

## Who is connecting, and why it matters

Two ways in, and they are **not** equivalent:

|                            | Google sign-in                                | Static bearer               |
| -------------------------- | --------------------------------------------- | --------------------------- | ----------------------- | ---- |
| Configured by              | `AUTOTASK_OAUTH_*` + `AUTOTASK_BASE_URL`      | Identity                    | a verified Google email | none |
| Writes attributed to       | **the person**, via `ImpersonationResourceId` | the API user                |
| claude.ai custom connector | works                                         | does not connect            |
| Intended for               | people                                        | scripts and machine callers |

Either may be configured, or both. With neither, `/mcp` refuses every request.

Autotask has no OAuth, no SSO and no per-user credentials, so Google is **not**
standing in for Autotask authentication. Its only job is to establish who is
connecting. That email is matched against Autotask `Resources`, and the
resulting resource id rides out on the `ImpersonationResourceId` header so a
ticket note reads as "Dave" rather than "the API user".

Autotask supports impersonation on **create** operations only, and only for
tickets, ticket and task notes, attachments, project notes and status, and
service calls. Sending the header where it is unsupported can fail a call that
would otherwise work, so it is restricted to entity creates. Updates and
queries are unaffected, and someone with no matching Autotask resource still
signs in fine, their writes simply fall back to the API user.

The flow: an MCP client discovers `/.well-known/oauth-protected-resource/mcp`,
registers itself via DCR, sends the browser to `/authorize`, which redirects to
Google. `/callback` verifies the id_token, enforces the domain allowlist,
resolves the Autotask resource, and hands back a code the client exchanges at
`/token`.

## Autotask API budget governor

Autotask enforces two limits that are **tenant-wide, not per-integration**:

- **10,000 requests per hour**, counted per _database_ across every integration.
  Autotask adds latency at 50% (+0.5s per request) and 75% (+1s), then suspends
  API access for the whole tenant.
- **3 concurrent requests** per object endpoint per tracking identifier, 429 on
  breach.

An agent loop against this server therefore degrades, and can suspend, every
other Autotask integration you run. So every call passes a governor that:

- caps in-flight requests per object endpoint at `AUTOTASK_MAX_CONCURRENT`
  (default 3, Autotask's own thread limit),
- refuses calls at `AUTOTASK_THRESHOLD_STOP_PCT` of the hourly budget (default
  90%) with an actionable error,
- warns once per window past `AUTOTASK_THRESHOLD_WARN_PCT` (default 75%),
- **fails open** if the `ThresholdInformation` probe itself fails, so a flaky
  reading cannot take the tool surface down.

The probe costs one call per minute and its reading is surfaced on `/health`.

## Security model

- **Read-only mode**: with `AUTOTASK_READ_ONLY=true`, all write tools are never registered (11 of 31 tools) — a misconfigured agent cannot mutate data.
- **Per-person authorization** (HTTP transport): what each signed-in person may do is derived from their Autotask security level, and tools beyond it are never registered for their session. See below.
- **Confirmation tokens**: _every_ mutating tool — generic and convenience alike (`create-*`, `update-*`, `delete-*`) — requires a `confirm` argument equal to the upper-snake-cased tool name (e.g. `CREATE_TICKET`, `DELETE_ENTITY`) before it executes. This blocks accidental single-call writes to production data.
- **Strict argument validation**: every tool rejects an argument it does not declare, naming the offending key, so a wrong parameter name can never be silently dropped and turned into an unfiltered "fetch everything" query. Numeric arguments are validated too; non-numeric input is rejected with a clear error instead of being sent to Autotask as `null`.
- **Secret redaction**: credentials and tokens are stripped from error messages before they reach the model or logs.
- **HTTP auth**: `/mcp` requires a bearer issued by this server's own Google sign-in flow, and returns `401` with a `WWW-Authenticate` challenge pointing at the OAuth metadata otherwise. There is no shared static token. `/health` is intentionally unauthenticated, for container/orchestrator health checks only. Default bind host is `127.0.0.1`; expose beyond localhost (e.g. `0.0.0.0` in Docker) only behind your own network controls.
- **Browser origins denied by default**: an unset `AUTOTASK_HTTP_ALLOWED_ORIGINS` rejects any request carrying an `Origin` header, so a malicious page cannot drive the server via DNS rebinding. `AUTOTASK_HTTP_ALLOWED_HOSTS` adds `Host` pinning on top.
- **Abuse limits**: per-IP rate limiting on `/mcp` (`AUTOTASK_RATE_LIMIT`), a request body cap (`AUTOTASK_MAX_BODY_BYTES`), a session cap (`AUTOTASK_MAX_SESSIONS`) and idle session reaping (`AUTOTASK_SESSION_TTL_MS`).
- **Tenant blast-radius guard**: the budget governor stops calls before the shared Autotask hourly budget is exhausted, which would otherwise suspend API access for every integration on the database, not just this one.
- **Attributed writes**: every session carries the signed-in person's Autotask resource id, sent as `ImpersonationResourceId` on creates, so records are attributed to them rather than to the shared API user.

## Development

```bash
npm install
npm run build        # compile TypeScript to dist/
npm test             # run the vitest suite
npm run lint         # eslint
npm run format       # prettier --write
npm run inspect      # launch the MCP Inspector against the built server
```

## License

MIT © Vitalii Morgunov
