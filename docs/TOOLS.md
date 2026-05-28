# buildtools-mcp — Tool Reference

This MCP server exposes 40 tools that Claude Desktop (and other MCP clients
running over HTTP/SSE) can invoke against the BuildTools
(`moss.buildtools.app`) tenant. Phase 1-7 of the project plan is complete:
read tools, write tools, the confirmation framework, the HTTP/SSE transport,
and the install / docs polish are all shipped.

All tool responses are returned as Markdown text. Claude Desktop renders the
response inline, so headers, bullet lists, and tables show up correctly.

When something goes wrong (auth failure, network error, bad input), the tool
returns Markdown text **with `isError: true`** — the SDK surfaces this as an
inline error in the conversation rather than killing the stdio session.

The sections below are grouped by domain. Mutations all live at the bottom
and share the two-step confirmation handshake documented in
"Mutation confirmation pattern".

## `ping`

**Purpose**: cheap health check. Confirms the MCP server is reachable and
that the transport handshake worked, without touching BuildTools at all.

**Inputs**: none.

**Sample prompt**: "Use the ping tool from buildtools."

**Sample output**:

```markdown
pong
```

Returns a single literal line of text. `ping` is special-cased outside the
tool registry on both transports — it has no Zod schema, no BuildTools call,
and no audit-log credentials. On the HTTP transport it is the ONE tool that
can be called before `set_session_credentials`.

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
not errors. This tool is strictly read-only; for billing-side actions, see
`create_financial_statement` under Mutations.

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
project #…"), not errors. This tool is strictly read-only — file upload /
delete actions are not currently exposed as MCP tools.

## `list_financial_statements`

**Purpose**: list the individual financial-statement records (draw requests /
client bills) for a project. Complements `get_financial_statement`, which
returns the rolled-up project-level overview. Renders a Markdown TABLE with
ID, status, name, amount, paid, balance, and date, plus a one-line totals
summary.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |
| `status` | `"Draft"` \| `"Pending"` \| `"Partial"` \| `"Sent"` \| `"Paid"` \| `"All"` | no | Filter by statement status. Default `All`. |

**Sample prompt**: "Use list_financial_statements for project 100002, status Sent."

**Sample output**:

```markdown
**2 financial statements** for project #100002 (Sent):

Totals: $58,500.00 billed, $35,000.00 paid, $23,500.00 outstanding

| ID | Status | Name | Amount | Paid | Balance | Date |
|---|---|---|---|---|---|---|
| 700001 | Sent | Draw Request #4 | $35,000.00 | $35,000.00 | $0.00 | 03/15/2026 |
| 700002 | Sent | Draw Request #5 | $23,500.00 | $0.00 | $23,500.00 | 04/30/2026 |
```

Statement names containing pipe characters are escaped. Empty-result responses
return Markdown ("No financial statements found…"), not errors.

## `list_tasks`

**Purpose**: list BuildTools tasks with optional project / status filters.
Returns up to 50 tasks by default; raise `limit` (max 200) for wider sweeps.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_name` | string | no | Substring forwarded as the datatable's free-text `search[value]`. |
| `status` | `"Open"` \| `"In Progress"` \| `"Complete"` \| `"All"` | no | Default `All`. |
| `limit` | number (1–200) | no | Default 50. |

**Sample prompt**: "Use list_tasks for the Smith Kitchen project, status Open."

**Sample output**:

```markdown
**2 tasks** (filtered 2 total, status: Open):

- #800001 [Open] Order tile — project: Smith Kitchen Remodel · assigned: Pat Sample · due: 04/15/2026 · priority: Normal · location: Master Bath
- #800002 [Open] Schedule plumber walkthrough — project: Smith Kitchen Remodel · assigned: Jordan Foreman · due: 04/20/2026 · priority: High · location: Kitchen
```

The `assigned_to` field arrives as an HTML blob in the datatable response; the
tool strips the markup and surfaces the visible name only.

## `search_tasks`

**Purpose**: free-text search across BuildTools tasks (matches name, project,
assignee, location). Returns the top 20 matches.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `query` | string (≥ 2 chars) | yes | Search string. |

**Sample prompt**: "Use search_tasks for 'tile order'."

**Sample output**:

```markdown
**1 match** for "tile order":

