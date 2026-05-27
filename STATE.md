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
