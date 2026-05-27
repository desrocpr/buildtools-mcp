/**
 * MCP read-only tools for BuildTools financial data (MOS-215, Phase 3.2).
 *
 * Four tools:
 *   - list_change_orders          — change orders for a single project (datatable).
 *   - get_change_order            — full detail for one change order by ID.
 *   - find_unbilled_change_orders — approved-but-not-yet-billed sweep across
 *                                   all projects, with optional min-amount /
 *                                   older-than-days filters.
 *   - get_financial_statement     — project financial statement (revenue +
 *                                   costs + margin) read via the form
 *                                   endpoint (datatable read is broken).
 *
 * Design notes:
 *
 *   - Mirrors `src/tools/projects.ts` (MOS-214): Zod-validated input,
 *     Markdown text response, `isError: true` content branch on
 *     `BuildToolsError`, never throws to the SDK. Empty / null results
 *     render as plain Markdown (no `isError`).
 *   - Schemas are authored against `zod/v3` (Zod 4 ships the v3 surface
 *     under that sub-export) so `zod-to-json-schema` keeps working — same
 *     pin as `projects.ts`.
 *   - Currency formatting goes through a single `formatUsd()` helper backed
 *     by `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`
 *     per the issue's "Notes for the harness".
 *   - The change-order status-label map is best-guess: fixtures show codes
 *     1 and 2, while the reference SQL impl uses code 3 for "Approved" — we
 *     include both interpretations and fall back to `String(code)` for any
 *     unknown wire value. Refine after live verification (MOS-222).
 *   - `find_unbilled_change_orders` is multi-project read. The reference
 *     `~/code/buildtools/find-unbilled-cos.js` uses raw MySQL which is not
 *     portable to MCP — the client method composes the datatable read and
 *     applies the heuristics in JS. The Linear issue's "multi-project
 *     financial rollups" out-of-scope item refers to write-side rollups, not
 *     this read sweep.
 *   - `get_financial_statement` reads through `/financial/statements/form?PR[]={id}`
 *     because the `/datatable` read is documented as broken.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Status mapping (best-guess pending live verification)
// ---------------------------------------------------------------------------

/**
 * Best-guess change-order status code → human label. Fixtures show codes 1
 * and 2; the reference `find-unbilled-cos.js` uses 3 to mean Approved. We
 * surface both interpretations and fall back to the raw value for unknowns.
 */
const CHANGE_ORDER_STATUS_LABELS: Record<number, string> = {
  1: "Draft",
  2: "Pending Approval",
  3: "Approved",
  4: "Rejected",
};

function changeOrderStatusLabel(code: string | number | undefined): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(num)) return String(code);
  return CHANGE_ORDER_STATUS_LABELS[num] ?? String(code);
}

// ---------------------------------------------------------------------------
// Financial statement status mapping — verified against BUSINESS_LOGIC.md
// ---------------------------------------------------------------------------

const FINANCIAL_STATEMENT_STATUS_LABELS: Record<number, string> = {
  1: "Draft",
  2: "Pending",
  4: "Partial",
  5: "Sent",
  6: "Paid",
};

function financialStatementStatusLabel(code: string | number | undefined): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(num)) return String(code);
  return FINANCIAL_STATEMENT_STATUS_LABELS[num] ?? String(code);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** Render a numeric value as USD; em-dash for non-finite input. */
function formatUsd(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return USD_FORMATTER.format(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) return USD_FORMATTER.format(n);
  }
  return "—";
}