- #800001 [Open] Order tile — project: Smith Kitchen Remodel · assigned: Pat Sample · due: 04/15/2026 · priority: Normal · location: Master Bath
```

Same rendering convention as `list_tasks`. Empty results return Markdown, not
errors.

## `list_purchase_orders`

**Purpose**: list BuildTools purchase orders with an optional project-name
substring filter. Returns up to 50 POs by default.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_name` | string | no | Substring forwarded as the datatable's free-text `search[value]`. |
| `limit` | number (1–200) | no | Default 50. |

**Sample prompt**: "Use list_purchase_orders, project_name 'Smith'."

**Sample output**:

```markdown
**2 purchase orders** (filtered 2 total, project filter: "Smith"):

- #37901 [Approved] PO 145 Tile order for master bath — Acme Subcontractors LLC — $ 3,855.46 (invoiced $ 0.00, diff $ 3,855.46) — Smith Kitchen Remodel — created 02/04/2026
- #37904 [Draft] PO 146 Plumbing rough-in — Acme Plumbing Co — $ 6,200.00 (invoiced $ 0.00, diff $ 6,200.00) — Smith Pool House — created 02/06/2026
```

PO status labels are inferred from the change-order status enum
(1=Draft, 2=Pending, 3=Approved, 4=Rejected) — BuildTools does not document
PO statuses, and the mapping is pending live verification.

## `search_purchase_orders`

**Purpose**: free-text search across BuildTools purchase orders (matches PO
number, name, company, project, relations). Returns the top 20 matches.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `query` | string (≥ 2 chars) | yes | Search string. |

**Sample prompt**: "Use search_purchase_orders for 'tile'."

**Sample output**:

```markdown
**1 match** for "tile":

- #37901 [Approved] PO 145 Tile order for master bath — Acme Subcontractors LLC — $ 3,855.46 (invoiced $ 0.00, diff $ 3,855.46) — Smith Kitchen Remodel — created 02/04/2026
```

Same rendering convention as `list_purchase_orders`.

## `list_certificates`

**Purpose**: list BuildTools certificates (insurance, licensing, etc.).
Supports optional free-text search across name / type / company. Returns up
to 50 rows by default.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `query` | string | no | Free-text search across certificate name / type / company. |
| `limit` | number (1–200) | no | Default 50. |

**Sample prompt**: "Use list_certificates, query 'Acme'."

**Sample output**:

```markdown
**1 certificate** matching "Acme":

- #900001 [Active] Acme General Liability — Insurance — Acme Subcontractors LLC — issued 01/15/2026, expires 01/14/2027 — issuer: Hartford
```

Status codes ship as raw integers from the API and are rendered as-is. Empty
results return Markdown, not errors.

## `list_daily_logs`

**Purpose**: list BuildTools daily-log entries (per-project per-day field
notes). Returns up to 50 entries by default.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `limit` | number (1–200) | no | Default 50. |

**Sample prompt**: "Use list_daily_logs."

**Sample output**:

```markdown
**2 daily logs**:

- #1100001 [1] 02/04/2026 — Smith Kitchen Remodel — 6h — Sunny — Tile work continued; vendor on site for measurements
- #1100002 [1] 02/05/2026 — Smith Pool House — 8h — Cloudy — Foundation pour completed; cure cycle started
```

Notes are truncated at 80 characters for scannability. The full notes blob is
not available through this tool.

## `list_weekly_reports`

**Purpose**: list BuildTools weekly-report entries (per-project weekly
progress summaries). Returns up to 50 entries by default.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `limit` | number (1–200) | no | Default 50. |

**Sample prompt**: "Use list_weekly_reports."

**Sample output**:

```markdown
**1 weekly report**:

- #1200001 [1] 02/01/2026 → 02/07/2026 — Smith Kitchen Remodel — 32h — Tile install complete on shower walls; plumbing rough-in next week
```

Summary text is truncated at 80 characters.

## `list_work_days`

**Purpose**: list BuildTools work-day entries (per-user per-day hours logged
on a project). Returns up to 50 entries by default.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `limit` | number (1–200) | no | Default 50. |

