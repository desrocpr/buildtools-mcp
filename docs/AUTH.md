# Authentication architecture (MOS-328)

For developers, operators, and security reviewers. End-user enrollment is in
[ENROLL.md](./ENROLL.md).

## Goals

- No BuildTools passwords pasted into Claude chats. Per-user identity via
  Microsoft Entra ID.
- Multi-user: each Moss employee acts as themselves in BuildTools. Audit
  log + per-user rate limits.
- Service accounts for headless callers (the harness) via long-lived bearer
  tokens, but never via a person's BuildTools password.
- Backwards-compatible cutover: a legacy `HTTP_BEARER_TOKEN` continues to
  work alongside the new flow for ~2 weeks before removal.

## Token kinds

Three bearer prefixes flow through the same dispatcher:

| Prefix     | Kind          | Lifetime   | Who uses it                             |
|------------|---------------|------------|-----------------------------------------|
| `mcpa_…`   | OAuth access  | ~1 hour    | Claude Desktop (after `/oauth/authorize`) |
| `mcpr_…`   | OAuth refresh | ~30 days   | Claude Desktop (token rotation)         |
| `mcps_…`   | Service       | indefinite | Harness on Lightsail, future automations |
| _other_    | Legacy        | n/a        | Existing static `HTTP_BEARER_TOKEN`     |

All token plaintext is shown to the recipient **once**; we store only the
SHA-256 hash. Revocation is immediate (flag the row).

## Flows

### Human user enrollment

```
Browser            /enroll              Microsoft Entra            Supabase
   │                  │                       │                       │
   │  GET /enroll     │                       │                       │
   ├─────────────────→│                       │                       │
   │  302 to MS       │                       │                       │
   ├──────────────────────────────────────────→                       │
   │  user signs in   │                       │                       │
   │←──────────────────────────────────────────                       │
   │  /enroll/azure-callback?code=…                                   │
   ├─────────────────→│                       │                       │
   │                  │ exchange code         │                       │
   │                  ├──────────────────────→│                       │
   │                  │ ID token              │                       │
   │                  │←──────────────────────│                       │
   │                  │ upsertHumanUser       │                       │
   │                  ├──────────────────────────────────────────────→│
   │  HTML form       │                       │                       │
   │←─────────────────│                       │                       │
   │  POST bt_email + bt_password                                     │
   ├─────────────────→│                       │                       │
   │                  │ validate via real BT login (off-diagram)      │
   │                  │ AES-256-GCM encrypt + insert                  │
   │                  ├──────────────────────────────────────────────→│
   │  /enroll/status  │                       │                       │
   │←─────────────────│                       │                       │
```

### Claude Desktop OAuth (MCP 2025-03-26 spec)

```
Claude         /.well-known   /oauth/register   /oauth/authorize       Microsoft Entra
  │
  │ discover ─────────────→  publishes metadata
  │ register ───────────────────────────────→  mints client_id (mcpc_…)
  │ authorize w/ PKCE/S256 ─────────────────────────────────→ redirects to MS sign-in
  │                                                          ←─── code returned to /oauth/azure-callback
  │                                                              upsertHumanUser → mint our own auth code
  │  redirect back to Claude w/ our code
  │ POST /oauth/token (code + code_verifier) ────────────→ verifies PKCE, issues mcpa_+mcpr_
  │ subsequent /sse + /messages with Authorization: Bearer mcpa_…
  │ /oauth/token refresh_grant when expired ────────────────→ rotates mcpr_, issues new pair
```

### Service-account provisioning

```
Admin (browser)        /admin/service-accounts/new       BuildTools
  │
  │ form: display_name, email, role, bt_email, bt_password
  ├──────────────────→│
  │                   │ validate bt_email+bt_password via real login attempt
  │                   ├────────────────────────────────────→
  │                   │←────────────────────────────────────
  │                   │ createServiceUser (kind=service)
  │                   │ upsertServiceCredentials (encrypted BT creds)
  │                   │ createServiceTokenRow → mcps_… (shown ONCE)
  │ render token page │
  │←──────────────────│
  │ admin copies into Doppler → restarts harness systemd
```

## Authorization (RBAC)

Each tool is tagged with a required `permission` at registration time:

```typescript
list_projects        → "read"
create_change_order  → "write:financial"
delete_selection     → "delete"
create_project       → "write:project"
```

Roles map to permission lists (seeded in `supabase/migrations/…_mcp_schema.sql`):

| Role     | Permissions |
|----------|-------------|
| viewer   | `[read]` |
| editor   | `[read, write:financial, write:selections, write:budget, write:tasks, write:operations]` |
| admin    | `[*]` (wildcard) |
| harness  | `[read, write:financial, write:selections, write:tasks]` (no `delete`, no `create_project`) |

`hasPermission(userPermissions, required)` supports `*` (global wildcard) and
domain wildcards like `write:*`.

## Rate limits

Sliding 1-hour windows, per-(user, permission_bucket):

