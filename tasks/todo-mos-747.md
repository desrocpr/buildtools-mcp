# Operations Management API — neutral interface + HTTP gateway

> **Handoff note.** Written 2026-08-04 for MOS-747. Login switch has happened;
> repo state verified intact on the far side (branch `fix/remove-stale-nested-clone`
> at `57e217e` unpushed, clean tree, `gh` authed as `desrocpr`). No MOS-747 code
> written yet — execution starts at the runbook below.

## PR slicing

One PR per phase, each landing green on its own. The coverage gate is a hard CI
failure, so **every PR carries its own tests** — a phase that adds untested surface
drops the whole-`src/` percentage below the floor and fails the build. Phase 3 is
the wide-but-shallow one (type change propagating through ~21 files); Phases 2 and 4
are where the real test weight sits.

## Transition runbook — run this first

Paste-ready. Note `tasks/todo.md` is the **finished MOS-328 OAuth plan** (a record of
shipped work) — do not overwrite it; this writes a new file alongside.

```bash
cd /home/pdesroches/code/buildtools-mcp

# 1. Land the cleanup branch. PR-based on purpose: the git-safety rule is never to
#    run a local `git merge` + push from a checkout sitting on main.
git push -u origin fix/remove-stale-nested-clone
gh pr create --fill
gh pr checks --watch          # CI must go green — it now runs 51 test files, not 63
gh pr merge --squash --delete-branch

# 2. Refresh main
git checkout main && git pull

# 3. Record this plan in the repo, on its own branch
cp ~/.claude/plans/nested-hopping-puffin.md tasks/todo-mos-747.md
git checkout -b docs/mos-747-plan
git add tasks/todo-mos-747.md
git commit -m "docs: record the MOS-747 operations-management API plan"
git push -u origin docs/mos-747-plan
gh pr create --fill && gh pr merge --squash --delete-branch
```

Sanity check after landing: `npm test` should report **51 test files / 829 tests**
with coverage at 69.54/72.39/77.69/69.54. If it reports 63 files, the stale nested
clone is back.

## Decisions already made (user-chose these — do not re-litigate)

| Question | Decision |
| --- | --- |
| Scope | **Interface + HTTP gateway.** Not the consumer migration (that part of MOS-747 is gated on MOS-734, In Progress, due Oct 10). |
| Naming | **`OperationsManagementApi`** in `src/operations/` — deliberately distinct from Cambium's narrower `ConstructionPmAdapter`. |
| Write contract | **Introduce the explicit `ambiguous` outcome** across all 20 writes, accepting the churn in the 19 mutation tools. |

## Unrelated work already committed in this repo

Branch `fix/remove-stale-nested-clone`, commit `57e217e` — **not pushed, no PR yet.**
Separate from MOS-747; land or discard it independently.

