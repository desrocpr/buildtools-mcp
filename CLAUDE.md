# CLAUDE.md

Project notes for future Claude Code sessions working in this repo.

## What this is

The **BuildTools MCP** — a TypeScript MCP server wrapping the BuildTools
SaaS (`moss.buildtools.app`) so Claude can act on Moss Building & Design's
projects, change orders, selections, etc. The reverse-engineering toolkit
that informed this client lives at `~/code/buildtools` — read its
`CLAUDE.md` and `docs/` when you need to know *why* a given endpoint or
form-field shape exists.

Deployed at: `https://buildtools-mcp.mossbuildinganddesign.com`

## Architecture orientation

Four layers, top to bottom:

1. **MCP transport** (`src/transports/`) — `stdio` for Claude Desktop,
   `http`/SSE for hosted agents. Bearer middleware + tool dispatch.
   Both transports build the shared DB pool at startup and attach it
   to each `BuildToolsAPI` instance as `api.db`.
2. **Tool registry** (`src/tools/`) — one file per domain (projects,
   financial, mutations, briefs, forecasts, invoices, etc.). Each tool
   is a `ToolDefinition` with a Zod input schema, a `permission` tag,
   and a handler that returns Markdown. Read tools call
   `(api.db ?? api).getX(...)` — DB preferred, HTTP fallback.
3. **BuildToolsAPI** (`src/client/`) — typed client over BuildTools'
   undocumented Laravel/Yii endpoints. Owns session cookies, CSRF tokens,
   and the URL-encoded form-bracket shapes the upstream expects. Writes
   always go through this class.