/** Strip HTML tags + collapse whitespace; safe for null/undefined input. */
function stripHtml(input: unknown): string {
  if (input === undefined || input === null) return "";
  return String(input).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** Em-dash when value is empty / nullish / placeholder "-". */
function orDash(value: unknown): string {
  if (value === undefined || value === null) return "—";
  const s = typeof value === "string" ? value.trim() : String(value);
  if (s === "" || s === "-") return "—";
  return s;
}

/** Markdown response shorthand. */
function markdown(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Error Markdown response shorthand. */
function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Normalise unknown errors into a Markdown body. Distinguishes our own
 * `BuildToolsError` (caller-actionable) from anything else.
 */
function formatError(err: unknown, toolName: string): ToolResult {
  if (err instanceof BuildToolsError) {
    return errorMarkdown(
      `**Error calling \`${toolName}\`** (${err.name}): ${err.message}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorMarkdown(`**Error calling \`${toolName}\`**: ${message}`);
}

/** Pretty-print a Zod error as a bulleted list. */
function formatZodError(err: z.ZodError, toolName: string): ToolResult {
  const issues = err.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `- \`${path}\`: ${i.message}`;
    })
    .join("\n");
  return errorMarkdown(
    `**Invalid input for \`${toolName}\`:**\n${issues}`,
  );
}

/** Render a change-order datatable row as a single Markdown line. */
function formatChangeOrderRow(row: Record<string, unknown>): string {
  const id =
    (row.id as string | number | undefined) ??
    (row.DT_RowId as string | undefined) ??
    (row.info as string | number | undefined) ??
    "?";
  const status = changeOrderStatusLabel(row.status as string | number | undefined);
  const number = row.number !== undefined ? `#${row.number}` : "";
  const name = (row.name as string | undefined) ?? "(unnamed change order)";
  const total = orDash(row.total);
  const created = orDash(row.created_at);
  const trailer = number ? ` (${number})` : "";
  return `- #${id} [${status}] ${name}${trailer} — ${total} — created ${created}`;
}

// ---------------------------------------------------------------------------
// Shared envelopes
// ---------------------------------------------------------------------------

/** Minimal projection of a datatable envelope. */
interface ChangeOrdersDatatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

// ---------------------------------------------------------------------------
// list_change_orders
// ---------------------------------------------------------------------------

const ListChangeOrdersInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
});

export type ListChangeOrdersInput = z.infer<typeof ListChangeOrdersInputSchema>;

async function listChangeOrdersHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListChangeOrdersInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_change_orders");
  const { project_id } = parsed.data;

  try {
    // Filter the change-orders datatable to a single project. The actual
    // column index for project ID is not documented in the source, so we
    // pass the project ID as a free-text `search[value]` (best-effort —
    // refine after live verification). We also bump `length` to 200 to
    // surface more than a default page of results.
    const result = await api.getChangeOrders<ChangeOrdersDatatable>({
      "search[value]": String(project_id),
      length: 200,
    });
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      return markdown(`No change orders found for project #${project_id}.`);
    }
    const header = `**${rows.length} change order${rows.length === 1 ? "" : "s"}** for project #${project_id}:`;
    const body = rows.map(formatChangeOrderRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_change_orders");
  }
}

export const listChangeOrdersTool: ToolDefinition = {
  name: "list_change_orders",
  description:
    "List change orders for a BuildTools project. Returns CO number, status, amount, description.",
  inputSchema: zodToJsonSchema(ListChangeOrdersInputSchema),
  handler: listChangeOrdersHandler,
};

// ---------------------------------------------------------------------------
// get_change_order
// ---------------------------------------------------------------------------

const GetChangeOrderInputSchema = z.object({
  change_order_id: z.number().describe("BuildTools change-order ID."),
});

export type GetChangeOrderInput = z.infer<typeof GetChangeOrderInputSchema>;

