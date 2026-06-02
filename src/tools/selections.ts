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
    const result = await api.getSelections(project_id);
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
      "| ID | Status | Category | Location | Item | Price |",
      "|---|---|---|---|---|---|",
    ].join("\n");

    const tableBody = selections
      .map((s) =>
        `| ${s.id} | ${s.status} | ${escapeMarkdownCell(orDash(s.category))} | ${escapeMarkdownCell(orDash(s.location))} | ${escapeMarkdownCell(orDash(s.item))} | ${orDash(s.price)} |`,
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
    "List material/finish selections for a project. Shows status, budget category, location, item, and price. Optionally filter by status (Open/Selected/Approved/Rejected/Complete).",
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
    const detail = await api.getSelectionDetail(selection_id, project_id);
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

    const lines: string[] = [];
    lines.push(`## Selection #${selection_id} (project #${project_id})\n`);

    const selected = detail.items.find((i) => i.selected);
    const others = detail.items.filter((i) => !i.selected);

    if (selected) {
      lines.push(`### Selected: ${selected.title}`);
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
        lines.push(`- **${item.title}**${pricePart}${filesPart}`);
        if (item.description && item.description !== item.title) {
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
    "Get full detail for a selection including all options/choices, descriptions, models, vendor info, prices, and attached files (installation specs, PDFs, images). Requires both selection_id and project_id.",
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
      api.getAllowances(project_id),
      api.getSelections(project_id),
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
          lines.push(`  - [${sel.status}] ${orDash(sel.item)} — ${orDash(sel.price)}`);
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
    "List allowance budget categories for a project with reconciliation: budgeted amount, total spent on selections, and remaining balance. Shows each selection item under its allowance category.",
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
// Exported registry
// ---------------------------------------------------------------------------

export const selectionTools: ToolDefinition[] = [
  listSelectionsTool,
  getSelectionTool,
  listAllowancesTool,
  listSelectionCategoriesTool,
];
