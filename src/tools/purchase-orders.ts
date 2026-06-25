/**
 * MCP read-only tools for BuildTools purchase orders (MOS-292, Phase 3 expansion).
 *
 * Two tools:
 *   - list_purchase_orders   — paged datatable, optionally filtered by project name.
 *   - search_purchase_orders — free-text fuzzy match across PO rows.
 *
 * Design notes:
 *
 *   - Mirrors `src/tools/financial.ts` (MOS-215): Zod-validated input, Markdown
 *     text response, `isError: true` content branch on `BuildToolsError`,
 *     never throws to the SDK. Empty / null results render as plain Markdown
 *     (no `isError`). Helper functions (`stripHtml`, `orDash`, `markdown`,
 *     `errorMarkdown`, `formatError`, `formatZodError`) are duplicated locally
 *     per the established convention — see `financial.ts` for prior art.
 *   - Schemas are authored against `zod/v3` (Zod 4 ships the v3 surface under
 *     that sub-export) so `zod-to-json-schema` keeps working.
 *   - Currency fields (`total`, `invoiced_amount`, `difference`) ship as
 *     pre-formatted strings from the API (e.g. `"$ 3,855.46"`) — render via
 *     `orDash()` only, do not re-format.
 *   - `relations` may contain HTML span markup in live data even though the
 *     captured sample row shows plain text; apply `stripHtml()` defensively.
 *   - PO status codes are inferred from the change-order mapping
 *     (`BUSINESS_LOGIC.md` L59–65) because BUSINESS_LOGIC.md does NOT
 *     document PO statuses. Refine after live verification.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Status mapping (inferred — see file header)
// ---------------------------------------------------------------------------

// PO status constants live in BuildToolsAPI.ts (consumed by the
// lock-detection logic in `updatePurchaseOrder`). `purchase-orders.ts`
// only needs the labels for rendering datatable rows. Other consumers
// (mutations.ts, tests) import directly from BuildToolsAPI.ts to keep
// this file's public surface minimal.
import { PURCHASE_ORDER_STATUS_LABELS } from "../client/BuildToolsAPI.js";

function purchaseOrderStatusLabel(code: string | number | undefined): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  if (!Number.isFinite(num)) return String(code);
  return PURCHASE_ORDER_STATUS_LABELS[num] ?? String(code);
}

// ---------------------------------------------------------------------------
// Rendering helpers (duplicated locally per established convention; see
// `financial.ts` L100–160 for prior art)
// ---------------------------------------------------------------------------

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

/**
 * Escape Markdown emphasis / link / code-fence control characters so that
 * user-supplied strings (PO names, vendor names, item descriptions) can't
 * inject formatting into the LLM context.
 *
 * Scope: prose contexts (headings, list items, bold spans). For table
 * cells use `escapeMarkdownCell` — only `|`/`\n` break table layout, and
 * over-escaping inside cells produces noisy output.
 */
function escapeMarkdownInline(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s).replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
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

/** Render a purchase-order datatable row as a single Markdown line. */
function formatPurchaseOrderRow(row: Record<string, unknown>): string {
  // `info` is the canonical PO ID per the sample row (info: 37904 matches
  // DT_RowId: "row_37904"). Fall back to DT_RowId stripped of the "row_"
  // prefix, then `?`.
  const dtRowId =
    typeof row.DT_RowId === "string" ? row.DT_RowId.replace(/^row_/, "") : undefined;
  const id =
    (row.info as string | number | undefined) ??
    dtRowId ??
    "?";
  const status = purchaseOrderStatusLabel(row.status as string | number | undefined);
  const prefix = typeof row.prefix === "string" ? row.prefix.trim() : "";
  const number = row.number;
  let poNumber: string;
  if (number !== undefined && number !== null && String(number).trim() !== "") {
    poNumber = prefix ? `${prefix} ${number}` : String(number);
  } else {
    poNumber = "—";
  }
  const name = (row.name as string | undefined) ?? "(unnamed purchase order)";
  const company = orDash(row.company);
  const total = orDash(row.total);
  const invoiced = orDash(row.invoiced_amount);
  const difference = orDash(row.difference);
  const projectName = orDash(row.project_name);
  const created = orDash(row.created_at);
  const relations = stripHtml(row.relations);
  const relationsSuffix = relations ? ` — ${relations}` : "";
  return (
    `- #${id} [${status}] ${poNumber} ${name} — ${company} — ` +
    `${total} (invoiced ${invoiced}, diff ${difference}) — ` +
    `${projectName} — created ${created}${relationsSuffix}`
  );
}

