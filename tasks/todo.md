# OAuth + Multi-User Migration

Status: planned — kicked off 2026-06-01

## Decisions locked

- **IdP**: Moss Azure AD enterprise SSO app (creds from Doppler `shared`)
- **Storage**: new Supabase project `moss-mcp` (multi-MCP capable)
- **Domain restriction**: `@mossbuildinganddesign.com` only
- **Sole admin**: pdesroches@mossbuildinganddesign.com
- **Default new-enrollee role**: `viewer` (read-only)
- **Harness**: service account, BuildTools user `mcp-harness@mossbuildinganddesign.com`
- **Service-token prefix**: `mcps_`
- **Backwards compat**: `set_session_credentials` + bearer token kept ~2 weeks during cutover; service-account bearer kept permanently

## Architecture

```
Claude Desktop / claude.ai          buildtools-mcp.mossbuildinganddesign.com
       │                                          │
       │  /.well-known/oauth-…  ←─────────────────┤  publishes OAuth 2.1 metadata
       │  /oauth/register  ←──────────────────────┤  RFC 7591 dynamic client reg
       │  /oauth/authorize  ─────────→ Azure AD   │
       │                       ←──────  callback  │  mints MCP code, redirects to client
       │  /oauth/token  ←─────────────────────────┤  exchanges code for access+refresh
       │                                          │
       │  /sse + /messages  ─────────────────────→│  Bearer <mcp-access-token>
       │                                          │  resolves user → loads BT creds
       │                                          │  → BuildToolsAPI per session
       │                                          │
                                Harness on Lightsail
                                       │
                                       │  Bearer mcps_<sha256>
                                       └─────────→  same dispatch, kind=service
```

```
Enrollment (one-time per user):
  https://buildtools-mcp.mossbuildinganddesign.com/enroll
    → Microsoft sign-in (bounce through Azure)
    → POST email + BuildTools password (HTTPS browser form, never chat)
    → server validates login against BuildTools
    → encrypt password (AES-256-GCM), store in mcp_service_credentials
    → confirmation page
```

## Schema (Supabase)

- `mcp_users`: id (uuid), kind ('human'|'service'), azure_sub (nullable, unique for humans), email, display_name, status ('active'|'revoked'), created_at, last_seen_at
- `mcp_roles`: id, name (viewer|editor|admin|harness), permissions (text[])
- `mcp_user_roles`: user_id, role_id (many-to-many; one is enough for v1)
- `mcp_service_credentials`: id, user_id, service ('buildtools'), credentials_encrypted (bytea), encryption_version (int), encrypted_at, updated_at
- `mcp_oauth_codes`: code_hash, user_id, scope, redirect_uri, code_challenge, code_challenge_method, expires_at (60s TTL)
- `mcp_oauth_tokens`: id, token_hash, kind ('access'|'refresh'), user_id, scope, client_id, expires_at, revoked_at
- `mcp_service_tokens`: id, token_hash, user_id (kind=service), display_name, created_at, last_used_at, revoked_at
- `mcp_audit_log`: id, user_id, mcp_server ('buildtools'), tool, project_id, result ('ok'|'error'|'denied'|'rate_limited'), error_message, token_id, created_at
- `mcp_rate_buckets`: user_id, permission_bucket (e.g., 'write'), window_start, count

