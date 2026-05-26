# buildtools-mcp — Tool Reference

This MCP server exposes a set of tools that Claude Desktop can invoke against
the BuildTools (`moss.buildtools.app`) tenant. As of Phase 3.1 (MOS-214) the
read-only project surface is live; financial, customer, and attachment tools
follow in later phases.

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