- Removed a stale tracked gitlink at the repo root (a clone of this repo pinned at
  PR #67) whose 12 duplicate test files were being executed by `npm test` against
  dead source. Test files 63 → 51, tests 1112 → 829, coverage byte-identical
  (69.54/72.39/77.69/69.54) — confirming those 283 tests contributed nothing.
- Added a `.gitignore` guard and a vitest `exclude` (spreading `configDefaults.exclude`)
  so it cannot recur.
- Improved `CLAUDE.md`: documented `src/web/` and `src/idempotency/` in the
  architecture map, added single-test commands, the `idempotency_key` convention,
  the two-MySQL-clients gotcha, and fixed a stale status heading.

The removed clone was moved to a session scratchpad that will not survive — this is
fine, it was a redundant clone of the same origin and every one of its commits is an
ancestor of `main`.

## Context

The BuildTools client now exists in four independent copies (`buildtools`,
`buildtools-mcp`, `mol_onedrive_sync`, `cambium`). BuildTools is reverse-engineered
and it drifts; when it drifts, four things break differently because each copy
re-implements the hard parts with its own mistakes. Credentials are duplicated too —
every consumer holds the service-account password.

MOS-747 is the consolidation issue. Its full scope (migrating Cambium +
`mol_onedrive_sync`) is gated on MOS-734, which is still **In Progress** with an
Oct 10 deadline — we are deliberately **not** touching those consumers. This plan
covers the two un-gated parts: the neutral interface inside `buildtools-mcp`, and
the machine-facing HTTP surface consumers will later migrate onto.

Two problems this fixes here:

1. **Vendor lock-in in the tool layer.** `ToolDefinition.handler` is typed
   `(args, api: BuildToolsAPI)` (`src/tools/projects.ts:68`) — the vendor is baked
   into the core contract, violating the agnostic-integration rule. 93 code
   references across 21 files.
2. **Writes cannot express "I don't know".** All 20 write methods return
   `{ success: boolean }`. A non-2xx or drifted/unparseable body becomes
   `{success:false}` (`BuildToolsAPI.ts:921`) and one method catches thrown network
   errors into it (`:2093`). `errors.ts` has no ambiguity concept at all —
   `BuildToolsServerError` explicitly folds "non-2xx" and "unparseable success body"
   into one failure class. This is exactly how a create that *did* land becomes a
   duplicate on retry.

Outcome: one interface the codebase depends on, one vendor adapter behind it, one
selection point, and a write contract that distinguishes *failed* from *ambiguous*
end to end — including across the gateway hop.

## Reuse — do not reinvent

Cambium already solved the structural half in-house. Mirror it rather than inventing:

- `cambium/src/integrations/construction-pm/types.ts` — neutral interface + types,
  with the ambiguity rule stated in the contract ("Throwing = the outcome is
  AMBIGUOUS ... never assume a throw means 'not created'").
- `cambium/src/integrations/construction-pm/factory.ts` — single vendor-selection
  switch, hard throw on unknown provider. Copy this shape verbatim.

Reuse inside this repo:

- `src/idempotency/IdempotencyStore.ts` + `helpers.ts` — already implements
  keyed retry-safety with args-fingerprint mismatch detection. The gateway's
  `Idempotency-Key` header routes into this; do not write a second cache.
- `src/auth/resolver.ts` — `resolveBearer()` already returns `kind: "service"` for
  `mcps_` tokens. The gateway uses this; no new auth mechanism.
- `src/web/router.ts` — `mountWebRoutes` / `PUBLIC_ROUTE_PREFIXES` / `isPublicRoute`
  is the established mount + bearer-exclusion pattern.
- `src/db/MossDb.ts` — the existing read fast path, absorbed behind the interface.

## Naming

`OperationsManagementApi`, in `src/operations/`. Distinct from Cambium's
`ConstructionPmAdapter` by design: that is a narrow 2-method actuation port
(create + findByMarker); this is the full ~57-method operations surface spanning
invoices, budgets, selections, schedules, and RFIs.

## Phase 1 — Neutral interface

New tree, mirroring Cambium's layout:

```
src/operations/
  types.ts                      OperationsManagementApi + neutral domain types
  outcomes.ts                   WriteOutcome union + classifyWriteResponse()
  factory.ts                    getOperationsManagementApi(config) — sole selection point
  adapters/buildtools/
    adapter.ts                  implements the interface over BuildToolsAPI + MossDb
    index.ts                    buildBuildToolsOperationsAdapter(...)
```

- `types.ts` declares the interface only — no import of `BuildToolsAPI`, no vendor
  types. Reads return the existing domain shapes from `src/client/types.ts` where
  those are already neutral; audit each during implementation and re-model any that
  carry BuildTools-specific naming.
- **The adapter absorbs `api.db`.** 13 tool files currently write
  `(api.db ?? api).getX(...)`. That selection moves inside the adapter, so handlers
  just call `api.getProjects(...)`. This removes the last vendor leak from the tool
  layer — verified: **no handler touches raw vendor internals** (no `api.request(`,
  cookies, tokens, or form-bracket shapes anywhere in `src/tools/`, `src/web/`, or
  `src/confirm/`).
- Session/credential plumbing (`src/tools/sessions.ts`, `src/auth/credentials.ts`,
  `src/transports/session-store.ts`) mentions `BuildToolsAPI` only in comments —
  no code change needed there.

## Phase 2 — Ambiguity model

In `outcomes.ts`:

```ts
export type WriteOutcome<T> =
  | { status: "ok";        data: T }
  | { status: "failed";    reason: string; details?: unknown }  // provably did NOT land
  | { status: "ambiguous"; reason: string; probe?: string }      // MAY have landed
```

Classification rules — the whole point of this phase:

| Upstream condition | Outcome |
| --- | --- |
| `r === 1` (structured success) | `ok` |
| Parseable, structured BT rejection (validation errors) | `failed` |
| Non-2xx response | `ambiguous` |
| Unparseable / drifted body | `ambiguous` |
| Network error or timeout (`BuildToolsNetworkError`) | `ambiguous` |

Apply across all 20 write methods (`createProject` `:878` … `createService` `:4584`).
Delete the catch-swallow at `:2093` that converts a thrown network error into
`{success:false}`.

`probe` carries the reconcile hint (the marker/search a caller uses to determine
whether the write landed) — this is what makes `ambiguous` actionable rather than
just alarming, and mirrors Cambium's `findByMarker` contract.

## Phase 3 — Retarget the tool layer

- `ToolDefinition.handler` becomes `(args: unknown, api: OperationsManagementApi)`
  in `src/tools/projects.ts:64-68` (the type is re-exported through
  `src/tools/index.ts`, so this is one edit that propagates).
- Drop `api.db ??` from the 13 files that use it (`briefs.ts`, `financial.ts`,
  `selections.ts`, `forecasts.ts`, `invoices.ts`, and siblings).
- Update the 19 mutation tools in `src/tools/mutations.ts` to branch on
  `WriteOutcome` — an `ambiguous` result must render as ambiguous Markdown, never
  as a plain failure.
- Transports (`http.ts`, `stdio.ts`) construct via `getOperationsManagementApi()`
  instead of `new BuildToolsAPI(...)`.

## Phase 4 — HTTP gateway

`src/web/gateway.ts`, mounted by `mountWebRoutes`, routes under `/api/v1/`.

- **Auth**: service tokens only — `resolveBearer()` restricted to `kind === "service"`.
  No per-user OAuth: a headless cron has no user to confirm a gated mutation.
  Add `/api/` to `PUBLIC_ROUTE_PREFIXES` so the MCP bearer middleware skips it, and
  enforce service-token auth inside the gateway router.
- **Body parsing per-route only** (`express.json()` on the gateway routes), never
  router-wide — a router-wide parser consumes the SSE transport's POST `/messages`
  stream before the MCP SDK reads it. This gotcha is already documented in
  `router.ts:59-63`.
- **The wire contract is the neutral interface**, not BuildTools' shapes. That is
  what makes the eventual vendor swap invisible to consumers.
- **Ambiguity must survive the hop** (explicit MOS-747 constraint — the gateway adds
  a hop, so a timeout calling *our own* service is ambiguous the same way):

  | Outcome | HTTP |
  | --- | --- |
  | `ok` | 200 `{outcome:"ok", data}` |
  | `failed` | 422 `{outcome:"failed", reason}` |
  | `ambiguous` | 502 `{outcome:"ambiguous", reason, probe}` |

  Documented client rule: **only 422 is a clean failure.** Any other error —
  timeout, connection reset, 5xx without a parseable body — the client MUST treat
  as ambiguous and reconcile before retrying.
- **Idempotency**: accept an `Idempotency-Key` header and route it into the existing
  `IdempotencyStore`.
- Expose a reconcile/probe read endpoint so a consumer that got `ambiguous` can
  determine whether the write landed.

## Verification

1. `npm run build` — clean tsc.
2. `npm test` — must stay green **and** hold the coverage floor. Current margin is
   thin (69.54 measured vs 69 floor), so new code needs tests in the same PR or the
   gate fails. Follow repo convention: behavioral tests with stateful fakes, not
   call-spy mocks; no trivial assertions.
3. Ambiguity tests are the core of this work — a stateful fake upstream that
   returns, per case: structured success, structured rejection, a 500, a drifted
   body, and a timeout. Assert the first is `ok`, the second `failed`, and the last
   three `ambiguous`. Add the gateway-hop equivalent asserting 200/422/502.
4. Gateway routes tested via in-process route mounts (the pattern already used in
   `src/web/__tests__/`), including a rejected non-service token.
5. Live check against prod BuildTools with a service token before consumers migrate:
   a read through `/api/v1/`, and one write exercising the idempotency replay path.

## Explicitly out of scope

Migrating Cambium's actuator or `mol_onedrive_sync`, and retiring their embedded
clients — gated on MOS-734. This plan only makes the target exist.
