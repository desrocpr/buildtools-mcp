# State

## 🟢 2026-06-29 — DB fast path + analytics tools complete (Phase 8)

PRs #66-#85 ship a full analytics layer plus a MySQL read-replica fast
path. The MCP is live in production at
`https://buildtools-mcp.mossbuildinganddesign.com`.

### What landed

| PR | Scope |
|---|---|
| #66 | `project_status_brief` — read-only per-project digest tool |
| #67 | Idempotency helper extraction (mutations) |
| #68 | Repo cleanup (coverage / generated files gitignored) |
| #69 | Bulk PO status transition + partial-failure error surfacing |
| #70 | Token cache consolidation in `BuildToolsAPI` |
| #71 | Consolidated `search_X` tools into `list_X` with `query` arg |
| #72 | Richer per-project brief sections |
| #73 | Brief restructured around Moss workflow (schedule, billing, COs, selections vs allowances, budget vs PO) |
| #74 | Fixed CO filter — was matching wrong field, rendered false-clean |
| #75 | Real BT schedule integration (`schedule/published/data?projects=`) |
| #76 | Unbilled CO gap = contract value − sum(FS), matches `find_unbilled_change_orders` |
| #77 | Brief schedule defaults to published (not working) |
| #78 | `cash_flow_forecast` tool — weekly/monthly/quarterly buckets |
| #79 | Forecast cap tuning (per-granularity horizon caps) |
| #80 | Forecast skips design-phase projects (no published schedule) |
| #81 | `sent_date` on financial statements + `uncollected_invoices` tool |
| #82 | **MossDb adapter + DB fast path for 3 slow tools** |
| #83 | DB sweep — list-style read tools migrated (~17 methods) |
| #84 | DB detail fetchers (`getChangeOrder`, `getPurchaseOrder`) + `findUnbilledChangeOrders` single-SQL rewrite |
| #85 | Budget query optimization (8× faster) + remaining selection detail fetchers |
| #86 | Documentation update (this PR) |

### Speedups (live verified against the production MCP)

| Tool | Scope | Before (HTTP) | After (DB) |
|---|---|---:|---:|
| `project_status_brief` | Katchmark — all 5 sections | 5-10s | ~1s |
| `uncollected_invoices` | `team: all_active, window_days: 7` | 4 min (and buggy → 0) | 7s (correct: $387k / 7 invoices) |
| `cash_flow_forecast` | `team: all_active, quarterly, 3q` | 4+ min | ~13s |
| `findUnbilledChangeOrders` | portfolio | minutes | 25ms |
| `getBudget` | per project | 2s | 250ms |

### DB fast path design (PR #82)

- `src/db/MossDb.ts` is a `mysql2` connection pool adapter
- It mirrors the read shape of `BuildToolsAPI` exactly — `getProject`,
  `getProjects`, `getFinancialStatements`, `getChangeOrders`,
  `getBudget`, `getSelections`, `getSchedule`, `getCompanies`,
  `getTasks`, `getRFIs`, `getUsers`, `getPurchaseOrders`,
  `getCertificates`, `getDailyLogs`, `getWeeklyReports`,
  `getWorkDays`, `getAllowances`, `findUnbilledChangeOrders`,
  `getChangeOrder`, `getPurchaseOrder`, `getFinancialStatement`,
  `getSelectionDetail`, `getSelectionName`,
  `getSelectionBudgetCategories`
- Env-gated factory `buildMossDbFromEnv` returns null when
  `MYSQL_HOST/USER/PASSWORD/DATABASE` aren't set — local dev and tests
  fall back to HTTP transparently
- Both transports attach the shared pool to each `BuildToolsAPI`
  instance as `api.db` at startup
- Opt-in tools use `(api.db ?? api).getX(...)` — DB preferred, HTTP
  fallback on connection failure
- Writes never touch the DB; they go through authenticated HTTPS with
  the calling user's credentials
- DB credentials live in Doppler `buildtools-mcp/prd` (synced from
  `buildtools/dev`)
- Per-user BT permission filtering is bypassed — acceptable because
  the MCP itself is OAuth-gated to Moss employees

### Not on DB (intentional)

- `getProjectAttachments` / `getChangeOrderAttachments` — need signed
  file URLs from BT's file service
- `searchChangeOrders` — rarely used; left HTTP for parity
- `searchCompanies` — different signature (role enum) than other
  search* methods; kept HTTP to avoid signature mismatch risk
- All mutation/write tools — by design

### Tests

1012 / 1012 pass. Test mocks still cover the HTTP fallback path
(`api.db` is null in test runs).

---

## 🟢 2026-06-27 — `update_purchase_order` brief overhaul complete (Phase 7)

The brief that kicked off PRs #57-#62 is fully shipped and deployed.

| Brief item | PR | Status |
|---|---|---|
| 1. Full-object reconstruction | #57 | ✅ |
| 2. Append mode for items | #58 | ✅ |
| 3. Internal budget ID resolution | #58 | ✅ |
| 4. Status by label | #57 | ✅ |
| 5. Lock handling, atomic | #61 | ✅ |
| 6. Verify-after-write | #57 + #61 | ✅ |
| 7. Real errors (no `Failed: ""`) | #57 | ✅ |
| 8. Idempotency guard | #60 | ✅ |
| 9. Attachment upload | #59 | ✅ |
| + Standalone status transition + CSRF cache | #62 | ✅ |

**Key discovery**: BT exposes `POST /purchase-orders/status/update` as
a workflow endpoint distinct from `/save`. It accepts transitions
`/save` 403s for (notably Confirmed → Draft). This enabled the
auto-transition path documented as item 5 above.

**Brief's golden test case (PO #39201)**: shipped on 2026-06-27 with
all four targets met (vendor preserved, items updated to $19,533.81,
attachment ADMO55739-F.pdf attached, status moved to Sent).

---

## Phase 1-3 (Read-only MVP) — DONE

All read tools implemented. Server runs over stdio + HTTP/SSE.

Installation: see `docs/INSTALL.md`.

## Phase 4 (Confirmation framework) — DONE

In-memory `ConfirmationStore` + `requiresConfirmation` helper live
under `src/confirm/`. Wired into `src/index.ts` with an `.unref()`ed
sweep timer.

## Phase 5-7 — DONE

- Phase 5: 19 mutation tools registered, each behind the confirmation
  handshake.
- Phase 6: HTTP/SSE transport with bearer-token auth + Microsoft Entra
  OAuth 2.1 enrollment for end-users.
- Phase 7: install / tool reference / architecture docs shipped.

## Phase 8 (Analytics + DB fast path) — DONE 2026-06-29

See top-of-file section.
