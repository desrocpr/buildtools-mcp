/**
 * MCP tools for BuildTools selections and allowances.
 *
 * Selections are material/finish choices on a project, grouped by budget
 * category. Allowance categories are budget line items exposed to the
 * customer — the customer selects items within each allowance budget,
 * and the difference (over/under) is reconciled before purchase.
 *
 * Data is parsed from HTML grids (GET /selections?PR[]=<id>) and
 * budget HTML (GET /budget?PR[]=<id>) — BuildTools does not expose
 * structured JSON for these entities.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function markdown(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function formatError(err: unknown, toolName: string): ToolResult {
  if (err instanceof BuildToolsError) {
    return errorMarkdown(
      `**Error calling \`${toolName}\`** (${err.name}): ${err.message}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorMarkdown(`**Error calling \`${toolName}\`**: ${message}`);
}

function formatZodError(err: z.ZodError, toolName: string): ToolResult {
  const issues = err.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `- \`${path}\`: ${i.message}`;
    })
    .join("\n");
  return errorMarkdown(`**Invalid input for \`${toolName}\`:**\n${issues}`);
}

function orDash(value: unknown): string {
  if (value === undefined || value === null) return "—";
  const s = typeof value === "string" ? value.trim() : String(value);
  if (s === "" || s === "-") return "—";
  return s;
}

function escapeMarkdownCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeMarkdownLink(s: string): string {
  return s.replace(/[[\]]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// list_selections
// ---------------------------------------------------------------------------

const ListSelectionsInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
  status: z
    .enum(["Open", "Selected", "Approved", "Rejected", "Complete", "All"])
    .optional()
    .describe("Filter by selection status. Default: All."),
});

async function listSelectionsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListSelectionsInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_selections");
  const { project_id, status } = parsed.data;

  try {
    const result = await (api.db ?? api).getSelections(project_id);
    let selections = result.selections;

    if (status && status !== "All") {
      selections = selections.filter((s) => s.status === status);
    }

    if (selections.length === 0) {
      const statusCount = result.statusCount;
      const total = Object.values(statusCount).reduce((a, b) => a + Number(b), 0);
      if (total === 0) {
        return markdown(`No selections found for project #${project_id}.`);
      }
      return markdown(
        `No selections matching status "${status}" for project #${project_id}. ` +
        `Total selections: ${total} (${Object.entries(statusCount).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k}=${v}`).join(", ")}).`,
      );
    }

    const header = `**${selections.length} selection${selections.length === 1 ? "" : "s"}** for project #${project_id}${status && status !== "All" ? ` (${status})` : ""}:`;

    const tableHeader = [
      "| ID | Status | Category | Location | Item | Price | Opened | Approved | Rejected | Due |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ].join("\n");

    const tableBody = selections
      .map((s) =>
        `| ${s.id} | ${s.status} | ${escapeMarkdownCell(orDash(s.category))} | ${escapeMarkdownCell(orDash(s.location))} | ${escapeMarkdownCell(orDash(s.item))} | ${orDash(s.price)} | ${orDash(s.createdAt)} | ${orDash(s.approvedDate)} | ${orDash(s.rejectedDate)} | ${orDash(s.dueDate)} |`,
      )
      .join("\n");

    return markdown(`${header}\n\n${tableHeader}\n${tableBody}`);
  } catch (err) {
    return formatError(err, "list_selections");
  }
}

export const listSelectionsTool: ToolDefinition = {
  name: "list_selections",
  description:
    "[v3 2026-06-12] List material/finish selections for a project. Shows status, budget category, location, item, price, AND lifecycle dates (opened/approved/rejected/due) — useful for aging and cycle-time analysis. Item column now carries the actual selection name (was previously bleeding Location/status badge text). Optionally filter by status (Open/Selected/Approved/Rejected/Complete).",
  inputSchema: zodToJsonSchema(ListSelectionsInputSchema),
  permission: "read",
  handler: listSelectionsHandler,
};

// ---------------------------------------------------------------------------
// get_selection
// ---------------------------------------------------------------------------

const GetSelectionInputSchema = z.object({
  selection_id: z.number().describe("BuildTools selection ID."),
  project_id: z.number().describe("BuildTools project ID."),
});

async function getSelectionHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = GetSelectionInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "get_selection");
  const { selection_id, project_id } = parsed.data;

  try {
    // Fetch detail and the parent selection name in parallel; the
    // `/selections/form/{id}?itemsData=1` JSON only carries the items,
    // not the parent. `getSelectionName` is best-effort — degrades to
    // null without blocking the rest of the render.
    const [detail, parentName] = await Promise.all([
      api.getSelectionDetail(selection_id, project_id),
      api.getSelectionName(selection_id, project_id),
    ]);
    if (!detail || detail.items.length === 0) {
      return markdown(`No detail found for selection #${selection_id} on project #${project_id}.`);
    }

    const formatUsd = (n: number | null): string =>
      n !== null
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
        : "—";

    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    // Best-effort label for the chosen option: title is often blank when
    // the option was created by entering only a description/vendor (e.g.
    // an "Actual Quote" line on a cabinet selection). Fall back to the
    // description, then vendor, then a generic placeholder.
    const optionLabel = (item: {
      title: string;
      description: string;
      companyName: string;
    }): string => {
      const t = item.title.trim();
      if (t) return t;
      const d = item.description.trim();
      if (d) return d;
      const c = item.companyName.trim();
      if (c) return c;
      return "(unnamed option)";
    };

    const lines: string[] = [];
    // Include the parent selection name in the H2 when available — that's
    // the field the user types into BuildTools' "name" input (e.g.
    // "Kitchen Cabinets", "Cabinet Hardware"). Omit the em-dash entirely
    // when the form didn't return a name so the heading stays clean.
    const header = parentName
      ? `## Selection #${selection_id} — ${parentName} (project #${project_id})\n`
      : `## Selection #${selection_id} (project #${project_id})\n`;
    lines.push(header);

    const selected = detail.items.find((i) => i.selected);
    const others = detail.items.filter((i) => !i.selected);

    if (selected) {
      lines.push(`### Selected: ${optionLabel(selected)}`);
      lines.push("");
      if (selected.description) lines.push(`- **Description**: ${selected.description}`);
      if (selected.model) lines.push(`- **Model**: ${selected.model}`);
      lines.push(`- **Price**: ${formatUsd(selected.price)}`);
      if (selected.companyName) lines.push(`- **Vendor**: ${selected.companyName}`);
      if (selected.url) lines.push(`- **Product link**: ${selected.url}`);

      if (selected.files.length > 0) {
        lines.push("");
        lines.push(`**Attached files** (${selected.files.length}):`);
        for (const f of selected.files) {
          lines.push(`- [${escapeMarkdownLink(f.name)}](${f.url}) (${formatSize(f.size)}, ${f.type}${f.isImage ? ", image" : ""})`);
        }
      }

      if (selected.subitems.length > 0) {
        lines.push("");
        lines.push(`**Sub-items** (${selected.subitems.length}):`);
        for (const s of selected.subitems) {
          lines.push(`- ${s.title ?? s.name ?? "(unnamed sub-item)"}`);
        }
      }
    }

    if (others.length > 0) {
      lines.push("");
      lines.push(`### Other options (${others.length})`);
      lines.push("");
      for (const item of others) {
        const pricePart = item.price !== null ? ` — ${formatUsd(item.price)}` : "";
        const filesPart = item.files.length > 0 ? ` (${item.files.length} file${item.files.length > 1 ? "s" : ""})` : "";
        const label = optionLabel(item);
        lines.push(`- **${label}**${pricePart}${filesPart}`);
        if (item.description && item.description !== item.title && item.description !== label) {
          lines.push(`  ${item.description}`);
        }
      }
    }

    return markdown(lines.join("\n"));
  } catch (err) {
    return formatError(err, "get_selection");
  }
}

export const getSelectionTool: ToolDefinition = {
  name: "get_selection",
  description:
    "[v2 2026-06-12] Get full detail for a selection including all options/choices, descriptions, models, vendor info, prices, and attached files (installation specs, PDFs, images). Header now includes the parent selection name (e.g. 'Kitchen Cabinets') and option labels fall back to description/vendor when the option title is blank. Requires both selection_id and project_id.",
  inputSchema: zodToJsonSchema(GetSelectionInputSchema),
  permission: "read",
  handler: getSelectionHandler,
};

// ---------------------------------------------------------------------------
// list_allowances
// ---------------------------------------------------------------------------

const ListAllowancesInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
});

async function listAllowancesHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListAllowancesInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_allowances");
  const { project_id } = parsed.data;

  try {
    // Get allowance categories from budget + selections for reconciliation
    const [allowances, selData] = await Promise.all([
      (api.db ?? api).getAllowances(project_id),
      (api.db ?? api).getSelections(project_id),
    ]);

    if (allowances.length === 0) {
      return markdown(`No allowance budget categories found for project #${project_id}.`);
    }

    // Group selections by category name (matching the allowance category)
    const selectionsByCategory: Record<string, typeof selData.selections> = {};
    for (const sel of selData.selections) {
      const cat = sel.category;
      if (!selectionsByCategory[cat]) selectionsByCategory[cat] = [];
      selectionsByCategory[cat].push(sel);
    }

    const parseCurrency = (s: string): number => {
      if (!s || s === "-") return 0;
      const n = Number(s.replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };

    const formatUsd = (n: number): string =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

    const lines: string[] = [];
    lines.push(`**${allowances.length} allowance${allowances.length === 1 ? "" : "s"}** for project #${project_id}:\n`);

    for (const a of allowances) {
      // For reconciliation we use the WORKING REVISED budget — that's the
      // current allowance after change orders. The PUBLISHED budget is what
      // the customer signed off on originally; we surface both.
      const budgeted = a.workingRevised;
      const catSelections = selectionsByCategory[a.name] ?? [];
      const spent = catSelections.reduce((sum, s) => sum + parseCurrency(s.price), 0);
      const remaining = budgeted - spent;

      lines.push(`### ${a.name}`);
      lines.push(`- **Published budget**: ${formatUsd(a.publishedBudget)}`);
      if (a.approvedCOs !== 0) {
        lines.push(`- **Approved COs**: ${formatUsd(a.approvedCOs)}`);
      }
      lines.push(`- **Revised budget**: ${formatUsd(budgeted)}`);
      lines.push(`- **Selected/Spent**: ${formatUsd(spent)}`);
      lines.push(`- **Remaining**: ${formatUsd(remaining)}${remaining < 0 ? " ⚠️ over budget" : ""}`);

      if (catSelections.length > 0) {
        lines.push(`- **Selections** (${catSelections.length}):`);
        for (const sel of catSelections) {
          // Date suffix: opened (always when known), then approved or
          // rejected when set. Omitted entirely when the replica
          // didn't return anything (so older logs / tests aren't broken).
          const dateParts: string[] = [];
          if (sel.createdAt) dateParts.push(`opened ${sel.createdAt}`);
          if (sel.approvedDate) dateParts.push(`approved ${sel.approvedDate}`);
          else if (sel.rejectedDate) dateParts.push(`rejected ${sel.rejectedDate}`);
          const dateSuffix = dateParts.length > 0 ? ` — ${dateParts.join(", ")}` : "";
          lines.push(`  - [${sel.status}] ${orDash(sel.item)} — ${orDash(sel.price)}${dateSuffix}`);
        }
      } else {
        lines.push(`- *No selections yet*`);
      }
      lines.push("");
    }

    return markdown(lines.join("\n"));
  } catch (err) {
    return formatError(err, "list_allowances");
  }
}

export const listAllowancesTool: ToolDefinition = {
  name: "list_allowances",
  description:
    "[v3 2026-06-12] List allowance budget categories for a project with reconciliation: budgeted amount, total spent on selections, and remaining balance. Each selection now shows its real name (previously rendered as 'Incomplete' / 'Pending' / location), price, and opened/approved dates when available.",
  inputSchema: zodToJsonSchema(ListAllowancesInputSchema),
  permission: "read",
  handler: listAllowancesHandler,
};

// ---------------------------------------------------------------------------
// list_selection_categories
// ---------------------------------------------------------------------------

const ListSelectionCategoriesInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
});

async function listSelectionCategoriesHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListSelectionCategoriesInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_selection_categories");
  const { project_id } = parsed.data;

  try {
    const categories = await api.getSelectionBudgetCategories(project_id);
    if (categories.length === 0) {
      return markdown(`No budget categories available for selections on project #${project_id}.`);
    }
    const header = `**${categories.length} budget categories** available for selections on project #${project_id}:\n`;
    const list = categories
      .map((c) => `- **${c.id}** — ${c.name}`)
      .join("\n");
    return markdown(`${header}\n${list}`);
  } catch (err) {
    return formatError(err, "list_selection_categories");
  }
}

export const listSelectionCategoriesTool: ToolDefinition = {
  name: "list_selection_categories",
  description:
    "List the budget categories available for creating selections on a project. Returns category IDs needed for create_selection.",
  inputSchema: zodToJsonSchema(ListSelectionCategoriesInputSchema),
  permission: "read",
  handler: listSelectionCategoriesHandler,
};

// ---------------------------------------------------------------------------
// export_selections — bulk CSV across many projects (MOS-329)
// ---------------------------------------------------------------------------

/**
 * Status filter inputs accept both the canonical name and the
 * "synonym/variant" form the user-facing dashboard uses
 * (e.g. "Selected/Pending" is what the UI shows for status code 2).
 * Normalised to the canonical name for filtering against
 * `selection.status`.
 */
