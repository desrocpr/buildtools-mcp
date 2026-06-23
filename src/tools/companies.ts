/**
 * MCP read-only tools for the BuildTools companies directory
 * (vendors + subcontractors + customers).
 *
 * Two tools:
 *   - search_companies — free-text search with optional role filter; the
 *                        same backing endpoint the "Add Vendor to PO" picker
 *                        uses (verified against live BuildTools).
 *   - get_company      — full row by ID. Optionally fetches the most recent
 *                        purchase order for the company so the caller has
 *                        the company_id → PO context in one round trip.
 *
 * Why these tools exist: `create_purchase_order` needs a numeric
 * `company_id`, but until now there was no way to resolve a vendor by
 * name. Other resources have search_* peers; companies were the gap.
 *
 * Field projection matches the live `/companies/datatable` response —
 * see `BuildToolsAPI.searchCompanies` for the verified shape.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Local helpers (duplicated per the convention established in financial.ts
// and purchase-orders.ts — keeps each tool file self-contained).
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

function stripHtml(input: unknown): string {
  if (input === undefined || input === null) return "";
  return String(input).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
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

/**
 * Escape Markdown control characters in user-controlled prose (headings,
 * list items, bold spans). Prevents an adversarial company name like
 * `**APPROVED** [click](http://evil)` from rendering as emphasis or a
 * link inside the LLM context. Use `escapeMarkdownCell` for table cells —
 * over-escaping table contents produces noisy output.
 */
