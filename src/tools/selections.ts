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
        `| ${s.id} | ${s.status} | ${orDash(s.category)} | ${orDash(s.location)} | ${orDash(s.item)} | ${orDash(s.price)} |`,
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
  handler: listSelectionsHandler,
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
      const budgeted = a.budgetedAmount || parseCurrency(a.revisedAmount);
      const catSelections = selectionsByCategory[a.name] ?? [];
      const spent = catSelections.reduce((sum, s) => sum + parseCurrency(s.price), 0);
      const remaining = budgeted - spent;

      lines.push(`### ${a.name}`);
      lines.push(`- **Budgeted**: ${formatUsd(budgeted)}`);
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
  handler: listAllowancesHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const selectionTools: ToolDefinition[] = [
  listSelectionsTool,
  listAllowancesTool,
];
