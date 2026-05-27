# buildtools-mcp — Tool Reference

This MCP server exposes a set of tools that Claude Desktop can invoke against
the BuildTools (`moss.buildtools.app`) tenant. As of Phase 5.1 (MOS-218) the
read-only MVP and the first mutation tools are live: the project read surface
(MOS-214), the financial read surface (MOS-215 — change orders + financial
statements + unbilled-CO sweep), the customer + attachment read surface
(MOS-216), and the project mutation surface (MOS-218 — `create_project` +
`update_project`, both gated by the Phase 4 / MOS-217 confirmation framework).
Attachment + change-order mutations (Phase 5.2 / MOS-219), HTTP/SSE transport
(Phase 6 / MOS-220), and install polish (Phase 7 / MOS-221) follow as separate
issues.

All tool responses are returned as Markdown text. Claude Desktop renders the
response inline, so headers, bullet lists, and tables show up correctly.

When something goes wrong (auth failure, network error, bad input), the tool
returns Markdown text **with `isError: true`** — the SDK surfaces this as an
inline error in the conversation rather than killing the stdio session.

## `list_projects`

**Purpose**: list BuildTools projects with optional filters. Returns up to 50
projects by default; raise `limit` (max 200) for wider sweeps.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `status` | `"Active"` \| `"Complete"` \| `"Lost"` \| `"All"` | no | Defaults to `Active`. `All` removes the status filter. |
| `customer_name` | string | no | Passed to the datatable's free-text `search[value]` (BuildTools' datatable searches across all columns). |
| `limit` | number (1–200) | no | Defaults to 50. |

**Sample prompt**: "Use the list_projects tool from buildtools to show me active projects matching Smith."

**Sample output**:

```markdown
**2 projects** (filtered 2 total, status: Active):

- #100002 [Active] Smith Kitchen Remodel — Springfield, VA — $ 42,500.00 contract value
- #100007 [Active] Smith Pool House — Falls Church, VA — $ 138,500.00 contract value
```

Empty-result responses are returned as Markdown ("No projects matched the filter…"), not errors.

## `get_project`

**Purpose**: fetch the full record for a single BuildTools project by its
numeric ID. Renders a structured Markdown summary with status, contract
value, address, project managers, client IDs, and key dates.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | The BuildTools internal numeric project ID. |

**Sample prompt**: "Use get_project from buildtools for project 100002."

**Sample output**:

```markdown
## Project #100002 — Jones Addition

- **Status**: Active
- **Contract value**: $ 245,500.50
- **Address**: 456 Elm Ave · Springfield, VA · 22030 · US
- **Project managers**: Project Manager A
- **Client IDs**: #200001
- **Created**: 01/15/2026
- **Updated**: 04/30/2026

### Description

Two-story addition over existing garage with new master suite.
```

Missing fields render as em-dashes (`—`); a missing project (404) returns
"No project found with ID #…" as Markdown rather than throwing.

## `search_projects`

**Purpose**: free-text search across BuildTools projects (matches name,
address, project number, and other free-text columns). Returns the top 20
matches as a Markdown list.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `query` | string (≥ 2 chars) | yes | Search string. |

**Sample prompt**: "Use search_projects from buildtools for 'Vienna kitchen'."

**Sample output**:

```markdown
**3 matches** for "Vienna kitchen":

- #100005 [Active] Vienna Kitchen Remodel — Vienna, VA — $ 87,300.00 contract value
- #100012 [Active] Tysons Kitchen + Pantry — Vienna, VA — $ 64,800.00 contract value
- #100018 [Complete] Vienna Whole-Home — Vienna, VA — $ 412,000.00 contract value
```

Empty-result responses are returned as Markdown ("No projects matched query…"),
not errors.

## `list_change_orders`

**Purpose**: list change orders for a single BuildTools project. Returns the
CO number, status, amount, and description in a Markdown bullet list. Uses
the change-orders datatable filtered by project ID.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |

**Sample prompt**: "Use list_change_orders from buildtools for project 100002."

**Sample output**:

```markdown
**2 change orders** for project #100002:

- #500001 [Draft] Jones - Basement Work (#19) — $ 13,800.00 — created 02/04/2026
- #500002 [Pending Approval] Brown - Master Bath Upgrades (#4) — $ 7,500.00 — created 11/02/2025
```

Empty-result responses return Markdown ("No change orders found…"), not errors.

## `get_change_order`

**Purpose**: fetch the full record for a single change order, including the
project link, line items, and current billing status. Renders Markdown with a
header, status block, optional description, and a per-line-item list.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `change_order_id` | number | yes | BuildTools change-order ID. |

