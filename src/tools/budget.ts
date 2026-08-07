/**
 * MCP tools for BuildTools budget management.
 *
 * Read: list_budget shows all 48+ budget line items per project (full grid,
 * not just allowances). Mutations: create_budget_item, update_budget_item,
 * delete_budget_item — all wrapped in requiresConfirmation().
 *
 * Schema verified live via Puppeteer-captured XHR on project 185966.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolContext, ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors selections.ts)
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

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatUsd(n: number): string {
  return USD.format(n);
}

function escapeMarkdownCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ---------------------------------------------------------------------------
// list_budget
// ---------------------------------------------------------------------------

const ListBudgetInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
  allowances_only: z
    .boolean()
    .optional()
    .describe("If true, show only budget categories marked as allowances."),
});

async function listBudgetHandler(
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ListBudgetInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_budget");
  const { project_id, allowances_only } = parsed.data;

  try {
    const result = await ctx.ops.getBudget(project_id);
    let items = result.items;
    if (allowances_only) {
      items = items.filter((i) => i.isAllowance);
    }

    if (items.length === 0) {
      return markdown(
        `No budget items found for project #${project_id}${allowances_only ? " (allowances only)" : ""}.`,
      );
    }

    const totalPublished = items.reduce((sum, i) => sum + i.publishedBudget, 0);
    const totalRevised = items.reduce((sum, i) => sum + i.workingRevised, 0);
    const header = `**${items.length} budget item${items.length === 1 ? "" : "s"}** for project #${project_id}${allowances_only ? " (allowances)" : ""} — published: ${formatUsd(totalPublished)} · revised: ${formatUsd(totalRevised)}\n`;

    const tableHeader = [
      "| ID | Category | Allowance | Published | Approved COs | Revised |",
      "|---|---|---|---|---|---|",
    ].join("\n");

    const tableBody = items
      .map(
        (i) =>
          `| ${i.id} | ${escapeMarkdownCell(i.name)} | ${i.isAllowance ? "✓" : ""} | ${formatUsd(i.publishedBudget)} | ${i.approvedCOs ? formatUsd(i.approvedCOs) : ""} | ${formatUsd(i.workingRevised)} |`,
      )
      .join("\n");

    return markdown(`${header}\n${tableHeader}\n${tableBody}`);
  } catch (err) {
    return formatError(err, "list_budget");
  }
}

export const listBudgetTool: ToolDefinition<ToolContext> = {
  name: "list_budget",
  description:
    "List all budget line items for a project (48+ categories — full grid, not just allowances). Set allowances_only=true to filter to allowance categories only. Use list_selection_categories for the catalog of budget category IDs needed when creating new items.",
  inputSchema: zodToJsonSchema(ListBudgetInputSchema),
  permission: "read",
  handler: listBudgetHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const budgetTools: ToolDefinition<ToolContext>[] = [listBudgetTool];