**Sample prompt**: "Use list_work_days."

**Sample output**:

```markdown
**2 work days**:

- #1300001 [1] 02/04/2026 — Pat Sample — Smith Kitchen Remodel — 6h
- #1300002 [1] 02/05/2026 — Jordan Foreman — Smith Pool House — 8h
```

Useful for spot-checking billable hours before invoicing.

## `list_rfis`

**Purpose**: list BuildTools RFIs (requests for information) with an
optional project-name substring filter. Returns up to 50 RFIs by default.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_name` | string | no | Forwarded as the datatable's free-text `search[value]`. |
| `limit` | number (1–200) | no | Default 50. |

**Sample prompt**: "Use list_rfis, project_name 'Jones'."

**Sample output**:

```markdown
**1 RFI**:

- #1400001 [Open] 12 — Confirm tile spec for shower — project: Jones Addition — assigned: Pat Sample — priority: Normal — location: Master Bath
```

Status codes: 1=Open, 2=In Progress, 3=Complete. Priorities: 1=Normal,
2=High, 3=Urgent. Unknown codes render as the raw integer.

## `list_services`

**Purpose**: list BuildTools service requests (project service-line tasks)
with an optional project-name substring filter. Returns up to 50 rows by
default.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_name` | string | no | Forwarded as the datatable's free-text `search[value]`. |
| `limit` | number (1–200) | no | Default 50. |

**Sample prompt**: "Use list_services, project_name 'Jones'."

**Sample output**:

```markdown
**1 service**:

- #1500001 [Open] Punch-list walkthrough — project: Jones Addition — assigned: Jordan Foreman — due: 05/15/2026 — created: 04/30/2026
```

Same numeric status enum as `list_rfis` (1=Open, 2=In Progress, 3=Complete).

## `list_users`

**Purpose**: list BuildTools users with an optional role filter. Returns up
to 100 users by default (max 500).

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `role` | `"Core Admin"` \| `"Employee"` \| `"Client"` \| `"Company Rep"` \| `"All"` | no | Default `All`. `"Employee"` routes through the dedicated employees endpoint. |
| `limit` | number (1–500) | no | Default 100. |

**Sample prompt**: "Use list_users, role Employee."

**Sample output**:

```markdown
**2 users** (role: Employee):

- #1600001 [Employee] Jordan Foreman — email: jordan@example.com — phone: 555-010-0010 — company: Moss Building & Design — created: 11/15/2025
- #1600002 [Employee] Pat Sample — email: pat@example.com — phone: 555-010-0020 — company: Moss Building & Design — created: 12/01/2025
```

Roles arrive as strings on the row and render verbatim. The `"All"` filter
removes the role filter entirely; `"Employee"` uses a separate endpoint that
pre-applies the role filter server-side.

## `search_users`

**Purpose**: free-text search across BuildTools users (matches name, email,
phone, company). Returns the top 20 matches.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `query` | string (≥ 2 chars) | yes | Search string. |

**Sample prompt**: "Use search_users for 'jordan'."

**Sample output**:

```markdown
**1 match** for "jordan":

- #1600001 [Employee] Jordan Foreman — email: jordan@example.com — phone: 555-010-0010 — company: Moss Building & Design — created: 11/15/2025
```

Same rendering convention as `list_users`.

## `list_selections`

**Purpose**: list material / finish selections for a project, grouped by
status. Renders a Markdown TABLE with ID, status, category, location, item,
and price. Optional `status` filter.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |
| `status` | `"Open"` \| `"Selected"` \| `"Approved"` \| `"Rejected"` \| `"Complete"` \| `"All"` | no | Default `All`. |

**Sample prompt**: "Use list_selections for project 100002, status Open."

**Sample output**:

```markdown
**2 selections** for project #100002 (Open):

| ID | Status | Category | Location | Item | Price |
|---|---|---|---|---|---|
| 1700001 | Open | Tile | Master Bath | Subway tile 4x12 | $ 1,200.00 |
| 1700002 | Open | Plumbing fixtures | Master Bath | Rain showerhead | $ 480.00 |
```

Data is parsed from HTML grids (`GET /selections?PR[]=<id>`) since BuildTools
does not expose structured JSON for selections. Empty results return a
Markdown summary of the per-status counts rather than an error.

