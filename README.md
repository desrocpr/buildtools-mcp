# buildtools-mcp

MCP server for BuildTools (third-party construction PM SaaS at `moss.buildtools.app`). Exposes BuildTools data + operations as tools/resources to Claude Desktop and other MCP-aware agents.

**Status:** Phase 1-8 complete and live in production at `https://buildtools-mcp.mossbuildinganddesign.com`. Read paths now use a MySQL read-replica fast path (`MossDb` adapter) — portfolio rollups that took ~4 minutes via HTTP now return in 7-13 seconds. Writes continue to use authenticated HTTP. See [STATE.md](./STATE.md) for the current deployment + speedup table.

## What this is

This repo is a **TypeScript MCP server** that wraps a typed BuildTools client (rewritten from `desrocpr/buildtools`'s `api-client.js`) and exposes its operations as MCP tools, with a two-step confirmation handshake guarding every mutation.

```
Claude Desktop  ─stdio─►  buildtools-mcp  ─HTTPS─►  moss.buildtools.app
       │                       │
Hosted agent ─HTTP/SSE+bearer─►│
                               │  reads (when MYSQL_* env set)
                               └────► MySQL replica (moss-online-replica)
                               │  writes (always)
                               └────► HTTPS to moss.buildtools.app
```

**Read path** (Phase 8, PRs #82-#85): every read tool checks `api.db` first and queries the read replica directly when available — much faster than the HTTP per-record datatable parsing. When `MYSQL_*` is absent (local dev, tests), reads fall back to HTTP automatically.

**Write path**: always goes through the authenticated HTTPS BT API with the calling user's credentials. No writes ever touch the DB.

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
| 8 | Analytics tools (briefs, forecasts, uncollected invoices) + DB fast path | shipped (PR #66-#85) |

## Quick start

```bash
git clone https://github.com/desrocpr/buildtools-mcp.git
cd buildtools-mcp
npm install
npm run build
```

Then wire it into Claude Desktop — see [docs/INSTALL.md](./docs/INSTALL.md) for the full walkthrough, including the Claude Desktop config snippet, Doppler integration, the HTTP/SSE transport, and troubleshooting.

## Tool inventory

The server exposes ~45 tools across the following categories. See [docs/TOOLS.md](./docs/TOOLS.md) for the per-tool reference (description, inputs, sample prompt + output, notes).

- **Health** — `ping`, `refresh_tools` (2)
- **Session** — `set_session_credentials` (1, HTTP transport only)
- **Projects** — `list_projects`, `get_project` (2; `search_projects` consolidated into `list_projects` via `query` arg in PR #71)
- **Financial reads** — `list_change_orders`, `get_change_order`, `find_unbilled_change_orders`, `get_financial_statement`, `list_financial_statements` (5; `list_financial_statements` exposes `sent_date` for AR/uncollected workflows)
- **Customers** — `list_customers`, `get_customer` (2)
- **Companies** — `search_companies`, `get_company` (2)
- **Attachments** — `list_project_attachments`, `download_attachment`, `upload_attachment` (3)
- **Tasks** — `list_tasks` (1; `query` arg supports search)
- **Purchase orders** — `list_purchase_orders`, `get_purchase_order` (2)
- **Work tracking** — `list_certificates`, `list_daily_logs`, `list_weekly_reports`, `list_work_days` (4)
- **Operations** — `list_rfis`, `list_services`, `list_users` (3)
- **Selections** — `list_selections`, `get_selection`, `list_allowances`, `list_selection_categories`, `export_selections` (5)
- **Budget** — `list_budget` (1)
- **Analytics (Phase 8)** — `project_status_brief`, `cash_flow_forecast`, `uncollected_invoices` (3)
- **Mutations** (require confirmation) — `create_project`, `create_change_order`, `update_purchase_order`, `create_purchase_order`, `transition_purchase_order_status`, `bulk_transition_purchase_orders`, `apply_vendor_quote`, `create_draw_request`, `create_task`, `create_rfi`, `create_invoice`, `create_financial_statement`, `delete_financial_statement`, `create_service`, `create_selection`, `delete_selection`, `create_budget_item`, `update_budget_item`, `delete_budget_item` (19)

## Architecture

For the component map, mutation/confirmation flow, and a "where to find what" pointer to `src/client/`, `src/tools/`, `src/transports/`, and `src/confirm/`, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).
