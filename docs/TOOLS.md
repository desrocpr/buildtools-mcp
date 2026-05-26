# buildtools-mcp — Tool Reference

This MCP server exposes a set of tools that Claude Desktop can invoke against
the BuildTools (`moss.buildtools.app`) tenant. As of Phase 3.2 (MOS-215) the
read-only project surface (MOS-214) and the read-only financial surface
(change orders + financial statements + unbilled-CO sweep) are live; customer
and attachment tools follow in later phases.

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

## Error responses

All three tools convert thrown `BuildToolsError`s (authentication, network,
validation, server) into a Markdown error content block with `isError: true`.
For example, an expired session followed by a failed silent re-auth surfaces
as:

```markdown
**Error calling `list_projects`** (BuildToolsAuthError): Not authenticated
```

Zod input-validation failures are rendered the same way, so Claude can
correct course without crashing the stdio session.
