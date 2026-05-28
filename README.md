# buildtools-mcp

MCP server for BuildTools (third-party construction PM SaaS at `moss.buildtools.app`). Exposes BuildTools data + operations as tools/resources to Claude Desktop and other MCP-aware agents.

**Status:** Phase 1-7 complete. Production-ready.

## What this is

This repo is a **TypeScript MCP server** that wraps a typed BuildTools client (rewritten from `desrocpr/buildtools`'s `api-client.js`) and exposes its operations as MCP tools, with a two-step confirmation handshake guarding every mutation.

```
Claude Desktop  ─stdio─►  buildtools-mcp  ─HTTPS─►  moss.buildtools.app
       │
Hosted agent    ─HTTP/SSE + bearer─►  buildtools-mcp  ─HTTPS─►  moss.buildtools.app
```

## Phases (per Linear project plan)

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: TS scaffold + stdio transport | shipped |
| 2 | Typed BuildTools client + auth + tests | shipped |
| 3 | Read tools (projects, financials, customers, attachments) | shipped |
| 4 | Confirmation framework for mutations | shipped |
| 5 | Write tools (project / CO / PO / task / RFI / invoice / FS / service / selection) | shipped |
| 6 | HTTP/SSE transport with bearer-token auth | shipped |
| 7 | Polish — install guide + tool reference + architecture doc | shipped |

## Quick start

```bash
git clone https://github.com/desrocpr/buildtools-mcp.git
cd buildtools-mcp
npm install
npm run build
```

Then wire it into Claude Desktop — see [docs/INSTALL.md](./docs/INSTALL.md) for the full walkthrough, including the Claude Desktop config snippet, Doppler integration, the HTTP/SSE transport, and troubleshooting.

## Tool inventory

The server exposes **40 tools** across the following categories. See [docs/TOOLS.md](./docs/TOOLS.md) for the per-tool reference (description, inputs, sample prompt + output, notes).

- **Health** — `ping` (1)
- **Session** — `set_session_credentials` (1, HTTP transport only)
- **Projects** — `list_projects`, `get_project`, `search_projects` (3)
- **Financial reads** — `list_change_orders`, `get_change_order`, `find_unbilled_change_orders`, `get_financial_statement`, `list_financial_statements` (5)
- **Customers** — `list_customers`, `get_customer` (2)
- **Attachments** — `list_project_attachments` (1)
- **Tasks** — `list_tasks`, `search_tasks` (2)
- **Purchase orders** — `list_purchase_orders`, `search_purchase_orders` (2)
- **Work tracking** — `list_certificates`, `list_daily_logs`, `list_weekly_reports`, `list_work_days` (4)
- **Operations** — `list_rfis`, `list_services`, `list_users`, `search_users` (4)
- **Selections** — `list_selections`, `get_selection`, `list_allowances`, `list_selection_categories` (4)
- **Mutations** (require confirmation) — `create_project`, `create_change_order`, `create_purchase_order`, `create_task`, `create_rfi`, `create_invoice`, `create_financial_statement`, `delete_financial_statement`, `create_service`, `create_selection`, `delete_selection` (11)

## Architecture

For the component map, mutation/confirmation flow, and a "where to find what" pointer to `src/client/`, `src/tools/`, `src/transports/`, and `src/confirm/`, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).