4. **MossDb** (`src/db/`, PR #82-#85) — opt-in read-only adapter against
   the BuildTools MySQL read replica. Mirrors `BuildToolsAPI`'s read
   method signatures exactly so tool handlers can swap transparently.
   Env-gated via `MYSQL_*`; returns null in local dev / tests, in
   which case the HTTP path takes over.

Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full map.

## Multi-user auth (MOS-328)

The repo also hosts a complete OAuth 2.1 + RBAC + audit + admin surface
behind `MCP_OAUTH_ENABLED=true`. **This flag is now ON in production** and
OAuth is serving live traffic: enrolled Moss users authenticate via
Microsoft Entra and tools are gated by their role (verified 2026-07-10 —
users enrolled, editor/viewer roles in use). The legacy `HTTP_BEARER_TOKEN`
+ `set_session_credentials` path still resolves for service accounts (the
harness) and during the deprecation window.

Role changes take effect on the user's next request. Permission filtering,
the call gate, and audit read the **per-request** auth context (carried into
the MCP handlers via an `AsyncLocalStorage` in `request-context.ts`), which
the bearer middleware re-resolves from the DB on every call — there is no
mutable per-session permission snapshot to go stale. A user does NOT need to
reconnect after an admin promotes them — but Claude Desktop still needs a
`tools/list` re-fetch (toggle the connector) to *display* newly-permitted
tools, since it caches the list.

**Owner-binding.** `/messages` routes only by the `?sessionId=` query param,
which rides in the URL (a weaker channel than a header — it can leak via
proxy/CDN access logs, `Referer`, browser history). To stop a leaked session
id from being a foothold, the transport records the connecting principal's
`sessionOwnerKey` (`kind:userId`, or `legacy`) at `/sse` and rejects any
`/messages` whose bearer resolves to a different identity — returning the same
`404 "Session not found"` as an unknown session (so the status code can't
probe whether a sessionId maps to a live session) and logging the attempt
server-side. So a session id alone is not sufficient to inject into or drive
BuildTools actions under someone else's session; you also need that owner's
own token. Owner-binding is only active when a session authenticated at
connect (`MCP_OAUTH_ENABLED=true`, which is the prod config); with OAuth off
there is no identity to bind and the pre-Phase-6 behavior applies.

**Fail-closed on missing request context.** The permission filter and call
gate treat "no auth context" as "show/allow everything" for genuinely legacy
sessions — but for a session that authenticated as OAuth/service at connect,
a *missing* per-request ALS context means the bridge broke, not that the
caller is unauthenticated. Both handlers cross-check the connect-time snapshot
(`sessionAuthenticatedAtConnect`) and fail **closed** (empty tool list / denied
call) in that case, so an ALS-propagation regression fails loudly instead of
silently disabling RBAC.

When you work on auth-adjacent code: read [docs/AUTH.md](./docs/AUTH.md).
It documents:

- Token kinds (`mcpa_` OAuth access, `mcpr_` refresh, `mcps_` service,
  legacy bearer).
- Microsoft Entra ID flow + the `mcp_enroll_session` cookie.
- RBAC permission matrix (viewer / editor / admin / harness).
- Rate-limit buckets + atomic Postgres RPCs.
- Threat model + operator runbook (incl. pg_cron enablement).

End-user onboarding is in [docs/ENROLL.md](./docs/ENROLL.md). The
roll-out email template is at [docs/onboarding-email.md](./docs/onboarding-email.md).

## Persistent state

| Store | Where | Notes |
|---|---|---|
| BuildTools session cookies, CSRF | In-memory in `BuildToolsAPI` instance | Per-process, per-user; auto-re-auth on 401 |
| Enrolled users, roles, encrypted BT creds | Supabase project `moss-mcp` (ref `dqtdneegrqorkesiftbt`) | See `supabase/migrations/` |
| OAuth clients, codes, access + refresh tokens | Supabase same project | Plaintext shown ONCE; only SHA-256 hash stored |
| Service tokens (harness) | Supabase same project | Long-lived; revocable via `/admin` |
| Audit log + rate buckets | Supabase same project | Sweep job in `sweep_oauth_state()` (needs pg_cron enabled — see AUTH.md) |
| Confirmation store (mutation two-step) | In-memory, per-session | Lost on restart by design |
| HTTP/SSE session store | In-memory | Same |

## Secrets

Doppler. Two projects you'll touch:

- `buildtools-mcp/{dev,prd}` — `HTTP_BEARER_TOKEN`, `SUPABASE_*`,
  `MCP_ENCRYPTION_KEY`, `MCP_OAUTH_ENABLED`, `MCP_PUBLIC_ORIGIN`,
  `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` (DB
  fast path — sourced from `buildtools/dev`; PR #82+).
- `shared/{dev}` — `AZURE_AD_SSO_CLIENT_ID`, `AZURE_AD_SSO_CLIENT_SECRET`,
  `AZURE_AD_TENANT_ID` (reused from Moss's existing Entra enterprise app).

Local dev: `doppler run --project buildtools-mcp --config prd -- node dist/index.js`.

Never `echo` secret values when piping to env tools — use `printf` (the
echo-appends-`\n` gotcha from the user's global CLAUDE.md).

## Commands

```bash
# Build
npm run build

# Type-check only
npx tsc --noEmit

# Tests (vitest)
npm test

# Run the server locally
doppler run --project buildtools-mcp --config prd -- \
  env MCP_TRANSPORT=http HTTP_PORT=3030 \
      MCP_OAUTH_ENABLED=true \
      node dist/index.js

# Apply a new Supabase migration
npx supabase db push --workdir /home/pdesroches/code/buildtools-mcp \
  --password "$(doppler secrets get SUPABASE_DB_PASSWORD --project buildtools-mcp --config prd --plain)"
```

## Deploy

Production runs on AWS Lightsail (`ubuntu@32.193.43.119`,
`~/.ssh/harness_lightsail`). The `~/.ssh/config` alias `lightsail-harness`
points at this host — prefer `ssh lightsail-harness` (the raw IP has been
reassigned before; the alias tracks the current one). App dir is
`/opt/buildtools-mcp`; the systemd unit runs
`doppler run --project buildtools-mcp --config prd -- node dist/index.js`.
Standard deploy:

```bash
ssh lightsail-harness \
  'cd /opt/buildtools-mcp && sudo -u ubuntu git pull && \
   sudo -u ubuntu npm run build && \
   sudo systemctl restart buildtools-mcp'
```

Restarting the service clears the in-memory HTTP/SSE session store — see
the note in "Multi-user auth" about role changes.

Public URL is served via Cloudflare Tunnel (`cloudflared.service`).

## Conventions

- **No emojis in code or commit messages** unless the user asks. Default
  to terse, declarative prose.
- **Don't add tests for trivial code** — don't pad with assertions that just
  re-state the implementation. Prefer behavioral tests (stateful fakes,
  in-process route mounts) over call-spy mocks, and use the env-gated live
  suite for the Supabase CRUD (see "Testing & CI"). Keep the coverage floor in
  `vitest.config.ts` moving up, never down.
- **Tool handlers never throw to the SDK** — both Zod errors and
  `BuildToolsError`s render as Markdown `isError: true` content.
- **Mutations require confirmation** — every write goes through
  `requiresConfirmation()`. Don't bypass.
- **Permission tags on every tool** — `read`, `write:<domain>`, `delete`,
  or `admin`. The dispatcher filters tools/list and enforces tools/call
  based on the user's role when OAuth is enabled.
- **Source-of-truth for BuildTools endpoints** is `~/code/buildtools/docs/`.
  When you find a new endpoint, mirror the shape from the closest existing
  `BuildToolsAPI` method; don't invent.

## DB fast path (Phase 8, PR #82-#85)

The `MossDb` adapter in `src/db/` reads from the BuildTools MySQL
replica directly instead of fanning per-project HTTP requests. Speedups:

| Tool | Scope | Before (HTTP) | After (DB) |
|---|---|---:|---:|
| `project_status_brief` | Katchmark | 5-10s | ~1s |
| `uncollected_invoices` | `team: all_active, 7d` | 4 min | 7s |
| `cash_flow_forecast` | `team: all_active, quarterly` | 4+ min | ~13s |
| `findUnbilledChangeOrders` | portfolio | minutes | 25ms |
| `getBudget` | per project | 2s | 250ms |

Implementation notes:

- Method signatures on `MossDb` mirror `BuildToolsAPI`'s read methods
  exactly. The shape parity is non-negotiable — it's what lets tool
  handlers use `(api.db ?? api).getX(...)` with no other changes.
- Status enums need careful mapping. The HTTP wrapper renders BT's
  HTML status labels ("Sent", "Partly Paid", "Paid"); the DB has
  numeric tinyint codes. See `fsStatusLabel` in `MossDb.ts` for the FS
  mapping (1=Draft, 4=Sent/Partly Paid/Paid by paid_amount, 5=Sent,
  6=Paid). CO statuses: 1=Draft, 2=Pending, 3=Approved, 4=Rejected.
- Per-category budget totals require `purchase_orders_items.budget_category_id`
  (NOT on the PO header) and `change_orders_items.budget_category_id`
  (NOT on the CO header). Aggregating with grouped LEFT JOINs (one
  group-by per join, then JOIN) is ~10× faster than correlated subqueries.
- Schedule tasks: `schedule_tasks.published_id` references the latest
  `schedule_published.is_published_last=1` snapshot. Working schedule
  = `published_id IS NULL`; published schedule = INNER JOIN
  `schedule_published` on `is_published_last = 1`. Naive type filtering
  is wrong — `type=2` means BOTH the root row AND every phase grouping
  (Foundation, Framing). Filter on `parent IS NULL` to drop only the
  root. Also drop synthetic "=> duration child" placeholder rows.
- Per-user BT permission filtering is NOT enforced at the DB layer.
  This is acceptable because the MCP itself is OAuth-gated to Moss
  employees. Don't expose DB-backed reads to non-Moss tenants.

## Common gotchas

- **PostgREST embed ambiguity** — `mcp_user_roles` has two FKs to
  `mcp_users` (`user_id` and `assigned_by`). Embed queries need an
  explicit FK hint: `mcp_user_roles!user_id(...)`. Same pattern for
  the reverse: `mcp_roles!role_id(...)`. Skipping the hint gives you
  "more than one relationship was found".
- **Supabase Buffer ↔ bytea** — `@supabase/supabase-js` JSON-stringifies
  Buffers instead of sending them as bytea. Send as `"\\x" + buffer.toString("hex")`
  to bypass. See `src/auth/credentials.ts`.
- **MCP `tools/list` caching** — Claude Desktop caches the schema. After
  a schema change (new tool, new optional param), users need a full quit +
  restart of Claude Desktop, not just a reconnect.
- **SSE transport + body parsers** — adding `express.urlencoded()` or
  `express.json()` router-wide consumes the POST body before the MCP SDK's
  `handlePostMessage` can read it as a stream. Add parsers per-route on
  the OAuth + admin endpoints only.
- **`mcp_oauth_codes` 60s TTL + `sealState` 90s TTL** — both are tight by
  design. If a user reports "sign-in failed" after a slow MFA, those are
  the suspects.

## Status of MOS-328 (Phase 8 of 9 done as of this writing)

| Phase | Status | PR |
|---|---|---|
| 1 — Foundation (schema, crypto, tokens, types) | ✅ | #36 |
| 2-3 — Supabase wiring + Azure OIDC | ✅ | #37 |
| 4-5 — Enrollment UI + OAuth endpoints | ✅ | #38 |
| 6a — Bearer resolver | ✅ | #39 |
| 6b — Tool permission tagging + RBAC | ✅ | #40 |
| 6c — BT cred auto-load + audit + rate limits | ✅ | #41 |
| 6.5 — Review hardening | ✅ | #42 |
| 7 — Admin endpoints | ✅ | #43 |
| 7.5 — Admin-review hardening | ✅ | #44 |
| **8 — Docs + onboarding** | **✅** | #45 |
| **9 — Cutover** | **✅** | live 2026-07-10 (`MCP_OAUTH_ENABLED=true` in prod) |
| **9.5 — Auth hardening** | **✅** | #87-#88 (per-request auth via ALS, owner-binding, fail-closed) |

## Testing & CI

- `npm test` = `vitest run --coverage`. `vitest.config.ts` enforces a
  **whole-`src/` coverage floor** (a ratcheting gate — raise it as coverage
  improves; do NOT lower it). `npm run build` = `tsc`.
- **CI** (`.github/workflows/ci.yml`, added PR #89) runs `npm ci` + build +
  `npm test` on every PR and push to `main`. The suite is **hermetic** — no
  Supabase/MySQL/secrets. Two DI seams keep it that way: `authResolver` on the
  HTTP transport and `transport` on stdio (both test-only; production never
  sets them).
- **Live DB suite** — `tests/integration/auth-db.live.test.ts` round-trips the
  real Supabase auth layer (service tokens, OAuth codes + token rotation, roles,
  credential bytea). It is `describe.skipIf(!SUPABASE_URL)`, so it **skips in
  CI** and runs on demand:
  `doppler run --project buildtools-mcp --config prd -- npm test`. Self-cleaning
  (unique rows deleted in `finally`).
- This is the codified form of the "live probes beat builder-mocks for DB code"
  convention: hermetic tests cover logic/crypto/route-handlers; the live suite
  covers the Supabase CRUD.
