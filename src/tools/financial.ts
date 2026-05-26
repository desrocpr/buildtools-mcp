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
    .describe("Filter to COs over this dollar amount."),
  older_than_days: z
    .number()
    .optional()
    .describe(
      "Only COs approved more than this many days ago (uses created_at as a proxy — BuildTools does not surface a dedicated approved-at timestamp).",
    ),
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
  const { min_amount, older_than_days } = parsed.data;

  try {
    const matches = await api.findUnbilledChangeOrders({
      min_amount,
      older_than_days,
    });

    if (matches.length === 0) {
      const filterDesc: string[] = [];
      if (min_amount !== undefined) filterDesc.push(`min ${formatUsd(min_amount)}`);
      if (older_than_days !== undefined) {
        filterDesc.push(`older than ${older_than_days} days`);
      }
      const filterText =
        filterDesc.length > 0 ? ` (filters: ${filterDesc.join(", ")})` : "";
      return markdown(`No unbilled change orders found${filterText}.`);
    }

    const totalAmount = matches.reduce(
      (sum, row) => sum + (typeof row.total_value === "number" ? row.total_value : 0),
      0,
    );

    const headerBits: string[] = [];
    headerBits.push(
      `**${matches.length} unbilled change order${matches.length === 1 ? "" : "s"}**`,
    );
    headerBits.push(`total ${formatUsd(totalAmount)}`);
    if (min_amount !== undefined) {
      headerBits.push(`min ${formatUsd(min_amount)}`);
    }
    if (older_than_days !== undefined) {
      headerBits.push(`older than ${older_than_days} days`);
    }
    const header = headerBits.join(" — ");

    const tableHeader = [
      "| # | CO | Project | Status | Amount | Created |",
      "|---|---|---|---|---|---|",
    ].join("\n");
    const tableBody = matches
      .map((row) => {
        const id =
          (row.id as string | number | undefined) ??
          (row.info as string | number | undefined) ??
          (row.DT_RowId as string | undefined) ??
          "?";
        const number = row.number !== undefined ? `#${row.number}` : "—";
        const project =
          (row.project_name as string | undefined) ??
          (row.project_id !== undefined ? `#${row.project_id}` : "—");
        const status = changeOrderStatusLabel(
          row.status as string | number | undefined,
        );
        const amount = formatUsd(row.total_value);
        const created = orDash(row.created_at);
        return `| ${id} | ${number} | ${project} | ${status} | ${amount} | ${created} |`;
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
    "Find all change orders across all projects that are approved but not yet billed. High-value for accounting cleanup.",
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
  // BuildTools' form payload sometimes ships a JSON blob under
  // `budgetOverviewTotals` (form HTML) — try to surface anything useful from
  // it as a fallback when top-level keys aren't present.
  let overviewBag: Record<string, unknown> = {};
  if (
    statement.budgetOverviewTotals &&
    typeof statement.budgetOverviewTotals === "object"
  ) {
    overviewBag = statement.budgetOverviewTotals as Record<string, unknown>;
  } else if (typeof statement.budgetOverviewTotals === "string") {
    try {
      overviewBag = JSON.parse(statement.budgetOverviewTotals);
    } catch {
      overviewBag = {};
    }
  }

  const contractValue =
    firstDefined(statement as Record<string, unknown>, [
      "contract_value",
      "contract_amount",
      "revised_contract",
      "budget_revised",
      "total_revenue",
    ]) ??
    firstDefined(overviewBag, [
      "contract_value",
      "contract_amount",
      "revised_contract",
      "budget_revised",
      "total_revenue",
    ]);

  const costs =
    firstDefined(statement as Record<string, unknown>, [
      "costs",
      "total_costs",
      "cost_actual",
    ]) ??
    firstDefined(overviewBag, ["costs", "total_costs", "cost_actual"]);

  let margin: unknown =
    firstDefined(statement as Record<string, unknown>, [
      "margin",
      "margin_value",
    ]) ?? firstDefined(overviewBag, ["margin", "margin_value"]);

  // If we have both contract and costs but no precomputed margin, derive it.
  if (margin === undefined) {
    const contractNum = toNumber(contractValue);
    const costsNum = toNumber(costs);
    if (contractNum !== undefined && costsNum !== undefined) {
      margin = contractNum - costsNum;
    }
  }

  const billingStatus = orDash(
    statement.email_status_label ??
      statement.status_label ??
      (statement.status !== undefined ? `Status code ${statement.status}` : undefined),
  );

  const outstanding =
    firstDefined(statement as Record<string, unknown>, [
      "amount_unpaid",
      "outstanding_receivables",
    ]) ?? firstDefined(overviewBag, ["amount_unpaid", "outstanding_receivables"]);

  const id = statement.id ?? "—";
  const name = statement.name ?? "Financial Statement";

  const lines: string[] = [];
  lines.push(
    `## Financial Statement #${id} — ${name} (project #${projectId})`,
  );
  lines.push("");
  lines.push(`- **Contract value**: ${formatCurrencyOrDash(contractValue)}`);
  lines.push(`- **Costs**: ${formatCurrencyOrDash(costs)}`);
  lines.push(`- **Margin**: ${formatCurrencyOrDash(margin)}`);
  lines.push(`- **Billing status**: ${billingStatus}`);
  lines.push(
    `- **Outstanding receivables**: ${formatCurrencyOrDash(outstanding)}`,
  );
  if (statement.amount_paid !== undefined) {
    lines.push(`- **Amount paid to date**: ${orDash(statement.amount_paid)}`);
  }
  if (statement.due_date !== undefined) {
    lines.push(`- **Due date**: ${orDash(statement.due_date)}`);
  }
  if (statement.payment_last !== undefined) {
    lines.push(`- **Last payment**: ${orDash(statement.payment_last)}`);
  }
  if (statement.aging_days !== undefined) {
    lines.push(`- **Aging days**: ${orDash(statement.aging_days)}`);
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
    "Get the financial statement (revenue + costs + margin) for a single project.",
  inputSchema: zodToJsonSchema(GetFinancialStatementInputSchema),
  handler: getFinancialStatementHandler,
};

// ---------------------------------------------------------------------------
// Exported registry — ORDER MATTERS (criterion 1).
// ---------------------------------------------------------------------------

export const financialTools: ToolDefinition[] = [
  listChangeOrdersTool,
  getChangeOrderTool,
  findUnbilledChangeOrdersTool,
  getFinancialStatementTool,
];
