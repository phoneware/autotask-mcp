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
claude mcp add autotask --transport http \
  https://mcp.autotask.phoneware.cloud/mcp \
  --header "Authorization: Bearer <AUTOTASK_HTTP_TOKEN>"
```

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
  -e AUTOTASK_HTTP_TOKEN=change-this-long-token \
  -e AUTOTASK_HTTP_HOST=0.0.0.0 \
  -e AUTOTASK_USERNAME=apiuser@example.com \
  -e AUTOTASK_SECRET=your-secret \
  -e AUTOTASK_INTEGRATION_CODE=your-code \
  ghcr.io/phoneware/autotask-mcp
```

> The default HTTP bind host is `127.0.0.1`. Inside a container you must set `AUTOTASK_HTTP_HOST=0.0.0.0` for the published port to be reachable — only do so behind your own network controls, and always with a strong `AUTOTASK_HTTP_TOKEN`.

Or use `docker compose` (HTTP service with a `/health` healthcheck) — supply the credentials via a `.env` file:

```bash
docker compose up -d
```

## Configuration

| Variable                        | Required  | Description                                                                                              |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `AUTOTASK_USERNAME`             | yes       | Autotask API user name                                                                                   |
| `AUTOTASK_SECRET`               | yes       | Autotask API secret                                                                                      |
| `AUTOTASK_INTEGRATION_CODE`     | yes       | Integration code / API tracking identifier                                                               |
| `AUTOTASK_API_URL`              | no        | Pin the zone base URL and skip auto-detection (e.g. `https://webservices2.autotask.net/atservicesrest/`) |
| `AUTOTASK_READ_ONLY`            | no        | `true` to disable all write tools                                                                        |
| `AUTOTASK_CLOSED_STATUS_IDS`    | no        | Ticket status codes treated as "closed" by `search-tickets openOnly` (default `5,16`)                    |
| `AUTOTASK_TRANSPORT`            | no        | `http` to use the HTTP transport (default: `stdio`)                                                      |
| `AUTOTASK_HTTP_TOKEN`           | http only | Bearer token (>= 16 chars) required to call `/mcp`                                                       |
| `AUTOTASK_HTTP_HOST`            | no        | HTTP bind host (default `127.0.0.1`; containers need `0.0.0.0`)                                          |
| `PORT`                          | no        | HTTP port (default `3000`)                                                                               |
| `AUTOTASK_HTTP_ALLOWED_HOSTS`   | no        | Comma-separated `Host` allowlist (DNS-rebinding protection). Unset trusts the proxy                      |
| `AUTOTASK_HTTP_ALLOWED_ORIGINS` | no        | Comma-separated browser `Origin` allowlist. **Unset denies every browser origin**                        |
| `AUTOTASK_RATE_LIMIT`           | no        | Requests per minute per client IP against `/mcp` (default `120`, `0` disables)                           |
| `AUTOTASK_MAX_SESSIONS`         | no        | Concurrent MCP sessions before `/mcp` returns 503 (default `100`)                                        |
| `AUTOTASK_SESSION_TTL_MS`       | no        | Idle session lifetime (default `1800000`, 30 minutes)                                                    |
| `AUTOTASK_MAX_BODY_BYTES`       | no        | Max request body size (default `4194304`, 4 MB)                                                          |
| `AUTOTASK_THRESHOLD_STOP_PCT`   | no        | Refuse Autotask calls at this % of the tenant hourly budget (default `90`)                               |
| `AUTOTASK_THRESHOLD_WARN_PCT`   | no        | Warn at this % (default `75`, where Autotask starts adding latency)                                      |
| `AUTOTASK_MAX_CONCURRENT`       | no        | Max in-flight calls per Autotask object endpoint (default `3`, Autotask's own thread limit)              |

## Tools

### Generic (any entity)

| Tool                        | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `list-known-entities`       | List commonly used entity names                      |
| `describe-entity-fields`    | Field names, types and picklist values for an entity |
| `query-entity`              | Query any entity with the Autotask filter syntax     |
| `count-entity`              | Count matching records without fetching them         |
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

## Resources

Read-only `autotask://` resources are also exposed: `autotask://threshold`, `autotask://companies`, `autotask://tickets`, `autotask://contacts`, and templated `autotask://{companies,tickets,contacts}/{id}`.

## Tool safety

**Read-only tools** (18) — never mutate data, always available:

- **Generic**: `list-known-entities`, `describe-entity-fields`, `query-entity`, `count-entity`, `get-entity`, `get-threshold-information`, `get-version`
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

# MCP endpoint — requires the bearer token
curl -H "Authorization: Bearer $AUTOTASK_HTTP_TOKEN" http://127.0.0.1:3000/mcp
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

**No OAuth.** Auth is the shared bearer token. Autotask itself has no OAuth, no
SSO and no per-user credentials, so there is no user identity to bind a session
to, and **every write is attributed to the API user rather than to the person
who asked for it**. A claude.ai custom connector performs OAuth discovery and
will not connect to this server as-is.

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

- **Read-only mode**: with `AUTOTASK_READ_ONLY=true`, all write tools are never registered (11 of 29 tools) — a misconfigured agent cannot mutate data.
- **Confirmation tokens**: _every_ mutating tool — generic and convenience alike (`create-*`, `update-*`, `delete-*`) — requires a `confirm` argument equal to the upper-snake-cased tool name (e.g. `CREATE_TICKET`, `DELETE_ENTITY`) before it executes. This blocks accidental single-call writes to production data.
- **Strict argument validation**: numeric tool arguments are validated; non-numeric input is rejected with a clear error instead of being sent to Autotask as `null`.
- **Secret redaction**: credentials and tokens are stripped from error messages before they reach the model or logs.
- **HTTP auth**: the HTTP transport refuses to start without a `>= 16` char bearer token. `/mcp` requires `Authorization: Bearer <AUTOTASK_HTTP_TOKEN>` (constant-time compared) and returns `401` otherwise. `/health` is intentionally unauthenticated, for container/orchestrator health checks only. Default bind host is `127.0.0.1`; expose beyond localhost (e.g. `0.0.0.0` in Docker) only behind your own network controls.
- **Browser origins denied by default**: an unset `AUTOTASK_HTTP_ALLOWED_ORIGINS` rejects any request carrying an `Origin` header, so a malicious page cannot drive the server via DNS rebinding. `AUTOTASK_HTTP_ALLOWED_HOSTS` adds `Host` pinning on top.
- **Abuse limits**: per-IP rate limiting on `/mcp` (`AUTOTASK_RATE_LIMIT`), a request body cap (`AUTOTASK_MAX_BODY_BYTES`), a session cap (`AUTOTASK_MAX_SESSIONS`) and idle session reaping (`AUTOTASK_SESSION_TTL_MS`).
- **Tenant blast-radius guard**: the budget governor stops calls before the shared Autotask hourly budget is exhausted, which would otherwise suspend API access for every integration on the database, not just this one.
- **No user attribution yet**: auth is a single shared token, so every write lands as the API user. Autotask offers no OAuth or per-user credentials; `ImpersonationResourceId` is the path to real attribution once the server has a user identity to bind.

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