## `get_selection`

**Purpose**: full detail for a single selection — all candidate options with
descriptions, models, vendor info, prices, attached files, and sub-items.
The `selected` option is highlighted; the rest are listed as "Other options".

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `selection_id` | number | yes | BuildTools selection ID. |
| `project_id` | number | yes | BuildTools project ID. |

**Sample prompt**: "Use get_selection for selection 1700001 on project 100002."

**Sample output**:

```markdown
## Selection #1700001 (project #100002)

### Selected: Subway tile 4x12 — gloss white

- **Description**: Daltile Restore Bright White 4x12, gloss, 1 sq ft / sheet
- **Model**: DAL-RB-4x12-WHT
- **Price**: $1,200.00
- **Vendor**: Acme Tile Supply
- **Product link**: https://example.com/tile/dal-rb-4x12

**Attached files** (1):
- [spec-sheet.pdf](https://example.com/files/spec-sheet.pdf) (412 KB, pdf)

### Other options (1)

- **Subway tile 4x12 — matte white** — $1,120.00 (1 file)
  Daltile Restore Soft White 4x12, matte finish
```

A missing or empty selection returns a Markdown stub ("No detail found…"),
not an error.

## `list_allowances`

**Purpose**: list allowance budget categories for a project with
reconciliation — budgeted amount, total spent on selections inside each
category, and remaining balance. Useful for selection budget oversight.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |

**Sample prompt**: "Use list_allowances for project 100002."

**Sample output**:

```markdown
**2 allowances** for project #100002:

### Tile
- **Budgeted**: $5,000.00
- **Selected/Spent**: $1,200.00
- **Remaining**: $3,800.00
- **Selections** (1):
  - [Open] Subway tile 4x12 — $ 1,200.00

### Plumbing fixtures
- **Budgeted**: $3,500.00
- **Selected/Spent**: $480.00
- **Remaining**: $3,020.00
- **Selections** (1):
  - [Open] Rain showerhead — $ 480.00
```

When spend exceeds budget the row carries an over-budget banner. Empty
allowance lists return Markdown, not errors.

## `list_selection_categories`

**Purpose**: list the budget category IDs available for creating new
selections on a project. Required input for `create_selection`.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |

**Sample prompt**: "Use list_selection_categories for project 100002."

**Sample output**:

```markdown
**3 budget categories** available for selections on project #100002:

- **3010** — Framing Labor
- **3620** — Drywall Materials
- **4100** — Tile
```

Use the ID column as the `budget_category_id` argument to `create_selection`.

## `set_session_credentials`

**Purpose**: hand BuildTools credentials to the HTTP/SSE transport for the
current SSE session. Required before any BuildTools-bound tool will run over
the HTTP transport; ignored under stdio (which reads credentials from process
env vars).

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `username` | string | yes | Per-user BuildTools username / email. |
| `password` | string | yes | Per-user BuildTools password. Never logged. |
| `tenant` | string | no | BuildTools tenant subdomain (e.g. `"moss"`). Falls back to the server's `BUILDTOOLS_TENANT` env var when omitted. |

**Sample prompt** (from a hosted MCP client): the client sends the JSON
payload below before any other tool call.

```json
{
  "name": "set_session_credentials",
  "arguments": {
    "username": "alice@example.com",
    "password": "<alice's BuildTools password>",
    "tenant": "moss"
  }
}
```

**Sample output**:

```markdown
Credentials set for this session. Subsequent BuildTools tool calls will authenticate as `alice@example.com` against tenant `moss`. Credentials are forgotten when the SSE connection closes.
```

Credentials are stored in memory keyed by the SDK-generated SSE `sessionId`.
The tool does NOT call `authenticate()` eagerly — the first BuildTools-bound
tool call validates the credentials and surfaces any auth error from there.
Calling any other (non-`ping`) tool before this handshake returns a Markdown
error asking the client to call `set_session_credentials` first.

## Mutations

The tools below all create or delete BuildTools data. Each one is gated
behind the two-step confirmation handshake documented in "Mutation
confirmation pattern" below. The first call returns a Markdown prompt with
a `confirmation_id`; the second call with that ID actually executes the
mutation using the args captured on the first call.