**Sample prompt**: "Use get_change_order from buildtools for CO 500001."

**Sample output**:

```markdown
## Change Order #500001 — Jones - Basement Work

- **Status**: Draft
- **Number**: 19
- **Approved number**: —
- **Project**: Jones Addition (#100002)
- **Amount**: $ 13,800.00
- **Billing status**: Pending
- **Created**: 02/04/2026

### Description

Add basement framing + drywall.

### Line items

- Framing labor — $ 8,000.00 (3010 - Framing Labor)
- Drywall materials — $ 5,800.00 (category #3620)
```

Missing fields render as em-dashes (`—`); a missing change order returns
"No change order found with ID #…" as Markdown rather than throwing.

## `find_unbilled_change_orders`

**Purpose**: sweep all projects for change orders that are approved but not yet
billed. High-value for accounting cleanup. Renders a summary header (count +
total dollar amount, formatted via `Intl.NumberFormat` USD) and a per-CO
Markdown table.

The "approved" heuristic looks at `approved_number`, `email_status_label`
("Approved"), and `status` codes (treating wire value 3 as Approved). The
"unbilled" heuristic excludes any row with a positive `invoiced_amount`.
`older_than_days` is applied against `created_at` (BuildTools does not surface
a dedicated approved-at timestamp).

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `min_amount` | number | no | Filter to COs over this dollar amount. |
| `older_than_days` | number | no | Only COs approved (using `created_at` as a proxy) more than this many days ago. |

**Sample prompt**: "Use find_unbilled_change_orders from buildtools with min_amount 5000."

**Sample output**:

```markdown
**2 unbilled change orders** — total $19,700.00 — min $5,000.00

| # | CO | Project | Status | Amount | Created |
|---|---|---|---|---|---|
| 500002 | #4 | Brown Addition | Approved | $7,500.00 | 11/02/2025 |
| 500003 | #7 | Smith Kitchen | Approved | $12,200.00 | 01/15/2026 |
```

Empty-result responses return Markdown ("No unbilled change orders found…"),
not errors. This tool is strictly read-only; mark-as-billed actions are
Phase 5 (MOS-219).

## `get_financial_statement`

**Purpose**: render a Markdown summary of a project's financial statement
(revenue + costs + margin + billing + outstanding receivables). Reads through
the form endpoint (`/financial/statements/form?PR[]={id}`) because the
financial-statements datatable read is documented as broken.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |

**Sample prompt**: "Use get_financial_statement from buildtools for project 100002."

**Sample output**:

```markdown
## Financial Statement #700001 — Q1 2026 Statement (project #100002)

- **Contract value**: $250,000.00
- **Costs**: $180,000.00
- **Margin**: $70,000.00
- **Billing status**: Status code 1
- **Outstanding receivables**: $0.00
- **Amount paid to date**: $ 45,000.00
- **Due date**: 04/30/2026
- **Last payment**: 04/30/2026
- **Aging days**: 0
```

Fields missing from the source payload render as em-dashes (`—`) rather than
throwing. Margin is derived from contract value − costs when not present in the
payload; the BuildTools form sometimes ships these inside a
`budgetOverviewTotals` JSON blob which is parsed transparently.

## `list_customers`

**Purpose**: list BuildTools customers (people / companies tied to projects).
Optionally filter by activity (customers with at least one project link) or by
a name substring. Returns a Markdown bullet list.

**When to use it**: when the user asks for "all our vendors / subs / clients",
"who do we work with on X type of project", or wants to find a customer by
fragment of name before drilling into `get_customer`.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `has_active_project` | boolean | no | When `true`, only customers with at least one project link (heuristic: non-empty `budget_relations`). When `false`, only customers with no project link. Omit to skip filter. |
| `name_search` | string | no | Forwarded to the customers datatable's free-text `search[value]`. |

**Sample prompt**: "Use list_customers from buildtools, name_search 'Acme'."

**Sample output**:

```markdown
**2 customers**:

- #300001 [Active] Acme Subcontractors LLC (Subcontractor) — Anytown, VA — contact: Pat Sample
- #300002 [Active] Acme Painting Co (Vendor) — Springfield, VA — contact: Jordan Painter
```