| Role     | read   | write | delete |
|----------|--------|-------|--------|
| viewer   | 1000   | —     | —      |
| editor   | 1000   | 200   | —      |
| admin    | 1000   | 500   | 50     |
| harness  | 5000   | 500   | —      |

Enforced atomically via Postgres `public.increment_rate_bucket(...)` RPC.
Multiple roles take the MAX limit per bucket.

## Threat model

| Threat                                | Mitigation |
|---------------------------------------|------------|
| BT password leaks via chat            | OAuth flow; form on HTTPS, never in chat |
| Stored credential exfiltration        | AES-256-GCM at rest; key in Doppler (not DB) |
| Token theft & replay                  | SHA-256 hash at rest; refresh rotation; 7-day audit grace on revoked refresh |
| OAuth code interception               | PKCE/S256 required; single-use; 60s TTL |
| Cross-user confirmation hijack        | `ConfirmationStore` keyed on `(sessionId, confirmation_id)` |
| Rate-limit bypass via parallel calls  | Atomic check-and-increment via PG RPC |
| Refresh-rotation race                 | Atomic revoke+issue via PG RPC |
| CSRF on admin POSTs                   | HMAC-signed CSRF token (`/web/csrf.ts`); SameSite=Lax cookie |
| Open enrollment                       | Domain-locked: `@mossbuildinganddesign.com` only |
| BT error message echo in HTML         | Generic user-facing message; full error to stderr |
| Zero-admin lockout                    | `countActiveAdmins` guard on revoke + role-remove |
| Stale `last_seen_at` writes           | 5-min in-memory debounce |
| Audit log of admin mutations          | Every admin POST writes `mcp_audit_log` row |
| Stale role after admin change (MOS-631) | Permissions read per-request via `AsyncLocalStorage`, not a connect-time snapshot — a role change takes effect on the next request |
| Cross-session `/messages` injection (MOS-631) | Owner-binding: the connecting principal (`sessionOwnerKey`) is recorded at `/sse`; a `/messages` whose bearer resolves to a different identity gets a uniform `404` (no liveness oracle) + a server-side log |
| RBAC silently disabled by a lost auth context (MOS-631) | Fail-closed: an authenticated session with a missing per-request context denies instead of falling through to "show/allow everything" |

## Per-request auth + owner-binding (MOS-631)

The HTTP/SSE transport resolves the bearer on **every** `/messages` request and
carries the resulting `AuthContext` into the MCP handlers via an
`AsyncLocalStorage` (`src/transports/request-context.ts`). The tool-list filter,
the per-call permission gate, and the audit writer all read that per-request
context — there is no mutable per-session permission snapshot, so a role change
takes effect on the user's next request (no reconnect, no restart).