/** Minimal projection of `/change-orders/:id/form`. */
interface ChangeOrderDetail {
  id?: string | number;
  name?: string;
  status?: string | number;
  number?: string | number;
  approved_number?: string | number | null;
  project_id?: string | number;
  project_name?: string;
  description?: string;
  total?: string;
  total_value?: number;
  current_amount?: string;
  invoiced_amount?: string;
  created_at?: string;
  email_status_label?: string;
  items?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

function formatChangeOrderDetail(co: ChangeOrderDetail): string {
  const id = co.id ?? "?";
  const name = co.name ?? "(unnamed change order)";
  const status = changeOrderStatusLabel(co.status);
  const billing = orDash(co.email_status_label ?? co.invoiced_amount);
  const total = co.total !== undefined ? orDash(co.total) : formatUsd(co.total_value);

  const lines: string[] = [];
  lines.push(`## Change Order #${id} — ${name}`);
  lines.push("");
  lines.push(`- **Status**: ${status}`);
  lines.push(`- **Number**: ${orDash(co.number)}`);
  lines.push(`- **Approved number**: ${orDash(co.approved_number ?? undefined)}`);
  lines.push(
    `- **Project**: ${co.project_name ? co.project_name + (co.project_id ? ` (#${co.project_id})` : "") : orDash(co.project_id ? `#${co.project_id}` : undefined)}`,
  );
  lines.push(`- **Amount**: ${total}`);
  lines.push(`- **Billing status**: ${billing}`);
  lines.push(`- **Created**: ${orDash(co.created_at)}`);

  if (co.description) {
    lines.push("");
    lines.push("### Description");
    lines.push("");
    lines.push(stripHtml(co.description));
  }

  const items = Array.isArray(co.items) ? co.items : [];
  if (items.length > 0) {
    lines.push("");
    lines.push("### Line items");
    lines.push("");
    for (const item of items) {
      const itemName = (item.name as string | undefined) ?? "(item)";
      const itemTotal = item.total ?? (item as { total_value?: number }).total_value;
      const category =
        (item.category as string | undefined) ??
        (item.budget_category_name as string | undefined) ??
        (item.budget_category_id !== undefined
          ? `category #${item.budget_category_id}`
          : undefined);
      const categorySuffix = category ? ` (${category})` : "";
      lines.push(`- ${itemName} — ${orDash(itemTotal)}${categorySuffix}`);
    }
  }

  return lines.join("\n");
}

async function getChangeOrderHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = GetChangeOrderInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "get_change_order");
  const { change_order_id } = parsed.data;

  try {
    const co = await api.getChangeOrder<ChangeOrderDetail>(change_order_id);
    if (!co) {
      return markdown(`No change order found with ID #${change_order_id}.`);
    }
    return markdown(formatChangeOrderDetail(co));
  } catch (err) {
    return formatError(err, "get_change_order");
  }
}

export const getChangeOrderTool: ToolDefinition = {
  name: "get_change_order",
  description:
    "Get full detail for a single change order by ID, including line items and current billing status.",
  inputSchema: zodToJsonSchema(GetChangeOrderInputSchema),
  handler: getChangeOrderHandler,
};

// ---------------------------------------------------------------------------
// find_unbilled_change_orders
// ---------------------------------------------------------------------------

const FindUnbilledChangeOrdersInputSchema = z.object({
  min_amount: z
    .number()
    .optional()
    .describe("Only include projects where the unbilled gap exceeds this dollar amount."),
});

export type FindUnbilledChangeOrdersInput = z.infer<
  typeof FindUnbilledChangeOrdersInputSchema
>;

async function findUnbilledChangeOrdersHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = FindUnbilledChangeOrdersInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return formatZodError(parsed.error, "find_unbilled_change_orders");
  }
  const { min_amount } = parsed.data;

  try {
    const matches = await api.findUnbilledChangeOrders({ min_amount });

    if (matches.length === 0) {
      const filterText = min_amount !== undefined ? ` (min ${formatUsd(min_amount)})` : "";
      return markdown(`No active projects with unbilled change orders found${filterText}.`);
    }

    const totalGap = matches.reduce(
      (sum, row) => sum + (typeof row.total_value === "number" ? row.total_value : 0),
      0,
    );

    const header = `**${matches.length} active project${matches.length === 1 ? "" : "s"}** with unbilled change orders — total gap ${formatUsd(totalGap)}`;

    const tableHeader = [
      "| ID | Project | Team | Revised Contract | Requested | Unbilled Gap |",
      "|---|---|---|---|---|---|",
    ].join("\n");

    const TEAM_LABELS: Record<number, string> = {
      5: "Nexus", 6: "Omega", 7: "Invicta", 8: "Alpha",
    };

    const tableBody = matches
      .map((row) => {
        const id = (row.id as string | number | undefined) ?? "?";
        const name = (row.name as string | undefined) ?? "—";
        const statusCode = typeof row.status === "number" ? row.status : Number(row.status);
        const team = TEAM_LABELS[statusCode] ?? String(row.status);
        const revised = formatUsd(row.budget_revised_value);
        const requested = formatUsd(row.requested_amount);
        const gap = formatUsd(row.unbilled_gap);
        return `| ${id} | ${name} | ${team} | ${revised} | ${requested} | ${gap} |`;
      })
      .join("\n");

    return markdown(`${header}\n\n${tableHeader}\n${tableBody}`);
  } catch (err) {
    return formatError(err, "find_unbilled_change_orders");
  }
}