Empty-result responses are returned as Markdown ("No customers matched the
filter…"), not errors.

## `get_customer`

**Purpose**: fetch the full record for a single BuildTools customer by its
numeric ID. Renders a structured Markdown summary with status, type, primary
contact, email, phone, address, rating, and associated projects when surfaced
on the form payload.

**When to use it**: after `list_customers` identifies a candidate, or when the
user asks "tell me everything about customer #X" or "what projects do we have
with customer Y".

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `customer_id` | number | yes | The BuildTools internal numeric customer / company ID. |

**Sample prompt**: "Use get_customer from buildtools for customer 300001."

**Sample output**:

```markdown
## Customer #300001 — Acme Subcontractors LLC

- **Status**: Active
- **Type**: Subcontractor
- **Primary contact**: Pat Sample
- **Email**: vendor@example.com
- **Phone**: 555-010-0001
- **Address**: 100 Industrial Way · Anytown, VA · 22030 · United States
- **Rating**: 4
- **Created**: 01/19/2026
- **Updated**: 03/01/2026

### Associated projects

- #100002 — Jones Addition
- #100007 — Smith Pool House
```

Missing fields render as em-dashes (`—`); a missing customer returns
"No customer found with ID #…" as Markdown rather than throwing.

## `list_project_attachments`

**Purpose**: list files/attachments for a BuildTools project. Returns a
Markdown TABLE with name, type (extension + image/document bucket), size,
upload date, and a clickable download URL column. Optional `type_filter`
buckets the result client-side.

**When to use it**: when the user asks for "files for project X", "renderings
for the bathroom remodel", "all PDFs we've uploaded on Y", or wants a quick
table they can click through to download.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |
| `type_filter` | `"images"` \| `"documents"` \| `"all"` | no | `images` = png/jpg/jpeg/gif/webp/svg/bmp; `documents` = everything else. Default `all`. |

**Sample prompt**: "Use list_project_attachments from buildtools for project 100002, type_filter documents."

**Sample output**:

```markdown
**2 attachments** for project #100002 (type_filter: documents):

| Name | Type | Size | Uploaded | Download |
|---|---|---|---|---|
| scope-revision-1.pdf | pdf (document) | 239.4 KB | 02/04/2026 09:15:00 | [Download](https://example.com/attachments/scope-revision-1.pdf) |
| approval-signed.pdf | pdf (document) | 87.1 KB | 02/05/2026 14:30:00 | [Download](https://example.com/attachments/approval-signed.pdf) |
```

Empty-result responses are returned as Markdown ("No attachments found for
project #…"), not errors. This tool is strictly read-only — upload / delete
actions are Phase 5 (MOS-219).

## `create_project`

**Purpose**: create a new BuildTools project. Two-step: the first call returns
a confirmation prompt with a single-use `confirmation_id`; re-invoke with that
ID to execute the mutation. Routed through the Phase 4 confirmation framework
(see *Mutation confirmation pattern* below).

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `name` | string (≥ 1 char) | yes | Project name (visible in BuildTools UI). |
| `customer_id` | number | yes | Existing customer ID. Use `list_customers` to find. Wired through to BuildTools as `Client[ids]`. |
| `status` | `"Active"` \| `"Complete"` \| `"Lost"` | no | Initial project status. When omitted, the BuildTools client default applies. |
| `address` | string | no | Street address. |
| `city` | string | no |  |
| `state` | string | no | 2-letter state code (e.g. `VA`). |
| `zip` | string | no |  |
| `country` | string | no | Country code (e.g. `US`). |
| `description` | string | no |  |
| `project_manager` | number \| string | no | BuildTools employee ID for the project manager. Most tenants require one server-side. |
| `confirmation_id` | string | no | Pass on the second invocation to execute the mutation. Single-use; expires after 5 minutes. |

**`contract_value` and `project_type` are intentionally NOT exposed**: the
underlying `BuildToolsAPI.createProject` does not accept either. Contract
value is managed via the financial-statement surface; project type has no
documented wire field on the project-save endpoint.

**Sample prompt**: "Create a new project for John Smith — Kitchen remodel, customer 300001."

**Sample 1st-call output** (confirmation prompt — no mutation runs):

```markdown
⚠️ This will modify BuildTools production data via `create_project`.

Create a new BuildTools project named "Kitchen remodel" for customer #300001
- Project manager: 42

To proceed, re-invoke `create_project` with confirmation_id: "abc-123-…". This confirmation expires in 5 minutes.
```

**Sample 2nd-call output** (with the `confirmation_id` from the 1st call):

```markdown
✅ Created project #1248: Kitchen remodel (customer #300001).
```

If BuildTools rejects the create (e.g. validation error) the response is
Markdown with `isError: true` and includes the server's error payload; no
raw stack trace is leaked.

## `update_project`

**Purpose**: update fields on an existing BuildTools project. Two-step
confirmation required. The first call fetches the existing project so the
confirmation prompt can render a clear `old → new` diff per field. The
mutation only runs after the second call with the matching `confirmation_id`.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID to update. |
| `name` | string (≥ 1 char) | no | New name. |
| `status` | `"Active"` \| `"Complete"` \| `"Lost"` | no | New status. `"On Hold"` is not yet supported — no documented wire code (refining is a MOS-222 concern). |
| `address` | string | no |  |
| `city` | string | no |  |
| `state` | string | no |  |
| `zip` | string | no |  |
| `country` | string | no | Country code. |
| `description` | string | no |  |
| `confirmation_id` | string | no | Pass on the second invocation to execute. Single-use; expires after 5 minutes. |

`contract_value` is intentionally NOT exposed (see `create_project` above).

**No-op short-circuit**: calling `update_project` with `project_id` only — no
diff fields — returns a Markdown "No changes to apply" message WITHOUT minting
a confirmation entry and WITHOUT calling the BuildTools API.

**Project-manager requirement**: BuildTools' save endpoint requires a project
manager on every save. The tool reads the existing project's project manager
on the first call and re-uses it on save, so the user does NOT need to supply
one. If the existing project has no project manager on record, the first call
returns a clear error rather than minting a confirmation.

**Sample prompt**: "Change project 100002's status to Complete."

**Sample 1st-call output** (confirmation prompt — no mutation runs):

```markdown
⚠️ This will modify BuildTools production data via `update_project`.

Change project #100002's status from Active → Complete

To proceed, re-invoke `update_project` with confirmation_id: "def-456-…". This confirmation expires in 5 minutes.
```

**Sample 2nd-call output** (with the `confirmation_id` from the 1st call):

```markdown
✅ Updated project #100002.

Change project #100002's status from Active → Complete
```

If BuildTools rejects the update or throws, the response is Markdown with
`isError: true` and the server's error payload; no raw stack trace is leaked.

## Mutation confirmation pattern

Phase 4 (MOS-217) introduced an in-memory confirmation framework that gates
every Phase 5 mutation tool behind a two-step handshake. Phase 5.1 (MOS-218)
ships the first two mutation tools (`create_project` + `update_project`,
documented above) — this section documents the shared protocol so Claude
Desktop (and any other MCP client) knows how to drive any write tool.

**The protocol.** Each mutation tool has two invocation modes:

1. **First invocation — no `confirmation_id` argument.**
   The tool does NOT mutate anything. Instead, it records the requested
   action in an in-process `ConfirmationStore` and returns a Markdown prompt
   that contains:

   - a `⚠️` banner naming the tool that is about to mutate production data,
   - a human-readable description of what will happen (e.g. *"Create a new
     BuildTools project named 'Smith Kitchen' for customer Smith with
     contract value $42,500"*),
   - a single-use `confirmation_id` (UUID v4),
   - the TTL after which the confirmation expires (5 minutes by default).

2. **Second invocation — same tool name, with the `confirmation_id` argument
   set to the value from step 1.** The server consumes the pending entry
   (single-use; a second consume of the same ID returns nothing) and
   executes the mutation using the **args captured at step 1**, not the
   args sent in step 2. Substituting different args between step 1 and step
   2 is therefore a no-op for the mutation itself — the original intent is
   what runs.

**TTL.** Confirmations expire 5 minutes after creation. A periodic sweep
(driven by an `.unref()`ed `setInterval` in `src/index.ts`) drops expired
entries; `consume()` also enforces expiry on read. A `confirmation_id` that
has expired, was already consumed, never existed, or was minted for a
DIFFERENT tool name is treated identically: the server returns a Markdown
message asking Claude to re-invoke the tool without a `confirmation_id` to
get a fresh prompt.

**Error shape.** The "please re-invoke" message is a **user-flow message,
not an error**, so it is returned WITHOUT `isError: true`. Genuine
BuildTools failures during the actual mutation (auth, network, server)
still surface as `isError: true` Markdown the same way read tools do today.

**Scope.** The store is process-local and in-memory. This is correct for
the stdio transport (one Claude Desktop client per server process). Phase 6
(MOS-220) will revisit isolation when the HTTP/SSE transport lands. There
is no persistence across server restarts — pending confirmations are lost
on restart, which is the desired safety property.

## Error responses

All read tools convert thrown `BuildToolsError`s (authentication, network,
validation, server) into a Markdown error content block with `isError: true`.
For example, an expired session followed by a failed silent re-auth surfaces
as:

```markdown
**Error calling `list_projects`** (BuildToolsAuthError): Not authenticated
```

Zod input-validation failures are rendered the same way, so Claude can
correct course without crashing the stdio session.
