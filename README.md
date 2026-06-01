# Autotask MCP Server

[![Release](https://github.com/veeemlab/autotask-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/veeemlab/autotask-mcp/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@veeemlab/autotask-mcp?color=blue&label=npm)](https://www.npmjs.com/package/@veeemlab/autotask-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@veeemlab/autotask-mcp?color=blue)](https://www.npmjs.com/package/@veeemlab/autotask-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker Publish](https://github.com/veeemlab/autotask-mcp/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/veeemlab/autotask-mcp/pkgs/container/autotask-mcp)

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
- **Two transports** — `stdio` (default, for desktop/CLI clients) and an optional authenticated **HTTP** transport for remote/containerized use.

## Requirements

- Node.js >= 20
- An Autotask **API-only user** (Autotask → Admin → Resources/Users) with a username, secret, and an **integration code** (tracking identifier).

## Install

### 1. Run via `npx` (recommended)

No install needed — `npx` fetches the latest published version every time:

```bash
npx -y @veeemlab/autotask-mcp
```

### 2. Run from GitHub (bleeding edge)

```bash
npx -y github:veeemlab/autotask-mcp
```

### 3. Install globally

```bash
npm install -g @veeemlab/autotask-mcp
autotask-mcp
```

## Quick start

Pass credentials as environment variables:

```bash
AUTOTASK_USERNAME=apiuser@example.com \
AUTOTASK_SECRET=your-secret \
AUTOTASK_INTEGRATION_CODE=your-integration-code \
npx -y @veeemlab/autotask-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "autotask": {
      "command": "npx",
      "args": ["-y", "@veeemlab/autotask-mcp"],
      "env": {
        "AUTOTASK_USERNAME": "apiuser@example.com",
        "AUTOTASK_SECRET": "your-secret",
        "AUTOTASK_INTEGRATION_CODE": "your-integration-code"
      }
    }
  }
}
```

## Run with Docker

Pre-built images are published to GitHub Container Registry on every release.

**stdio** (for a local MCP client that launches the container):

```bash
docker run --rm -i \
  -e AUTOTASK_USERNAME=apiuser@example.com \
  -e AUTOTASK_SECRET=your-secret \
  -e AUTOTASK_INTEGRATION_CODE=your-code \
  ghcr.io/veeemlab/autotask-mcp
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
  ghcr.io/veeemlab/autotask-mcp
```

> The default HTTP bind host is `127.0.0.1`. Inside a container you must set `AUTOTASK_HTTP_HOST=0.0.0.0` for the published port to be reachable — only do so behind your own network controls, and always with a strong `AUTOTASK_HTTP_TOKEN`.

Or use `docker compose` (HTTP service with a `/health` healthcheck) — supply the credentials via a `.env` file:

```bash
docker compose up -d
```

## Configuration

| Variable                     | Required  | Description                                                                                              |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `AUTOTASK_USERNAME`          | yes       | Autotask API user name                                                                                   |
| `AUTOTASK_SECRET`            | yes       | Autotask API secret                                                                                      |
| `AUTOTASK_INTEGRATION_CODE`  | yes       | Integration code / API tracking identifier                                                               |
| `AUTOTASK_API_URL`           | no        | Pin the zone base URL and skip auto-detection (e.g. `https://webservices2.autotask.net/atservicesrest/`) |
| `AUTOTASK_READ_ONLY`         | no        | `true` to disable all write tools                                                                        |
| `AUTOTASK_CLOSED_STATUS_IDS` | no        | Comma-separated ticket status codes treated as "closed" by `search-tickets openOnly` (default `5,16`)    |
| `AUTOTASK_TRANSPORT`         | no        | `http` to use the HTTP transport (default: `stdio`)                                                      |
| `AUTOTASK_HTTP_TOKEN`        | http only | Bearer token (>= 16 chars) required to call `/mcp`                                                       |
| `AUTOTASK_HTTP_HOST`         | no        | HTTP bind host (default `127.0.0.1`)                                                                     |
| `PORT`                       | no        | HTTP port (default `3000`)                                                                               |

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
AUTOTASK_READ_ONLY=true npx -y @veeemlab/autotask-mcp
```

**HTTP transport** — unauthenticated health check and bearer-gated MCP endpoint:

```bash
# Liveness/readiness — no auth, safe for orchestrators
curl http://127.0.0.1:3000/health

# MCP endpoint — requires the bearer token
curl -H "Authorization: Bearer $AUTOTASK_HTTP_TOKEN" http://127.0.0.1:3000/mcp
```

## Security model

- **Read-only mode**: with `AUTOTASK_READ_ONLY=true`, all write tools are never registered (11 of 29 tools) — a misconfigured agent cannot mutate data.
- **Confirmation tokens**: _every_ mutating tool — generic and convenience alike (`create-*`, `update-*`, `delete-*`) — requires a `confirm` argument equal to the upper-snake-cased tool name (e.g. `CREATE_TICKET`, `DELETE_ENTITY`) before it executes. This blocks accidental single-call writes to production data.
- **Strict argument validation**: numeric tool arguments are validated; non-numeric input is rejected with a clear error instead of being sent to Autotask as `null`.
- **Secret redaction**: credentials and tokens are stripped from error messages before they reach the model or logs.
- **HTTP auth**: the HTTP transport refuses to start without a `>= 16` char bearer token. `/mcp` requires `Authorization: Bearer <AUTOTASK_HTTP_TOKEN>` (constant-time compared) and returns `401` otherwise. `/health` is intentionally unauthenticated, for container/orchestrator health checks only. Default bind host is `127.0.0.1`; expose beyond localhost (e.g. `0.0.0.0` in Docker) only behind your own network controls.

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