export const findUnbilledChangeOrdersTool: ToolDefinition = {
  name: "find_unbilled_change_orders",
  description:
    "Find active projects (Nexus/Omega/Invicta/Alpha) where the revised contract exceeds total billing — the project-level 'unbilled gap'. Matches the logic in find-unbilled-cos.js.",
  inputSchema: zodToJsonSchema(FindUnbilledChangeOrdersInputSchema),
  handler: findUnbilledChangeOrdersHandler,
};

// ---------------------------------------------------------------------------
// get_financial_statement
// ---------------------------------------------------------------------------

const GetFinancialStatementInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
});

export type GetFinancialStatementInput = z.infer<
  typeof GetFinancialStatementInputSchema
>;

/** Minimal projection of a financial-statement payload. */
interface FinancialStatementDetail {
  id?: string | number;
  project_id?: string | number;
  name?: string;
  status?: string | number;
  current_amount?: string;
  current_amount_value?: number;
  /** Contract / revenue surface — different fields depending on the form view. */
  contract_value?: string | number;
  contract_amount?: string | number;
  revised_contract?: string | number;
  budget_revised?: string | number;
  total_revenue?: string | number;
  /** Cost surface. */
  costs?: string | number;
  total_costs?: string | number;
  cost_actual?: string | number;
  /** Margin surface (some payloads ship a precomputed value, others don't). */
  margin?: string | number;
  margin_value?: number;
  /** Billing + receivables. */
  amount_paid?: string;
  amount_unpaid?: string;
  aging_days?: string | number;
  payment_last?: string;
  due_date?: string;
  /** Catch-all for budget overview totals embedded in the form payload. */
  budgetOverviewTotals?: Record<string, unknown> | string;
  [k: string]: unknown;
}

/** Try a list of keys on an object; return the first defined value. */
function firstDefined(
  source: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const k of keys) {
    if (source[k] !== undefined && source[k] !== null && source[k] !== "") {
      return source[k];
    }
  }
  return undefined;
}

function formatFinancialStatement(
  statement: FinancialStatementDetail,
  projectId: number,
): string {
  // The data comes from budgetOverviewTotals (parsed from FS form HTML).
  // Fields are spread onto the statement object by getFinancialStatement().
  const bag = statement as Record<string, unknown>;

  const billingStatus = orDash(
    statement.status !== undefined
      ? financialStatementStatusLabel(statement.status)
      : undefined,
  );

  const name = statement.name ?? "Financial Overview";

  const lines: string[] = [];
  lines.push(`## ${name} (project #${projectId})`);
  lines.push("");

  const budgetFields: Array<[string, string[]]> = [
    ["Original contract", ["budget_total"]],
    ["Approved COs", ["approved_co_total", "change_orders_approved"]],
    ["Revised contract", ["budget_revised", "revised_contract"]],
    ["Current billing", ["financial_current_amount"]],
    ["Total costs", ["cost_actual", "costs", "total_costs"]],
    ["Gross margin", ["margin", "margin_value"]],
  ];

  for (const [label, keys] of budgetFields) {
    const val = firstDefined(bag, keys);
    lines.push(`- **${label}**: ${formatCurrencyOrDash(val)}`);
  }

  if (billingStatus !== "—") {
    lines.push(`- **Billing status**: ${billingStatus}`);
  }

  return lines.join("\n");
}

/** Coerce a number-ish value to a finite number, or undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Currency formatter that emits an em-dash on missing input. */
function formatCurrencyOrDash(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string" && value.trim() === "") return "—";
  return formatUsd(value);
}