Because `/messages` routes only by the `?sessionId=` query param (which rides in
the URL and can leak via proxy logs / `Referer`), the transport **owner-binds**
each session: it records the connecting principal's `sessionOwnerKey`
(`kind:userId`, or `legacy`) at `/sse` and rejects any `/messages` whose bearer
resolves to a different identity, returning the same `404` as an unknown session
(so the status code can't probe session liveness) and logging the attempt.

Both the tool-list filter and the call gate **fail closed**: for a session that
authenticated as OAuth/service at connect, a *missing* per-request context means
the bridge broke, not that the caller is unauthenticated — so they deny rather
than fall through to the unfiltered/unenforced path. See
`sessionAuthenticatedAtConnect` in `src/transports/http.ts`.

## Feature flag + backwards compat

`MCP_OAUTH_ENABLED=true` activates the OAuth surface — **it is ON in production
as of 2026-07-10 (Phase 9 cutover complete)**. When off, the server behaves
exactly as pre-Phase-6. When on:

- `/oauth/*`, `/enroll/*`, `/admin/*`, `/.well-known/*` are exempt from
  bearer middleware (they have their own auth).
- `/sse` + `/messages` accept `mcpa_…`, `mcps_…`, or the legacy
  `HTTP_BEARER_TOKEN`. Legacy tokens resolve to a `kind: "legacy"`
  `AuthContext` with no user and no permissions enforced — they fall
  through to the existing `set_session_credentials` flow.
- After ~2 weeks of overlap, set `MCP_OAUTH_LEGACY_BEARER_DISABLED=true`
  (TODO: flag does not yet exist) to remove the fallback.

## Where things live

| File / path | Role |
|---|---|
| `src/auth/encryption.ts` | AES-256-GCM, versioned payload |
| `src/auth/tokens.ts` | Token gen + hash + prefix detection + constant-time compare |
| `src/auth/oauth-store.ts` | OAuth clients, codes, tokens, atomic rotation |
| `src/auth/service-tokens.ts` | Service token lifecycle |
| `src/auth/users.ts` | Users + roles + service credentials |
| `src/auth/credentials.ts` | Encrypted BT credential storage |
| `src/auth/audit.ts` | Audit log + sliding-window rate buckets |
| `src/auth/azure.ts` | Microsoft Entra OIDC integration |
| `src/auth/session.ts` | Signed cookies + sealed Azure state |
| `src/auth/resolver.ts` | Bearer → AuthContext dispatch |
| `src/auth/last-seen-cache.ts` | Per-user `last_seen_at` write debounce |
| `src/web/enroll.ts` | `/enroll/*` browser routes |
| `src/web/oauth.ts` | `/oauth/*` + discovery |
| `src/web/admin.ts` | `/admin/*` |
| `src/web/csrf.ts` | HMAC CSRF tokens for admin forms |
| `src/web/pages.ts` | All HTML templates |
| `src/web/router.ts` | Composes the above onto Express |
| `src/transports/http.ts` | MCP transport, bearer middleware, dispatch |
| `supabase/migrations/20260602000000_mcp_schema.sql` | Base schema + role seed |
| `supabase/migrations/20260602010000_hardening_rpcs_and_sweep.sql` | Atomic RPCs + sweep |
| `supabase/migrations/20260602020000_hardening_v2.sql` | 7-day grace on revoked refresh |

## Operator runbook

### Enable pg_cron sweep

After deploy, enable `pg_cron` on the `moss-mcp` Supabase project:

1. Open Supabase Dashboard → `moss-mcp` → Database → Extensions.
2. Toggle `pg_cron` on.
3. Re-run the hardening migration, or via SQL Editor:
   ```sql
   select cron.schedule(
     'mcp-sweep-oauth-state',
     '30 3 * * *',
     $$ select public.sweep_oauth_state(); $$
   );
   ```
4. Verify: `select jobname, schedule, command from cron.job;`

Until enabled, expired codes/tokens/rate buckets accumulate. Not catastrophic
in week-1 (~10k rows/week) but worth doing before bigger rollout.

### Promote a user to admin

1. User has to enroll first (visit `/enroll`, sign in, paste BT password).
2. As an existing admin, visit `/admin/users`, find them, click the role
   dropdown → `admin` → `+`.
3. Audit log records `admin:add_role` with `target_user_id` and `role`.

### Revoke a user

1. `/admin/users` → click **Revoke** on their row.
2. Confirmation prompts: revoke = sign out + invalidate all OAuth tokens +
   all service tokens. Their stored BT credentials remain in the DB
   (admin can hard-delete via SQL if requested).
3. Audit log records `admin:revoke_user`.
4. **Last-admin guard**: refuses if it would leave zero active admins.

### Provision a service account (e.g., harness)

1. Create a dedicated BuildTools user (`mcp-harness@mossbuildinganddesign.com`
   with Employee role).
2. `/admin/service-accounts/new`: display name, email, role (typically
   `harness`), BT email + password.
3. Token shown ONCE — copy immediately to Doppler:
   ```bash
   doppler secrets set HARNESS_MCP_TOKEN "mcps_..." \
     --project buildtools-mcp --config prd
   ```
4. SSH to the consuming machine, restart the systemd unit.

### Rotate the encryption key

Not yet automated. Manual procedure:

1. Generate new key: `openssl rand -base64 32`.
2. Bump `ENCRYPTION_VERSION` in `src/auth/encryption.ts` from 1 to 2.
3. Add the new key as `MCP_ENCRYPTION_KEY_V2`; keep the old one as
   `MCP_ENCRYPTION_KEY_V1`.
4. Modify `decrypt()` to dispatch on the version byte; modify `encrypt()`
   to use V2.
5. Write a one-time backfill that decrypts each row with V1 and re-encrypts
   with V2.
6. Remove V1 key.

(Versioning is in place; the actual rotation code isn't. Tracked as a follow-up.)

### Cutover — DONE (2026-07-10)

`MCP_OAUTH_ENABLED=true` is live in `buildtools-mcp/prd`. Moss users are
enrolled and using role-gated access (editor/viewer). The steps below are kept
as the runbook (e.g. after a rebuild-from-scratch):

1. Confirm `pg_cron` is enabled (above).
2. Flip `MCP_OAUTH_ENABLED=true` in `buildtools-mcp/prd` Doppler.
3. Restart `buildtools-mcp.service` on Lightsail.
4. Verify yourself: visit `/enroll`, sign in, enroll, then connect Claude
   Desktop via OAuth. Confirm tool calls work.
5. Provision the harness service account (above).
6. Email other Moss users with the enrollment link (see
   `docs/onboarding-email.md`).
7. **Rollback**: flip the flag back to `false` and restart. Legacy
   `HTTP_BEARER_TOKEN` + `set_session_credentials` resumes exclusive control.
   (Note: with the flag off, owner-binding is inert — there is no identity to
   bind — so the pre-Phase-6 behavior applies.)

### Monitoring

Currently nothing automated. Recommended:

- Query `select result, count(*) from mcp_audit_log where created_at > now() - interval '1 hour' group by result;` periodically. Alert if `error` or `denied` rate spikes.
- Tail server stderr for `[oauth] azure callback error:` and `[admin] BT auth failed during SA provisioning:` patterns.