// ---------------------------------------------------------------------------
// Shared envelope
// ---------------------------------------------------------------------------

/** Minimal projection of a datatable envelope. */
interface PurchaseOrdersDatatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

// ---------------------------------------------------------------------------
// list_purchase_orders
// ---------------------------------------------------------------------------

const ListPurchaseOrdersInputSchema = z.object({
  project_name: z
    .string()
    .optional()
    .describe(
      "Substring filter applied as the datatable's global free-text search.",
    ),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max purchase orders to return. Default 50."),
});

export type ListPurchaseOrdersInput = z.infer<typeof ListPurchaseOrdersInputSchema>;

async function listPurchaseOrdersHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListPurchaseOrdersInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "list_purchase_orders");
  const input = parsed.data;

  const limit = input.limit ?? 50;
  const params: Record<string, string | number> = { length: limit };
  if (input.project_name) {
    params["search[value]"] = input.project_name;
  }

  try {
    const result = await api.getPurchaseOrders<PurchaseOrdersDatatable>(params);
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      const filter = input.project_name
        ? ` matching project "${input.project_name}"`
        : "";
      return markdown(`No purchase orders matched${filter}.`);
    }
    const total = result?.recordsFiltered ?? result?.recordsTotal ?? rows.length;
    const filterLabel = input.project_name
      ? `, project filter: "${input.project_name}"`
      : "";
    const header = `**${rows.length} purchase order${rows.length === 1 ? "" : "s"}** (filtered ${total} total${filterLabel}):`;
    const body = rows.map(formatPurchaseOrderRow).join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "list_purchase_orders");
  }
}

export const listPurchaseOrdersTool: ToolDefinition = {
  name: "list_purchase_orders",
  description:
    "List BuildTools purchase orders. Optionally filter by project name (substring). Returns up to 50 by default.",
  inputSchema: zodToJsonSchema(ListPurchaseOrdersInputSchema),
  permission: "read",
  handler: listPurchaseOrdersHandler,
};

// ---------------------------------------------------------------------------
// search_purchase_orders
// ---------------------------------------------------------------------------

const SearchPurchaseOrdersInputSchema = z.object({
  query: z.string().min(2).describe("Search query."),
});

export type SearchPurchaseOrdersInput = z.infer<
  typeof SearchPurchaseOrdersInputSchema
>;

/** Maximum results surfaced by `search_purchase_orders`. */
const SEARCH_PURCHASE_ORDERS_LIMIT = 20;

async function searchPurchaseOrdersHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = SearchPurchaseOrdersInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "search_purchase_orders");
  const { query } = parsed.data;

  try {
    const result = await api.searchPurchaseOrders<PurchaseOrdersDatatable>(
      query,
      SEARCH_PURCHASE_ORDERS_LIMIT,
    );
    const rows = result?.data ?? [];
    if (rows.length === 0) {
      return markdown(`No purchase orders matched query "${query}".`);
    }
    const header = `**${rows.length} match${rows.length === 1 ? "" : "es"}** for "${query}":`;
    const body = rows
      .slice(0, SEARCH_PURCHASE_ORDERS_LIMIT)
      .map(formatPurchaseOrderRow)
      .join("\n");
    return markdown(`${header}\n\n${body}`);
  } catch (err) {
    return formatError(err, "search_purchase_orders");
  }
}

export const searchPurchaseOrdersTool: ToolDefinition = {
  name: "search_purchase_orders",
  description:
    "Free-text search across BuildTools purchase orders (matches PO number, name, company, project, relations).",
  inputSchema: zodToJsonSchema(SearchPurchaseOrdersInputSchema),
  permission: "read",
  handler: searchPurchaseOrdersHandler,
};

// ---------------------------------------------------------------------------
// get_purchase_order — single PO detail incl. company_id + line items
// ---------------------------------------------------------------------------

const GetPurchaseOrderInputSchema = z.object({
  purchase_order_id: z
    .number()
    .describe(
      "BuildTools purchase order ID (the `#` shown by list_purchase_orders / search_purchase_orders).",
    ),
});

type GetPurchaseOrderInput = z.infer<typeof GetPurchaseOrderInputSchema>;

/** USD formatter for line item totals. */
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