RLS: only service role can read/write (server holds key; users don't query directly).

## Permission model

- Tools tagged at registration: `read` | `write:<domain>` | `delete` | `admin`
- Default roles seeded:
  - `viewer`: `["read"]`
  - `editor`: `["read", "write:financial", "write:selections", "write:budget", "write:tasks", "write:operations"]`
  - `admin`: `["*"]`
  - `harness`: `["read", "write:financial", "write:selections", "write:tasks"]` (no delete, no create_project)
- Rate limits per role (sliding 1h window):
  - viewer: 1000 reads
  - editor: 1000 reads + 200 writes
  - admin: 1000 reads + 500 writes + 50 deletes
  - harness: 5000 reads + 500 writes

## Encryption

- AES-256-GCM via `crypto.createCipheriv`
- Key: `MCP_ENCRYPTION_KEY` in Doppler `moss-mcp/prd` (32 bytes, base64)
- Stored format: `version(1) || iv(12) || authTag(16) || ciphertext`
- Versioned so we can rotate key without re-enrollment

## Endpoints inventory

**Discovery**
- [ ] `GET /.well-known/oauth-authorization-server` (RFC 8414)

**OAuth flow (Claude Desktop talks to these)**
- [ ] `POST /oauth/register` (RFC 7591 dynamic client registration)
- [ ] `GET /oauth/authorize` (PKCE required; bounces through Azure AD)
- [ ] `GET /oauth/azure-callback` (handles Azure return)
- [ ] `POST /oauth/token` (code grant + refresh grant)
- [ ] `POST /oauth/revoke` (RFC 7009)

**Enrollment (humans)**
- [ ] `GET /enroll`
- [ ] `GET /enroll/azure-callback`
- [ ] `POST /enroll/save`
- [ ] `GET /enroll/status`

**MCP transport**
- [ ] `GET /sse` — Bearer required
- [ ] `POST /messages` — Bearer required

**Admin**
- [ ] `GET /admin/users`
- [ ] `POST /admin/users/:id/role` (assign/remove)
- [ ] `POST /admin/users/:id/revoke`
- [ ] `POST /admin/service-accounts/new` (provision SA + enroll BT creds + mint token)
- [ ] `POST /admin/service-tokens/:id/revoke`
- [ ] `GET /admin/audit` (paginated)

## Phases (parallelizable where called out)

### Phase 1 — Foundation
Can start now (does not block on Supabase project existing).

- [ ] Supabase migration files (`supabase/migrations/0001_mcp_schema.sql`)
- [ ] Encryption util (`src/auth/encryption.ts`) + tests
- [ ] Token util (`src/auth/tokens.ts`) — generation, hashing, parsing + tests
- [ ] Type defs (`src/auth/types.ts`)

### Phase 2 — Supabase wiring
**BLOCKED ON:** Supabase project `moss-mcp` exists, service key + URL in Doppler.

- [ ] Supabase client wrapper (`src/auth/db.ts`)
- [ ] Run migrations against project
- [ ] Seed roles
- [ ] CRUD helpers per table + tests

### Phase 3 — Azure AD integration
**BLOCKED ON:** Azure redirect URIs added to enterprise SSO app.

- [ ] Pick & install Azure AD client (`openid-client` or `arctic`)
- [ ] `src/auth/azure.ts` — sign-in start, callback exchange, token validation
- [ ] Domain check: reject any user whose `email` is not `@mossbuildinganddesign.com`

### Phase 4 — Enrollment UI (depends on Phases 1, 2, 3)
- [ ] HTML template (`src/web/enroll.html`) — Tailwind via CDN, no build step
- [ ] `GET /enroll` (renders form, requires Azure session)
- [ ] `GET /enroll/azure-callback`
- [ ] `POST /enroll/save` — validates BT login, encrypts, stores
- [ ] `GET /enroll/status`
- [ ] Tests (full flow with mocked Azure + BT)

### Phase 5 — MCP OAuth 2.1 (depends on Phases 1, 2, 3)
Can run in parallel with Phase 4.

- [ ] `GET /.well-known/oauth-authorization-server`
- [ ] `POST /oauth/register`
- [ ] `GET /oauth/authorize` — PKCE, redirect through Azure, mint MCP code
- [ ] `POST /oauth/token` — code & refresh grants
- [ ] `POST /oauth/revoke`
- [ ] Tests (PKCE flow, refresh, revocation)

### Phase 6 — Dispatcher + RBAC + rate limits (depends on Phases 1, 2, 5)
- [ ] Token resolver (OAuth + service)
- [ ] Tool registration `permission` field on all 44 tools
- [ ] `tools/list` filters by user role
- [ ] `tools/call` permission check + audit + rate-limit check
- [ ] BuildTools credential resolution per request (cache one `BuildToolsAPI` per session)
- [ ] Replace `auditLog()` stderr writes with Supabase inserts
- [ ] Tests

### Phase 7 — Admin endpoints (depends on Phase 6)
- [ ] `GET /admin/users`
- [ ] `POST /admin/users/:id/role`
- [ ] `POST /admin/users/:id/revoke`
- [ ] `POST /admin/service-accounts/new`
- [ ] `POST /admin/service-tokens/:id/revoke`
- [ ] `GET /admin/audit`

### Phase 8 — Docs + onboarding
- [ ] `docs/AUTH.md`
- [ ] `docs/ENROLL.md` (user-facing)
- [ ] Email template for rollout
- [ ] CLAUDE.md update with the new flow

### Phase 9 — Cutover
- [ ] Deploy to Lightsail behind feature flag `MCP_OAUTH=true`
- [ ] Self-enroll, verify OAuth round-trip
- [ ] Provision harness SA, paste token in Doppler, restart harness
- [ ] Send onboarding email
- [ ] T+2 weeks: remove `set_session_credentials` + legacy bearer

## Blocked-on-you items

| # | Item | Estimated effort |
|---|---|---|
| 1 | Add redirect URIs `/oauth/azure-callback` and `/enroll/azure-callback` to the Moss Enterprise SSO app reg in Azure portal | 2 min |
| 2 | Decide which Azure pair to use: `AZURE_AD_CLIENT_ID/SECRET` or `AZURE_AD_SSO_CLIENT_ID/SECRET` (both exist in Doppler `shared`) | 30s |
| 3 | Create Supabase project `moss-mcp` in your org (or grant me access to create it) | 5 min |
| 4 | Generate `MCP_ENCRYPTION_KEY` (`openssl rand -base64 32`) and put in Doppler `moss-mcp/prd` | 1 min |
| 5 | Create BuildTools user `mcp-harness@mossbuildinganddesign.com` (Employee role) — wait until Phase 9 | 2 min |

## Time estimate

- Phase 1 (Foundation): half day — solo, parallel
- Phase 2 (Supabase wiring): half day after #3 + #4 above
- Phase 3 (Azure AD): half day after #1 + #2 above
- Phase 4 (Enrollment UI): one day
- Phase 5 (OAuth endpoints): one day (parallel with 4)
- Phase 6 (Dispatcher/RBAC/rate limits): one day
- Phase 7 (Admin endpoints): half day
- Phase 8 (Docs): half day
- Phase 9 (Cutover): half day

**Total: ~3.5–4 working days** of focused work. Calendar time depends on how fast we knock out the blocked-on-you items.

## Lessons captured along the way

(Updated as we go — link to `tasks/lessons.md`)
