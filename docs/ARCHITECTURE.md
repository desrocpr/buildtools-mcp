# buildtools-mcp — Architecture

This document is a quick map of the codebase for future maintainers. It
covers the high-level component layout, the two-step mutation/confirmation
flow, and where to look when you need to extend the server.

For installation, see [INSTALL.md](./INSTALL.md). For the per-tool reference,
see [TOOLS.md](./TOOLS.md).

## High-level diagram

```
┌──────────────────┐   stdio       ┌─────────────────────┐   HTTPS    ┌─────────────────────┐
│  Claude Desktop  │ ◀──────────▶  │   buildtools-mcp    │ ◀────────▶ │ moss.buildtools.app │
│  (or other MCP   │               │   (this repo)       │  (writes)  │ (BuildTools tenant) │
│   stdio client)  │               │                     │            └─────────────────────┘
└──────────────────┘               │  ┌───────────────┐  │
                                   │  │ MCP transport │  │
                                   │  │  stdio  │ http│  │
                                   │  └───────┬───────┘  │
                                   │          │          │
                                   │  ┌───────▼───────┐  │
┌──────────────────┐  HTTP+bearer  │  │ tool registry │  │
│ Hosted MCP agent │ ◀──────────▶  │  │  + dispatch   │  │
│  (HTTP/SSE)      │               │  └───────┬───────┘  │
└──────────────────┘               │          │          │
                                   │  ┌───────▼───────┐  │
                                   │  │ BuildToolsAPI │  │   reads (fast path)
                                   │  │ + api.db ref  │──┼──────────────────────┐
                                   │  └───────────────┘  │                      │
                                   └─────────────────────┘                      ▼
                                                                     ┌─────────────────────┐
                                                                     │  MossDb (mysql2)    │
                                                                     │  → RDS read replica │
                                                                     │  moss-online-replica│
                                                                     └─────────────────────┘
```

The server is a thin layer:

1. **Transport** chooses how MCP frames cross the wire (`stdio` for Claude
   Desktop, `http`/SSE for hosted agents). `MCP_TRANSPORT` picks one at boot.
2. **Tool registry** is a single map of `name → ToolDefinition` assembled
   from per-domain modules in `src/tools/`. Every MCP `tools/list` and
   `tools/call` request goes through the same dispatch.
3. **BuildToolsAPI** is the typed client — it owns session cookies, CSRF
   tokens, and the URL-encoded form bodies BuildTools' Rails app expects.
   Every mutation tool delegates to a method on this class.