async function getFinancialStatementHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = GetFinancialStatementInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return formatZodError(parsed.error, "get_financial_statement");
  }
  const { project_id } = parsed.data;

  try {
    const statement = await api.getFinancialStatement<FinancialStatementDetail>(
      project_id,
    );
    if (!statement) {
      return markdown(
        `No financial statement found for project #${project_id}.`,
      );
    }
    return markdown(formatFinancialStatement(statement, project_id));
  } catch (err) {
    return formatError(err, "get_financial_statement");
  }
}

export const getFinancialStatementTool: ToolDefinition = {
  name: "get_financial_statement",
  description:
    "Get the project-level financial overview: original contract, approved COs, revised contract, total billing, costs, and margin. For individual statement records, use list_financial_statements.",
  inputSchema: zodToJsonSchema(GetFinancialStatementInputSchema),
  handler: getFinancialStatementHandler,
};

// ---------------------------------------------------------------------------
// list_financial_statements
// ---------------------------------------------------------------------------

const ListFinancialStatementsInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
  status: z
    .enum(["Draft", "Pending", "Partial", "Sent", "Paid", "All"])
    .optional()
    .describe("Filter by statement status. Default: All."),
});

async function listFinancialStatementsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListFinancialStatementsInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return formatZodError(parsed.error, "list_financial_statements");
  }
  const { project_id, status } = parsed.data;

  try {
    const result = await api.getFinancialStatements(project_id);
    let statements = result.statements;

    if (status && status !== "All") {
      statements = statements.filter((s) => s.status === status);
    }

    if (statements.length === 0) {
      const total = Object.values(result.statusCount).reduce((a, b) => a + Number(b), 0);
      if (total === 0) {
        return markdown(`No financial statements found for project #${project_id}.`);
      }
      return markdown(
        `No statements matching status "${status}" for project #${project_id}. ` +
        `Total: ${total}.`,
      );
    }

    const totalAmount = statements.reduce((sum, s) => sum + s.amount, 0);
    const totalPaid = statements.reduce((sum, s) => sum + s.paid, 0);
    const totalBalance = statements.reduce((sum, s) => sum + s.balance, 0);

    const header = `**${statements.length} financial statement${statements.length === 1 ? "" : "s"}** for project #${project_id}${status && status !== "All" ? ` (${status})` : ""}:`;

    const summaryLine = `Totals: ${formatUsd(totalAmount)} billed, ${formatUsd(totalPaid)} paid, ${formatUsd(totalBalance)} outstanding`;

    const tableHeader = [
      "| ID | Status | Name | Amount | Paid | Balance | Date |",
      "|---|---|---|---|---|---|---|",
    ].join("\n");

    const tableBody = statements
      .map((s) =>
        `| ${s.id} | ${s.status} | ${s.name.substring(0, 50).replace(/\|/g, "\\|")} | ${formatUsd(s.amount)} | ${formatUsd(s.paid)} | ${formatUsd(s.balance)} | ${s.date || "—"} |`,
      )
      .join("\n");

    return markdown(`${header}\n\n${summaryLine}\n\n${tableHeader}\n${tableBody}`);
  } catch (err) {
    return formatError(err, "list_financial_statements");
  }
}

export const listFinancialStatementsTool: ToolDefinition = {
  name: "list_financial_statements",
  description:
    "List individual financial statements (draw requests / client bills) for a project. Shows ID, status, name, amount, paid, balance, and date. Optionally filter by status (Draft/Pending/Partial/Sent/Paid).",
  inputSchema: zodToJsonSchema(ListFinancialStatementsInputSchema),
  handler: listFinancialStatementsHandler,
};

// ---------------------------------------------------------------------------
// Exported registry — ORDER MATTERS (criterion 1).
// ---------------------------------------------------------------------------

export const financialTools: ToolDefinition[] = [
  listChangeOrdersTool,
  getChangeOrderTool,
  findUnbilledChangeOrdersTool,
  getFinancialStatementTool,
  listFinancialStatementsTool,
];
