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

Three layers, top to bottom:

1. **MCP transport** (`src/transports/`) — `stdio` for Claude Desktop,
   `http`/SSE for hosted agents. Bearer middleware + tool dispatch.
2. **Tool registry** (`src/tools/`) — one file per domain (projects,
   financial, mutations, etc.). Each tool is a `ToolDefinition` with a
   Zod input schema, a `permission` tag, and a handler that returns
   Markdown.
3. **BuildToolsAPI** (`src/client/`) — typed client over BuildTools'
   undocumented Laravel/Yii endpoints. Owns session cookies, CSRF tokens,
   and the URL-encoded form-bracket shapes the upstream expects.

Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full map.

## Multi-user auth (MOS-328)

The repo also hosts a complete OAuth 2.1 + RBAC + audit + admin surface
behind `MCP_OAUTH_ENABLED=true`. **As of this writing the flag is off in
production**; the legacy `HTTP_BEARER_TOKEN` + `set_session_credentials`
flow is what's actually serving traffic.

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
  `MCP_ENCRYPTION_KEY`, `MCP_OAUTH_ENABLED`, `MCP_PUBLIC_ORIGIN`.
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

Production runs on AWS Lightsail (`ubuntu@44.223.78.200`,
`~/.ssh/harness_lightsail`). Standard deploy:

```bash
ssh -i ~/.ssh/harness_lightsail ubuntu@44.223.78.200 \
  'cd /opt/buildtools-mcp && sudo -u ubuntu git pull && \
   sudo -u ubuntu npm run build && \
   sudo systemctl restart buildtools-mcp'
```

Public URL is served via Cloudflare Tunnel (`cloudflared.service`).

## Conventions

- **No emojis in code or commit messages** unless the user asks. Default
  to terse, declarative prose.
- **Don't add tests for trivial code** — keep coverage above 80% but don't
  pad with assertions that just re-state the implementation. Live probes
  against the Supabase project are the higher-signal verification.
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
| **8 — Docs + onboarding** | **✅** | (this PR) |
| 9 — Cutover | _pending_ | needs pg_cron enable, Paul to enroll, harness SA provision |