const STATUS_FILTER_ALIASES: Record<string, string> = {
  "Open": "Open",
  "Open/Incomplete": "Open",
  "Selected": "Selected",
  "Selected/Pending": "Selected",
  "Approved": "Approved",
  "Rejected": "Rejected",
  "Complete": "Complete",
};

const ExportSelectionsInputSchema = z.object({
  project_ids: z
    .array(z.union([z.string(), z.number()]))
    .min(1)
    .describe(
      "List of BuildTools project IDs to export. Iterated server-side; one fetch per project, combined into a single CSV.",
    ),
  status_filter: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of statuses to include. Accepts canonical (Open|Selected|Approved|Rejected|Complete) or dashboard variants (Open/Incomplete|Selected/Pending). Default: all statuses.",
    ),
});

/** RFC-4180 quote a CSV cell when needed. */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** "$ 218.90" / "$218" / "" → "218.90" / "218" / "" (numeric form, no $/commas). */
function priceToNumeric(raw: string): string {
  if (!raw) return "";
  const m = raw.replace(/[,$\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(m)) return "";
  // Strip trailing ".00" — keep as-is; downstream consumers can format.
  return m;
}

async function exportSelectionsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ExportSelectionsInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "export_selections");
  const { project_ids, status_filter } = parsed.data;

  // Normalise status filter: dashboard variants → canonical names.
  let canonicalStatuses: Set<string> | null = null;
  if (status_filter && status_filter.length > 0) {
    canonicalStatuses = new Set();
    for (const raw of status_filter) {
      const canonical = STATUS_FILTER_ALIASES[raw];
      if (!canonical) {
        return errorMarkdown(
          `**Invalid status_filter value**: \`${raw}\`. Accepted: ${Object.keys(STATUS_FILTER_ALIASES).join(", ")}.`,
        );
      }
      canonicalStatuses.add(canonical);
    }
  }

  try {
    // ONE bulk fetch for project names; then per-project selections in parallel.
    const projectsResp = await (api.db ?? api).getProjects<{
      data?: Array<{ id: number | string; name?: string }>;
    }>({ length: 5000 });
    const nameById = new Map<string, string>();
    for (const row of projectsResp?.data ?? []) {
      nameById.set(String(row.id), String(row.name ?? ""));
    }

    const lines: string[] = [];
    lines.push(
      [
        "project_id",
        "project",
        "category",
        "location",
        "item",
        "status",
        "opened",
        "approved",
        "price",
      ].join(","),
    );

    let totalRows = 0;
    const errors: string[] = [];

    await Promise.all(
      project_ids.map(async (pid) => {
        const id = String(pid);
        const projectName = nameById.get(id) ?? "";
        try {
          const result = await (api.db ?? api).getSelections(id);
          for (const sel of result.selections) {
            if (canonicalStatuses && !canonicalStatuses.has(sel.status)) continue;
            lines.push(
              [
                csvCell(id),
                csvCell(projectName),
                csvCell(sel.category),
                csvCell(sel.location),
                csvCell(sel.item),
                csvCell(sel.status),
                csvCell(sel.createdAt ?? ""),
                csvCell(sel.approvedDate ?? ""),
                csvCell(priceToNumeric(sel.price)),
              ].join(","),
            );
            totalRows++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`project ${id}: ${msg}`);
        }
      }),
    );

    if (errors.length > 0) {
      // Append per-project errors as comment lines so the output stays a
      // single CSV blob; consumers that pipe to a parser can ignore lines
      // beginning with `#`.
      lines.push("");
      for (const e of errors) lines.push(`# ERROR ${e}`);
    }

    const summary =
      `# ${totalRows} selection row${totalRows === 1 ? "" : "s"} across ${project_ids.length} project${project_ids.length === 1 ? "" : "s"}` +
      (canonicalStatuses ? ` (filter: ${[...canonicalStatuses].join("|")})` : "");
    return markdown([summary, lines.join("\n")].join("\n"));
  } catch (err) {
    return formatError(err, "export_selections");
  }
}

export const exportSelectionsTool: ToolDefinition = {
  name: "export_selections",
  description:
    "[v2 2026-06-12] Bulk export selections across multiple projects as a single CSV. " +
    "Returns one row PER SELECTION LINE (flat — not nested under allowance categories) with columns " +
    "project_id, project, category, location, item, status, opened, approved, price. " +
    "Item column now carries the real selection name across all statuses (previously bled Location/status badge for Approved/Open/Selected rows). " +
    "Reuses the same parser as list_selections + list_allowances (incl. created_at / approved_date from the replica). " +
    "Optional status_filter accepts dashboard variants (e.g. 'Selected/Pending', 'Open/Incomplete').",
  inputSchema: zodToJsonSchema(ExportSelectionsInputSchema),
  permission: "read",
  handler: exportSelectionsHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const selectionTools: ToolDefinition[] = [
  listSelectionsTool,
  getSelectionTool,
  listAllowancesTool,
  listSelectionCategoriesTool,
  exportSelectionsTool,
];