Every mutation tool also accepts a `confirmation_id` (string, optional) on
its input — omitted in the sample prompts below for brevity.

### `create_project`

**Purpose**: create a new BuildTools project.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Project name (e.g. `"Smith 1 Addition"`). |
| `project_manager_id` | number \| string | yes | Employee ID for the project manager. |
| `status` | number | no | Active teams: 5=Nexus, 6=Omega (default), 7=Invicta, 8=Alpha. |
| `address`, `city`, `state`, `zip` | string | no | Project address. |
| `description` | string | no | Free-text description. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_project for Jones Addition, PM employee 1600001, status 6, address 456 Elm Ave Vienna VA 22030."

**Sample output (step 1)**:

```markdown
⚠️  About to call `create_project`

Create project **"Jones Addition"** (status 6, PM #1600001).

confirmation_id: 6f4e1c9e-…
expires: 5 minutes
```

**Sample output (step 2)**:

```markdown
Project **#100099** created successfully.
```

Status defaults to Omega (6) when omitted. Address fields are URL-encoded
into the form body.

### `create_change_order`

**Purpose**: create a new change order on a project. Optional line-item
breakdown.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | CO name. |
| `project_id` | number | yes | BuildTools project ID. |
| `total` | number | no | Total dollar amount (used if `items` not provided). |
| `description` | string | no | Free-text description. |
| `items` | array of `{name, total, budget_category_id?}` | no | Per-line breakdown. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_change_order for project 100002, name 'Jones - Bathroom Tile Upgrades', total 7500."

**Sample output (step 2)**:

```markdown
Change order **#500099** created.
```

If `items` is omitted, BuildTools generates a single item from the total.

### `create_purchase_order`

**Purpose**: create a purchase order for a vendor on a project.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | PO name. |
| `project_id` | number | yes | BuildTools project ID. |
| `company_id` | number | yes | Vendor / subcontractor company ID. |
| `total` | number | no | Total dollar amount (used if `items` not provided). |
| `prefix` | string | no | PO number prefix. Default `"PO"`. |
| `notes` | string | no | Free-text notes. |
| `items` | array of `{name, total}` | no | Per-line breakdown. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_purchase_order for project 100002, company 300001, name 'Tile order', total 3855.46."

**Sample output (step 2)**:

```markdown
Purchase order **#37999** created.
```

### `create_task`

**Purpose**: create a task on a project.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Task name. |
| `project_id` | number | yes | BuildTools project ID. |
| `status` | number | no | 1=Open (default), 2=In Progress, 3=Complete. |
| `priority` | number | no | 1=Normal (default), 2=High, 3=Urgent. |
| `due_date` | string | no | `MM/DD/YYYY`. |
| `assigned_to` | number \| string | no | User ID to assign to. |
| `description` | string | no | Free-text description. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_task for project 100002, name 'Order tile', assigned 1600001, priority 2, due 04/15/2026."

**Sample output (step 2)**:

```markdown
Task **#800099** created.
```

### `create_rfi`

**Purpose**: create an RFI (Request for Information) on a project.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `subject` | string | yes | RFI subject line. |
| `project_id` | number | yes | BuildTools project ID. |
| `question` | string | no | RFI question body. |
| `priority` | number | no | 1=Normal (default), 2=High, 3=Urgent. |
| `assigned_to` | number \| string | no | User ID to assign to. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_rfi for project 100002, subject 'Confirm tile spec', question 'Which Daltile model goes in the shower?'"

**Sample output (step 2)**:

```markdown
RFI **#1400099** created.
```

### `create_invoice`

**Purpose**: create a vendor invoice (a bill _from_ a vendor — for client
bills use `create_financial_statement` instead).

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `company_id` | number | yes | Vendor company ID. |
| `number` | string | yes | Invoice number. |
| `date` | string | yes | Invoice date (`MM/DD/YYYY`). |
| `due_date` | string | yes | Due date (`MM/DD/YYYY`). |
| `payment_days` | string | no | Payment terms in days. Default `"30"`. |
| `notes` | string | no | Free-text notes. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_invoice for company 300001, number INV-2026-042, date 02/04/2026, due 03/06/2026."

