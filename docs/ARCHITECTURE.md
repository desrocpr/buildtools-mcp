# buildtools-mcp — Architecture

This document is a quick map of the codebase for future maintainers. It
covers the high-level component layout, the two-step mutation/confirmation
flow, and where to look when you need to extend the server.

For installation, see [INSTALL.md](./INSTALL.md). For the per-tool reference,
see [TOOLS.md](./TOOLS.md).

## High-level diagram

```
┌──────────────────┐   stdio       ┌─────────────────────┐   HTTPS    ┌─────────────────────┐
│  Claude Desktop  │ ◀──────────▶  │   buildtools-mcp    │ ◀───────▶  │ moss.buildtools.app │
│  (or other MCP   │               │   (this repo)       │            │ (BuildTools tenant) │
│   stdio client)  │               │                     │            │                     │
└──────────────────┘               │  ┌───────────────┐  │            └─────────────────────┘
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
                                   │  │ BuildToolsAPI │  │
                                   │  │ (typed client)│  │
                                   │  └───────────────┘  │
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
   Every tool handler delegates to a method on this class.

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
| One file per MCP tool domain (projects, financial, customers, attachments, tasks, purchase orders, work-tracking, operations, selections, mutations, sessions) plus `index.ts` barrel. Each domain owns its Zod input schemas, Markdown rendering, error mapping. | `src/tools/` |
| Transport selection (`stdio` vs `http`), tool dispatch, audit log, the special-cased `ping` tool, HTTP bearer-token middleware, per-SSE-session credential store. | `src/transports/` |
| Confirmation framework: `ConfirmationStore`, `requiresConfirmation()` wrapper, TTL sweep timer wired from `src/index.ts`. Every mutation tool composes through this module. | `src/confirm/` |
| Process bootstrap — picks a transport from `MCP_TRANSPORT`, validates `HTTP_BEARER_TOKEN` when `http`, wires the confirmation sweep, then hands off. | `src/index.ts` |
| Multi-user auth: encryption, OAuth/service tokens, bearer resolver, Supabase store, Microsoft Entra OIDC, RBAC + rate limits, audit log. See [AUTH.md](./AUTH.md). | `src/auth/` |
| Browser surfaces (when `MCP_OAUTH_ENABLED=true`): `/enroll/*`, `/oauth/*`, `/admin/*`, `/.well-known/oauth-authorization-server`. See [ENROLL.md](./ENROLL.md) for user flow. | `src/web/` |
| Supabase schema for the multi-user store: users, roles, encrypted credentials, OAuth clients/codes/tokens, service tokens, audit log, rate buckets, plus atomic RPCs + sweep. | `supabase/migrations/` |
| Unit + fixture tests for the client and tool registries; smoke test for the stdio transport. | `src/**/__tests__/`, `tests/` |

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

Behind `MCP_OAUTH_ENABLED=true`, the server also exposes:

- `/enroll/*` — Microsoft Entra sign-in + encrypted BuildTools credential store.
- `/oauth/*` + `/.well-known/oauth-authorization-server` — MCP 2025-03-26
  OAuth 2.1 surface (PKCE/S256, dynamic client registration, opaque
  access + refresh tokens with rotation).
- `/admin/*` — role-gated user management, service-account provisioning,
  audit log viewer.

The legacy bearer + `set_session_credentials` flow remains valid during
cutover (`kind: "legacy"` AuthContext, no RBAC enforced) so existing
Claude Desktop sessions don't break mid-flight.

Full details — token kinds, RBAC matrix, threat model, operator runbook —
in [AUTH.md](./AUTH.md). End-user onboarding is [ENROLL.md](./ENROLL.md).