function escapeMarkdownInline(s: unknown): string {
  if (s === undefined || s === null) return "";
  return String(s).replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

/** Apply both inline + cell escaping (for table cells with user content). */
function escapeTableCellContent(s: unknown): string {
  return escapeMarkdownInline(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Extract the numeric id off a BuildTools companies row. The companies
 * datatable carries the id only in `DT_RowId` (e.g. `"row_977"`) — there is
 * no top-level `id` field on that endpoint.
 */
function companyIdFromRow(row: Record<string, unknown>): string {
  const dt = typeof row.DT_RowId === "string" ? row.DT_RowId : "";
  return dt.replace(/^row_/, "") || "?";
}

/**
 * BuildTools renders the company's associated budget categories as a
 * comma-separated string inside a tooltip `<div>`. The first entry is the
 * UI's de-facto "default" — that's the one auto-selected when the company
 * is added to a new PO line item, and what the user-facing column on the
 * "Add Vendor to PO" picker shows. We stripHtml then take everything up to
 * the first comma.
 */
function defaultBudgetCategory(row: Record<string, unknown>): string {
  const raw = stripHtml(row.budget_relations);
  if (!raw) return "";
  const firstComma = raw.indexOf(",");
  return firstComma === -1 ? raw : raw.slice(0, firstComma).trim();
}

/** Comma-joined address for table display. */
function formatAddress(row: Record<string, unknown>): string {
  const parts: string[] = [];
  const street = typeof row.address === "string" ? row.address.trim() : "";
  if (street) parts.push(street);
  const city = typeof row.city === "string" ? row.city.trim() : "";
  const state = typeof row.state === "string" ? row.state.trim() : "";
  const zip = typeof row.zip === "string" ? row.zip.trim() : "";
  const tail = [city, state].filter(Boolean).join(", ");
  const tailWithZip = [tail, zip].filter(Boolean).join(" ");
  if (tailWithZip) parts.push(tailWithZip);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// search_companies
// ---------------------------------------------------------------------------

const SEARCH_COMPANIES_DEFAULT_LIMIT = 25;
const SEARCH_COMPANIES_MAX_LIMIT = 100;

const SearchCompaniesInputSchema = z.object({
  query: z
    .string()
    .min(2)
    .describe(
      "Free-text query. Matches name, contact, email, address, budget relations — the same fields the BuildTools UI's vendor picker searches.",
    ),
  role: z
    .enum(["Vendor", "Subcontractor", "Customer", "All"])
    .optional()
    .describe(
      "Optional role filter applied via the companies datatable's `type_name` column. Default: 'All' (no filter).",
    ),
  limit: z
    .number()
    .min(1)
    .max(SEARCH_COMPANIES_MAX_LIMIT)
    .optional()
    .describe(`Max rows. Default ${SEARCH_COMPANIES_DEFAULT_LIMIT}, max ${SEARCH_COMPANIES_MAX_LIMIT}.`),
});

type SearchCompaniesInput = z.infer<typeof SearchCompaniesInputSchema>;

interface CompaniesDatatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

async function searchCompaniesHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = SearchCompaniesInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "search_companies");
  const input: SearchCompaniesInput = parsed.data;

  const role = input.role && input.role !== "All" ? input.role : undefined;
  const limit = input.limit ?? SEARCH_COMPANIES_DEFAULT_LIMIT;

  try {
    const result = await api.searchCompanies<CompaniesDatatable>(input.query, {
      role,
      limit,
    });
    const rows = result?.data ?? [];
    // The user-supplied `input.query` echoes into the response body, so
    // escape it before interpolation. `role` is Zod-validated against a
    // closed enum and is safe verbatim.
    const safeQuery = escapeMarkdownInline(input.query);
    if (rows.length === 0) {
      const roleLabel = role ? ` (role=${role})` : "";
      return markdown(
        `No companies matched query "${safeQuery}"${roleLabel}.`,
      );
    }

    const total = result?.recordsFiltered ?? rows.length;
    const filterSuffix = role ? `, role=${role}` : "";
    const header =
      `**${rows.length} compan${rows.length === 1 ? "y" : "ies"}** ` +
      `(filtered ${total} total${filterSuffix}) for "${safeQuery}":`;

    const tableHeader = [
      "| ID | Name | Role | Default Budget Category | Phone | Email | Address | Last PO |",
      "|---|---|---|---|---|---|---|---|",
    ].join("\n");

    // The companies/datatable endpoint does NOT carry "Last PO" — that
    // would require a per-row PO lookup which is too expensive for a 25-
    // row search. `get_company` does the lookup on demand for a single id;
    // here we show "—" and link the caller to the detail tool.
    const tableBody = rows
      .map((row) => {
        const id = companyIdFromRow(row);
        const name = escapeTableCellContent(stripHtml(row.name));
        const roleName = orDash(row.type_name);
        const budgetCat = escapeTableCellContent(
          defaultBudgetCategory(row) || "—",
        );
        // Phone and email also pass through `escapeTableCellContent` —
        // a malformed address book entry like `it|support@example.com`
        // would break the table layout otherwise, and `[link](javascript:)`
        // in an unescaped field could render as a markdown link.
        const phone = escapeTableCellContent(orDash(row.phone));
        const email = escapeTableCellContent(orDash(row.email));
        const addr = escapeTableCellContent(formatAddress(row) || "—");
        return `| ${id} | ${name} | ${roleName} | ${budgetCat} | ${phone} | ${email} | ${addr} | — |`;
      })
      .join("\n");

    const footer =
      rows.length < total
        ? `\n\n_Showing ${rows.length} of ${total}. Increase \`limit\` (max ${SEARCH_COMPANIES_MAX_LIMIT}) to widen, or narrow the query._`
        : "";

    return markdown(
      `${header}\n\n${tableHeader}\n${tableBody}${footer}`,
    );
  } catch (err) {
    return formatError(err, "search_companies");
  }
}

export const searchCompaniesTool: ToolDefinition = {
  name: "search_companies",
  description:
    "[v1 2026-06-23] Search the BuildTools companies/vendors directory by name, contact, email, address, or budget relations. " +
    "Returns the same field projection as the 'Add Vendor to PO' picker. " +
    "Optional `role` filter narrows to Vendor, Subcontractor, or Customer. " +
    "Read-only — no confirmation required.",
  inputSchema: zodToJsonSchema(SearchCompaniesInputSchema),
  permission: "read",
  handler: searchCompaniesHandler,
};

// ---------------------------------------------------------------------------
// get_company
// ---------------------------------------------------------------------------

const GetCompanyInputSchema = z.object({
  company_id: z.number().describe("BuildTools company ID."),
});

type GetCompanyInput = z.infer<typeof GetCompanyInputSchema>;

interface CompanyRow {
  DT_RowId?: string;
  name?: string;
  type_name?: string;
  status?: string;
  main_contact?: string;
  email?: string;
  phone?: string;
  address?: string;
  zip?: string;
  city?: string;
  state?: string;
  country?: string;
  rating?: number;
  budget_relations?: string;
  created_at?: string;
}

interface PurchaseOrdersDatatable {
  data?: Array<Record<string, unknown>>;
  recordsTotal?: number;
  recordsFiltered?: number;
}

async function getCompanyHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = GetCompanyInputSchema.safeParse(args ?? {});
  if (!parsed.success) return formatZodError(parsed.error, "get_company");
  const { company_id }: GetCompanyInput = parsed.data;

  try {
    const row = (await api.getCompany<CompanyRow>(company_id)) ?? null;
    if (!row) {
      return markdown(`No company found for ID **${company_id}**.`);
    }

    // Fetch the company's most recent PO history. Best-effort: if the PO
    // datatable is unreachable or empty, we still render the company body.
    let poHistory: { count: number; total: number; mostRecent?: Record<string, unknown> } = {
      count: 0,
      total: 0,
    };
    try {
      // BuildTools' global search tokenises on whitespace; legal suffixes
      // like ", LLC" / ", Inc." defeat a verbatim query. Strip ONLY a
      // trailing legal-suffix token — not any comma/paren/ampersand —
      // so we don't turn "L&W Supply" into "L" or "Smith & Sons (DC)"
      // into "Smith". Then exact-match the FULL company name in the
      // returned rows to filter out incidental hits (POs whose project
      // name contains the same word).
      const fullName = String(row.name ?? "").trim();
      const searchKey =
        fullName
          .replace(/,?\s+(LLC|L\.?L\.?C\.?|Inc\.?|Corp\.?|Ltd\.?|Co\.?)\b.*$/i, "")
          .trim() || fullName;
      const poResp = await api.searchPurchaseOrders<PurchaseOrdersDatatable>(
        searchKey,
        50,
      );
      const poRows = (poResp?.data ?? []).filter((r) => {
        return String(r.company ?? "").trim() === fullName;
      });
      const total = poRows.reduce((acc, r) => {
        const raw = String(r.total ?? "").replace(/[$,\s]/g, "");
        const n = Number(raw);
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);
      poHistory = {
        count: poRows.length,
        total,
        mostRecent: poRows[0],
      };
    } catch {
      // Silently degrade — surface the company body even if PO lookup fails.
    }

    const lines: string[] = [];
    // Every user-controlled field goes through `escapeMarkdownInline` so
    // adversarial values (`**APPROVED**`, `[click](http://evil)`) can't
    // bias the LLM by rendering as emphasis or links. BuildTools doesn't
    // sanitize stored values; assume any text field is untrusted.
    lines.push(`## Company #${company_id} — ${escapeMarkdownInline(stripHtml(row.name))}`);
    lines.push("");
    lines.push(`- **Role**: ${escapeMarkdownInline(orDash(row.type_name))}`);
    lines.push(`- **Status**: ${escapeMarkdownInline(orDash(row.status))}`);
    if (row.main_contact) lines.push(`- **Primary contact**: ${escapeMarkdownInline(row.main_contact)}`);
    if (row.phone) lines.push(`- **Phone**: ${escapeMarkdownInline(row.phone)}`);
    if (row.email) lines.push(`- **Email**: ${escapeMarkdownInline(row.email)}`);
    const addr = formatAddress(row as Record<string, unknown>);
    if (addr) lines.push(`- **Address**: ${escapeMarkdownInline(addr)}`);
    if (row.country) lines.push(`- **Country**: ${escapeMarkdownInline(row.country)}`);
    if (row.created_at) lines.push(`- **Added**: ${escapeMarkdownInline(row.created_at)}`);
    if (typeof row.rating === "number" && row.rating > 0) {
      lines.push(`- **Rating**: ${row.rating}`);
    }

    const defaultCat = defaultBudgetCategory(row as Record<string, unknown>);
    if (defaultCat) {
      lines.push(`- **Default budget category**: ${escapeMarkdownInline(defaultCat)}`);
    }

    // Full budget category list. BuildTools renders these as a single
    // comma-separated string, and individual category descriptions can
    // themselves contain commas (e.g. "5530 HVAC Subcontractor - HVAC,
    // heat pump, furnace…"), so we render the raw list as one paragraph
    // rather than splitting — the comma-IN-description ambiguity is not
    // unwinnable client-side.
    const allCats = stripHtml(row.budget_relations);
    if (allCats && allCats !== defaultCat) {
      lines.push("");
      lines.push(`**All associated budget categories**: ${escapeMarkdownInline(allCats)}`);
    }

    lines.push("");
    lines.push(
      `**Purchase order history**: ${poHistory.count} PO${poHistory.count === 1 ? "" : "s"}` +
        (poHistory.count > 0
          ? ` totalling $${poHistory.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : ""),
    );
    if (poHistory.mostRecent) {
      const mr = poHistory.mostRecent;
      const poId =
        (mr.info as string | number | undefined) ??
        (typeof mr.DT_RowId === "string"
          ? mr.DT_RowId.replace(/^row_/, "")
          : "?");
      const poName = escapeMarkdownInline(stripHtml(mr.name));
      const poTotal = escapeMarkdownInline(orDash(mr.total));
      const poProject = escapeMarkdownInline(orDash(mr.project_name));
      const poCreated = orDash(mr.created_at);
      lines.push(
        `- Most recent: PO #${poId} **${poName}** — ${poProject} — ${poTotal} (created ${poCreated})`,
      );
    }

    return markdown(lines.join("\n"));
  } catch (err) {
    return formatError(err, "get_company");
  }
}

export const getCompanyTool: ToolDefinition = {
  name: "get_company",
  description:
    "[v1 2026-06-23] Get full BuildTools company detail by ID: role, contact, address, all associated budget categories (with the default highlighted), and purchase-order history summary (count + total + most-recent). " +
    "Read-only — no confirmation required.",
  inputSchema: zodToJsonSchema(GetCompanyInputSchema),
  permission: "read",
  handler: getCompanyHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const companyTools: ToolDefinition[] = [
  searchCompaniesTool,
  getCompanyTool,
];
