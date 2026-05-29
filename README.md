# Autotask MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Kaseya Autotask PSA**. It lets MCP-compatible AI clients (Claude Desktop, Claude Code, and others) read and write Autotask data through a small, AI-safe tool surface.

Instead of hand-coding one tool per Autotask entity, this server exposes a **generic entity layer** (query / get / create / update / delete against any of Autotask's 180+ REST entities) plus **convenience tools** for the entities you touch most: tickets, companies, contacts, projects, tasks and time entries.

## Features

- **Full API coverage via a generic layer** — `query-entity`, `get-entity`, `create-entity`, `update-entity`, `delete-entity` and `describe-entity-fields` work against any Autotask entity by name.
- **Convenience tools** for tickets, companies, contacts, projects/tasks and time entries with named, LLM-friendly parameters.
- **Automatic zone detection** — the correct Autotask data-center URL is discovered from your username; no need to know your zone.
- **AI-safe by design**
  - Read-only mode (`AUTOTASK_READ_ONLY=true`) physically de-registers every write tool.
  - Destructive generic operations (`create-entity`, `update-entity`, `delete-entity`) require an explicit confirmation token.
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

## Configuration

| Variable                    | Required  | Description                                                                                              |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `AUTOTASK_USERNAME`         | yes       | Autotask API user name                                                                                   |
| `AUTOTASK_SECRET`           | yes       | Autotask API secret                                                                                      |
| `AUTOTASK_INTEGRATION_CODE` | yes       | Integration code / API tracking identifier                                                               |
| `AUTOTASK_API_URL`          | no        | Pin the zone base URL and skip auto-detection (e.g. `https://webservices2.autotask.net/atservicesrest/`) |
| `AUTOTASK_READ_ONLY`        | no        | `true` to disable all write tools                                                                        |
| `AUTOTASK_TRANSPORT`        | no        | `http` to use the HTTP transport (default: `stdio`)                                                      |
| `AUTOTASK_HTTP_TOKEN`       | http only | Bearer token (>= 16 chars) required to call `/mcp`                                                       |
| `AUTOTASK_HTTP_HOST`        | no        | HTTP bind host (default `127.0.0.1`)                                                                     |
| `PORT`                      | no        | HTTP port (default `3000`)                                                                               |

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

Read-only `autotask://` resources are also exposed: `autotask://threshold`, `autotask://companies`, `autotask://tickets`, and templated `autotask://{companies,tickets,contacts}/{id}`.

## Security model

- **Read-only mode**: with `AUTOTASK_READ_ONLY=true`, write tools are never registered — a misconfigured agent cannot mutate data.
- **Confirmation tokens**: the generic write tools require a `confirm` argument equal to the upper-snake-cased tool name (e.g. `DELETE_ENTITY`) before they execute.
- **Secret redaction**: credentials and tokens are stripped from error messages before they reach the model or logs.
- **HTTP auth**: the HTTP transport refuses to start without a `>= 16` char bearer token and rejects unauthenticated `/mcp` requests with `401`.

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