**Sample output (step 2)**:

```markdown
Invoice **#1800099** created.
```

### `create_financial_statement`

**Purpose**: create a financial statement (client bill / draw request) on a
project with a specific dollar amount.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |
| `name` | string | yes | Statement name (e.g. `"Draw Request #5"`). **ASCII only** — special characters get HTML-encoded. |
| `amount` | number | yes | Dollar amount. |
| `notes` | string | no | Free-text notes. |
| `status` | number | no | 1=Draft (default), 2=Pending, 4=Partial, 5=Sent, 6=Paid. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_financial_statement for project 100002, name 'Draw Request 5', amount 23500."

**Sample output (step 2)**:

```markdown
Financial statement **#700099** created for $23500.
```

ASCII-only constraint comes from BuildTools' form-encoding — non-ASCII titles
end up HTML-encoded in the rendered statement and look broken in the UI.

### `delete_financial_statement`

**Purpose**: delete one or more financial statements from a project.
**Destructive** — cannot be undone.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `statement_ids` | array of numbers (≥ 1) | yes | Financial-statement IDs to delete. |
| `project_id` | number | yes | BuildTools project ID (required for session scoping). |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use delete_financial_statement for project 100002, statement_ids [700001]."

**Sample output (step 2)**:

```markdown
Deleted 1 statement(s) successfully.
```

The confirmation prompt names the IDs being deleted so the user can spot a
mistake before approving.

### `create_service`

**Purpose**: create a service request on a project.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Service request name. |
| `project_id` | number | yes | BuildTools project ID. |
| `description` | string | yes | Service description. |
| `status` | number | no | 1=Draft (default). |
| `due_date` | string | no | `MM/DD/YYYY`. |
| `assigned_to` | number \| string | no | User ID to assign to. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_service for project 100002, name 'Punch-list walkthrough', description 'Final walkthrough with client', due 05/15/2026."

**Sample output (step 2)**:

```markdown
Service **#1500099** created.
```

### `create_selection`

**Purpose**: create a material / finish selection on a project. Requires a
`budget_category_id` — use `list_selection_categories` first to find valid
IDs.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `project_id` | number | yes | BuildTools project ID. |
| `name` | string | yes | Selection item name (e.g. `"Countertop"`, `"Faucet"`). |
| `budget_category_id` | number | yes | Budget category ID from `list_selection_categories`. |
| `status` | number | no | 1=Open (default), 2=Selected, 3=Approved, 4=Rejected, 5=Complete. |
| `location_room_id` | number | no | Location / room ID. Default 2 (Non-Specified). |
| `notes` | string | no | Free-text notes. |
| `due_date` | string | no | `MM/DD/YYYY`. |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use create_selection for project 100002, name 'Master bath faucet', budget_category_id 4100."

**Sample output (step 2)**:

```markdown
Selection **#1700099** created successfully.
```

### `delete_selection`

**Purpose**: delete one or more selections from a project. **Destructive**.

**Inputs**:

| Name | Type | Required | Notes |
|---|---|---|---|
| `selection_ids` | array of numbers (≥ 1) | yes | Selection IDs to delete. |
| `project_id` | number | yes | BuildTools project ID (required for session scoping). |
| `confirmation_id` | string | no | Token from the first call. |

**Sample prompt**: "Use delete_selection for project 100002, selection_ids [1700001]."

**Sample output (step 2)**:

```markdown
Deleted 1 selection(s) successfully.
```

The confirmation prompt names the IDs being deleted so the user can spot a
mistake before approving.

## Mutation confirmation pattern

Phase 4 (MOS-217) introduced the in-memory confirmation framework that gates
every mutation tool above behind a two-step handshake. This section
documents the protocol so Claude Desktop (and any other MCP client) knows
how to drive a write tool.

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

**Scope.** The store is process-local and in-memory. The HTTP/SSE transport
(Phase 6, MOS-220) deliberately keeps the same in-memory store: confirmation
IDs are scoped to the process, not to an SSE session, so a freshly-issued
ID is consumable by any caller within the TTL. There is no persistence across
server restarts — pending confirmations are lost on restart, which is the
desired safety property.

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
