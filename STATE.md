# State

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

## First production run (YYYY-MM-DD)

> Template — to be filled in by the operator (Paul) after running
> `tests/integration/full-smoke.test.ts` against the live BuildTools tenant
> with `BUILDTOOLS_INTEGRATION_TESTS=1`, `BUILDTOOLS_DESTRUCTIVE_TESTS=1`, and
> (optionally) `BUILDTOOLS_HTTP_TESTS=1`. Replace the placeholders below with
> the real numbers from that run; do NOT invent values ahead of time.

- Stdio transport: TBD — operator to fill in after running the test suite
- HTTP transport: TBD — operator to fill in after running the test suite
- Read tools tested: list_projects (TBD results), get_project (TBD), find_unbilled_change_orders (TBD COs)
- Write tools tested: create_project (test project #TBD created; cleanup TBD — see MOS-222 follow-up on missing update_project tool)
- Confirmation flow: TBD — operator to fill in after running the test suite
- Total roundtrip latency: stdio TBD ms median, HTTP TBD ms median
- Cost: $0 (server is free; BuildTools API calls are unmetered)