async function getPurchaseOrderHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = GetPurchaseOrderInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "get_purchase_order");
  const { purchase_order_id }: GetPurchaseOrderInput = parsed.data;

  try {
    const detail = await api.getPurchaseOrder(purchase_order_id);
    if (!detail) {
      return markdown(`No detail found for purchase order #${purchase_order_id}.`);
    }

    const lines: string[] = [];
    const poLabel =
      detail.prefix && detail.number
        ? `${detail.prefix} ${detail.number}`
        : detail.number || detail.prefix || "—";

    const header =
      `## Purchase Order #${detail.id}` +
      (detail.name ? ` — ${escapeMarkdownInline(detail.name)}` : "") +
      (detail.projectId !== null ? ` (project #${detail.projectId})` : "");
    lines.push(header);
    lines.push("");
    lines.push(`- **PO number**: ${poLabel}`);
    // Always emit a vendor line, even when both id and name are missing —
    // a silent omission would hide an HTML parse failure from the caller,
    // and downstream `create_purchase_order` would propagate a null
    // company_id without any indication something was wrong upstream.
    if (detail.companyId !== null) {
      lines.push(
        `- **Vendor**: ${escapeMarkdownInline(detail.companyName) || "—"} (company #${detail.companyId})`,
      );
    } else if (detail.companyName) {
      lines.push(`- **Vendor**: ${escapeMarkdownInline(detail.companyName)} _(no company_id parsed — extract before use)_`);
    } else {
      lines.push(`- **Vendor**: _(unknown — form parse failed)_`);
    }
    lines.push(`- **Line items**: ${detail.items.length}`);
    if (detail.totalNumeric > 0) {
      lines.push(`- **Total** (sum of items): ${usd.format(detail.totalNumeric)}`);
    }

    // Invoiced / unpaid summary — derived from `invoice_related` on each
    // line. BuildTools renders this as the dollar amount already linked
    // to an invoice; the remainder is unpaid. Best-effort numeric parse.
    const invoiced = detail.items.reduce(
      (acc, it) => acc + (Number(it.invoiceRelated) || 0),
      0,
    );
    if (invoiced > 0 || detail.totalNumeric > 0) {
      const unpaid = Math.max(0, detail.totalNumeric - invoiced);
      lines.push(
        `- **Invoiced**: ${usd.format(invoiced)} — **unpaid**: ${usd.format(unpaid)}`,
      );
    }

    if (detail.items.length > 0) {
      lines.push("");
      lines.push("### Line items");
      lines.push("");
      lines.push(
        "| # | Budget Code | Category | Qty | Unit | Total | Notes |",
      );
      lines.push("|---|---|---|---|---|---|---|");
      // Apply both inline-markdown and table-pipe escaping to user-supplied
      // strings (budget category name, notes). Inline escaping prevents an
      // adversarial note like "**SHIP IMMEDIATELY**" from bolding inside the
      // table cell and biasing the LLM downstream; pipe escaping keeps the
      // table layout intact.
      const cell = (s: string): string =>
        escapeMarkdownInline(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
      detail.items.forEach((it, i) => {
        const code = orDash(it.budgetCategoryCode);
        const cat = cell(it.budgetCategoryName || "—");
        // `amounts[]` typically has a single row `{a, q, d, u}`. Multiple
        // rows = breakdown of the same line. Summarise qty + unit price.
        const a0 = it.amounts[0] ?? {};
        const qty = orDash((a0 as { q?: unknown }).q);
        const unit = orDash((a0 as { a?: unknown }).a);
        const totalNum = Number(it.total);
        const totalStr = Number.isFinite(totalNum)
          ? usd.format(totalNum)
          : orDash(it.total);
        const notes = cell(
          [it.notes, it.internalNotes].filter(Boolean).join(" / ") || "—",
        );
        lines.push(
          `| ${i + 1} | ${code} | ${cat} | ${qty} | ${unit} | ${totalStr} | ${notes} |`,
        );
      });
    }

    return markdown(lines.join("\n"));
  } catch (err) {
    return formatError(err, "get_purchase_order");
  }
}

export const getPurchaseOrderTool: ToolDefinition = {
  name: "get_purchase_order",
  description:
    "[v1 2026-06-23] Get full detail for a single BuildTools purchase order: vendor (with company_id), project, PO number, line items (with budget category code + names, qty, unit, total, notes), and invoiced/unpaid summary. " +
    "Use this when you have a PO ID from list_purchase_orders / search_purchase_orders and need the structured company_id for downstream create_purchase_order or invoice flows. Read-only — no confirmation required.",
  inputSchema: zodToJsonSchema(GetPurchaseOrderInputSchema),
  permission: "read",
  handler: getPurchaseOrderHandler,
};

// ---------------------------------------------------------------------------
// Exported registry — ORDER MATTERS (criterion 2).
// ---------------------------------------------------------------------------

export const purchaseOrderTools: ToolDefinition[] = [
  listPurchaseOrdersTool,
  searchPurchaseOrdersTool,
  getPurchaseOrderTool,
];
