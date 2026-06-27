# State

## 🟢 2026-06-27 — `update_purchase_order` brief overhaul complete

The brief that kicked off PRs #57–#62 is **fully shipped and deployed**.

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

**Key discovery**: BT exposes `POST /purchase-orders/status/update` as a workflow endpoint distinct from `/save`. It accepts transitions /save 403s for (notably Confirmed → Draft). This enabled the auto-transition path documented as item 5 above — which the original brief had assumed was impossible.

**Brief's golden test case (PO #39201)**: shipped on 2026-06-27 with all four targets met (vendor preserved, items updated to $19,533.81, attachment ADMO55739-F.pdf attached, status moved to Sent). See `~/code/buildtools/STATE.md` for the final state record.

**Tool surface**: 16 mutation tools + 13 read tools deployed via stdio AND HTTP/SSE at `https://buildtools-mcp.mossbuildinganddesign.com`. See `docs/TOOLS.md` for the full inventory including the three additions from this overhaul (`update_purchase_order` with new args, `transition_purchase_order_status`, `upload_attachment`).

**Tests**: 884 / 884 pass. Live verified end-to-end against `moss.buildtools.app` PO #39752.

**What's left**: optional polish only — multi-id batch status workflows, signature support for promote-to-Confirmed (deferred — programmatic eSig has audit-trail implications).

---

## Phase 1-3 (Read-only MVP) — DONE

All read tools implemented. Server runs over stdio, ready for Claude Desktop.

Tools shipped:
- ping
- list_projects, get_project, search_projects
- list_change_orders, get_change_order, find_unbilled_change_orders, get_financial_statement
- list_customers, get_customer
- list_project_attachments

Installation: see docs/INSTALL.md.

## Phase 4 (Confirmation framework) — DONE (MOS-217)

In-memory `ConfirmationStore` + `requiresConfirmation` helper live under
`src/confirm/`. Wired into `src/index.ts` with an `.unref()`ed sweep timer.
No mutation tools yet — Phase 5 (MOS-218 / MOS-219) will register them.

## Phase 5-7 (Mutations + HTTP/SSE + install polish) — NOT STARTED

Filed as separate Linear issues, deferred until Phase 1-3 is validated in production.

## First production run (PENDING — template only)

> **Status: NOT YET RUN.** This section is a template to be filled in by the
> operator (Paul) after running `tests/integration/full-smoke.test.ts`
> against the live BuildTools tenant with `BUILDTOOLS_INTEGRATION_TESTS=1`,
> `BUILDTOOLS_DESTRUCTIVE_TESTS=1`, and (optionally) `BUILDTOOLS_HTTP_TESTS=1`.
> Replace the placeholders below with the real numbers from that run; do NOT
> invent values ahead of time. Update the heading to the actual run date
> (`## First production run (YYYY-MM-DD)`) once the values are in.

- Stdio transport: TBD — operator to fill in after running the test suite
- HTTP transport: TBD — operator to fill in after running the test suite
- Read tools tested: list_projects (TBD results), get_project (TBD), find_unbilled_change_orders (TBD COs)
- Write tools tested: create_project (test project #TBD created; cleanup via direct `BuildToolsAPI.updateProject(..., status: 12 /* Cancelled */)` in test `afterAll` — a follow-up issue should promote `update_project` to a first-class MCP tool)
- Confirmation flow: TBD — operator to fill in after running the test suite
- Total roundtrip latency: stdio TBD ms median, HTTP TBD ms median
- Cost: $0 (server is free; BuildTools API calls are unmetered)
