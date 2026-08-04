# Lessons

Patterns captured after user corrections. Read at session start.

## 2026-08-04 — Code review is part of writing code, not a merge gate

**Correction:** After writing `src/operations/outcomes.ts` (MOS-747) I committed it and
reported status with no review. Paul: *"this should have been built into your workflow,
this is the most basic of all requests."*

**Pattern:** The global CLAUDE.md lists `code-reviewer` under "Immediate Agent Usage —
no user prompt needed." Review belongs in the write→verify→report loop, before the work
is announced as done — not deferred until merge comes up.

**Rule for next time:** After any non-trivial code change, dispatch `code-reviewer`
(and `security-reviewer` when the change touches auth, user input, secrets, or an API
surface) as part of finishing the work. If something blocks that — a session directive
restricting agents, a usage limit — state the blocker explicitly and let the user
decide. Never let review silently not happen.

## 2026-08-04 — Verify a "shape parity" convention before preserving it

**Context:** CLAUDE.md called `MossDb`'s signature parity with `BuildToolsAPI`
"non-negotiable." Investigating for MOS-747 showed the parity is partly with a *vendor
wire artifact*: `MossDb` fabricates `DT_RowId: row_${id}` at 10+ sites to imitate a
jQuery DataTables envelope, and 12 of 14 tool files parse that string back apart with
`.replace(/^row_/, "")` to recover an id the DB already had as a real column.

**Rule for next time:** A documented convention explains what the code does, not
necessarily what it should do. Before building on one, check what it is actually
preserving — here, "parity" was propagating a vendor detail the neutral layer exists to
remove.