4. **MossDb** (Phase 8, PR #82-#85) is an opt-in read-only adapter against
   the BuildTools MySQL read replica. It mirrors `BuildToolsAPI`'s read
   method signatures, so tool handlers can swap via
   `(api.db ?? api).getX(...)` with no other changes. Built at startup
   from `MYSQL_*` env vars; null when those are absent (local dev, tests).

## Read fast path (Phase 8)

The HTTP wrapper is shape-preserving but slow: BuildTools renders its
datatables as HTML, so every list-style read requires fetching + regex-
parsing an HTML page. Portfolio rollups across 50+ projects (e.g.
`uncollected_invoices`, `cash_flow_forecast` over a team) compound the
per-call latency into multi-minute waits.

The `MossDb` adapter sidesteps this with direct SQL against the
project's read replica:

| Tool | Scope | Before (HTTP) | After (DB) |
|---|---|---:|---:|
| `project_status_brief` | Katchmark — all 5 sections | 5-10s | ~1s |
| `uncollected_invoices` | `team: all_active, window_days: 7` | 4 min | 7s |
| `cash_flow_forecast` | `team: all_active, quarterly, 3q` | 4+ min | ~13s |
| `findUnbilledChangeOrders` | portfolio | minutes | 25ms |
| `getBudget` | per project | 2s | 250ms |

Key invariants of the fast path:

- **Shape parity.** `MossDb.getX(...)` returns the same structure as
  `BuildToolsAPI.getX(...)` so the same downstream formatters and
  consumers work unchanged. New consumers don't know which backend
  they're hitting.
- **Read-only.** The DB connection is opened with the replica user;
  every write tool continues to authenticate as the calling user and
  hit `moss.buildtools.app` over HTTPS. There is no path from a write
  tool to the DB.
- **Graceful fallback.** Tools call `(api.db ?? api).getX(...)`. When
  `MYSQL_*` env vars are unset, the pool is never built and the
  handlers transparently fall through to the HTTP path. Local dev
  doesn't need DB credentials.
- **Pool, not per-call connections.** `MossDb` uses a `mysql2`
  connection pool (8 connections by default) shared across the
  process. Both transports build it once at startup.
- **Per-user permissions are not enforced at the DB layer.** The MCP
  itself is OAuth-gated to Moss employees, and the BuildTools
  permission model is too complex to reconstruct in SQL. This is an
  explicit trade-off — fast portfolio analytics in exchange for
  uniform read access for any authenticated MCP caller.

Tools that opt in: every read tool except attachment download paths
(which need signed file URLs from BT's file service),
`searchChangeOrders` (rare), and `searchCompanies` (different
signature). See `src/db/MossDb.ts` for the canonical method list.

## Mutation / confirmation flow (Phase 4)

Every mutation tool — `create_project`, `create_change_order`,
`delete_financial_statement`, and the other writes registered by
`createMutationTools()` — is gated behind a two-step confirmation handshake.
Mutations never run on the first call.

```
                ┌────────────────────────────────────────────────────┐
                │  Step 1 — Claude calls e.g. `create_project`       │
                │           without `confirmation_id`                │
                └───────────────────────┬────────────────────────────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────────────┐
        │  Server records the requested action in ConfirmationStore  │
        │  (in-memory, TTL 5 min) and returns a Markdown prompt:     │
        │                                                            │
        │   ⚠️  About to call `create_project`                       │
        │   "Create project Smith Kitchen, contract value $42,500"   │
        │   confirmation_id: 6f4e…                                    │
        │   expires: 5 min                                            │
        └───────────────────────┬────────────────────────────────────┘
                                │
                                ▼
                ┌────────────────────────────────────────────────────┐
                │  Step 2 — Claude (after user OK) calls             │
                │           `create_project` again, this time with   │
                │           `confirmation_id: "6f4e…"`               │
                └───────────────────────┬────────────────────────────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────────────┐
        │  Server consumes the pending entry (single-use), executes  │
        │  the mutation using the args captured at step 1, and       │
        │  returns the BuildTools result.                            │
        └────────────────────────────────────────────────────────────┘
```

Key invariants:

- **Args captured at step 1 win.** Substituting different args between step
  1 and step 2 is a no-op for the mutation itself — the original intent is
  what runs.
- **Single-use, short-lived.** A `confirmation_id` that has expired, was
  already consumed, never existed, or was minted for a different tool name
  all surface the same Markdown "please re-invoke without `confirmation_id`"
  message.
- **Not an error.** The "please re-invoke" message is a user-flow message,
  not an error, so it is returned WITHOUT `isError: true`. Real BuildTools
  failures during the actual mutation still surface as `isError: true`.
- **Process-local.** The store is in-memory; pending confirmations are lost
  on restart, which is the desired safety property.

## Where to find what

| Concern | Location |
|---|---|
| HTTP entrypoint, BuildTools session cookies, CSRF token, fetch wrappers, datatable / form / search helpers, all per-domain methods used by tools (`getProjects`, `createChangeOrder`, `findUnbilledChangeOrders`, etc.) | `src/client/` |
| DB fast-path adapter (Phase 8) — `MossDb` class wrapping a `mysql2` pool against the BuildTools read replica. Method signatures mirror `BuildToolsAPI`'s read methods exactly so tool handlers can swap via `(api.db ?? api).getX(...)`. Env-gated factory `buildMossDbFromEnv` returns null when `MYSQL_*` is unset. | `src/db/` |
| One file per MCP tool domain (projects, financial, customers, attachments, tasks, purchase orders, work-tracking, operations, selections, budget, mutations, sessions, briefs, forecasts, invoices) plus `index.ts` barrel. Each domain owns its Zod input schemas, Markdown rendering, error mapping. Analytics tools (Phase 8) — `project_status_brief` (briefs.ts), `cash_flow_forecast` (forecasts.ts), `uncollected_invoices` (invoices.ts) — opt in to the DB fast path. | `src/tools/` |
| Transport selection (`stdio` vs `http`), tool dispatch, audit log, the special-cased `ping` / `refresh_tools` tools, HTTP bearer-token middleware, per-SSE-session credential store. Both transports build the shared `MossDb` pool at startup and attach it to each `BuildToolsAPI` instance as `api.db`. Per-request auth flows through `request-context.ts` (`AsyncLocalStorage`); `/messages` is owner-bound (see AUTH.md, MOS-631). Test-only DI seams: `authResolver` (http) and `transport` (stdio). | `src/transports/` |
| Confirmation framework: `ConfirmationStore`, `requiresConfirmation()` wrapper, TTL sweep timer wired from `src/index.ts`. Every mutation tool composes through this module. | `src/confirm/` |
| Idempotency helpers (PR #67) — `IdempotencyStore`, `checkIdempotency`, `storeIdempotencyResult`. Mutations with an `idempotency_key` cache results to deduplicate retries. | `src/idempotency/` |
| Process bootstrap — picks a transport from `MCP_TRANSPORT`, validates `HTTP_BEARER_TOKEN` when `http`, wires the confirmation sweep, then hands off. | `src/index.ts` |
| Multi-user auth: encryption, OAuth/service tokens, bearer resolver, Supabase store, Microsoft Entra OIDC, RBAC + rate limits, audit log. See [AUTH.md](./AUTH.md). | `src/auth/` |
| Browser surfaces (when `MCP_OAUTH_ENABLED=true`): `/enroll/*`, `/oauth/*`, `/admin/*`, `/.well-known/oauth-authorization-server`. See [ENROLL.md](./ENROLL.md) for user flow. | `src/web/` |
| Supabase schema for the multi-user store: users, roles, encrypted credentials, OAuth clients/codes/tokens, service tokens, audit log, rate buckets, plus atomic RPCs + sweep. | `supabase/migrations/` |
| Hermetic unit + integration tests: client/tool registries, auth logic (PKCE, credential crypto, permission-union), in-process transport RBAC/owner-binding + OAuth/admin route handlers, HTML-page XSS escaping. A whole-`src/` coverage gate (`vitest.config.ts`) runs in CI (`.github/workflows/ci.yml`). The env-gated live Supabase suite (`tests/integration/auth-db.live.test.ts`) is skipped in CI. Tests run without `MYSQL_*` so `api.db` is null and the HTTP fallback path is exercised. | `src/**/__tests__/`, `tests/` |

## Design choices worth knowing

- **Markdown-everywhere responses.** Tool handlers never throw to the SDK;
  both Zod validation failures and `BuildToolsError`s are rendered as
  Markdown `isError: true` content so Claude Desktop surfaces them inline
  rather than killing the stdio session.
- **Zod-v3 sub-export for JSON Schema.** Schemas import from `zod/v3` because
  `zod-to-json-schema` still expects v3 internals. Zod 4 ships the v3 surface
  under that path.
- **Per-session credentials over HTTP, not server-wide.** The HTTP transport
  deliberately ignores `BUILDTOOLS_USERNAME` / `BUILDTOOLS_PASSWORD` so a
  single hosted server can serve many users with their own BuildTools logins,
  scoped to their SSE session.
- **No persistence (for transport state).** The confirmation store and the
  HTTP session store are in-memory. Restarting the process clears
  everything; that is the intended safety property. Persistent state
  (users, encrypted credentials, OAuth tokens, audit log) lives in
  Supabase via the `mcp_*` tables — see [AUTH.md](./AUTH.md).

## Multi-user auth (MOS-328)

**Live in production since 2026-07-10** (`MCP_OAUTH_ENABLED=true`). Behind that
flag, the server also exposes:

- `/enroll/*` — Microsoft Entra sign-in + encrypted BuildTools credential store.
- `/oauth/*` + `/.well-known/oauth-authorization-server` — MCP 2025-03-26
  OAuth 2.1 surface (PKCE/S256, dynamic client registration, opaque
  access + refresh tokens with rotation).
- `/admin/*` — role-gated user management, service-account provisioning,
  audit log viewer.

The legacy bearer + `set_session_credentials` flow remains valid during the
deprecation window (`kind: "legacy"` AuthContext, no RBAC enforced) so service
accounts (the harness) and any un-migrated Claude Desktop sessions don't break.

Auth hardening (MOS-631): permissions are resolved **per request** and carried
into the handlers via `AsyncLocalStorage` (no stale per-session snapshot);
`/messages` is **owner-bound** (a bearer resolving to a different identity than
the session's connecting principal gets a `404`); and the permission checks
**fail closed** if the per-request context is ever missing for an authenticated
session.

Full details — token kinds, RBAC matrix, per-request auth + owner-binding,
threat model, operator runbook — in [AUTH.md](./AUTH.md). End-user onboarding is
[ENROLL.md](./ENROLL.md).
