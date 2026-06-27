/**
 * MCP mutation tools for BuildTools (Phase 5).
 *
 * Every mutation is wrapped in `requiresConfirmation()` — the two-step
 * confirmation handshake from Phase 4. First call returns a prompt with
 * a confirmation token; second call with the token executes the mutation.
 *
 * Required fields and form conventions are verified against
 * ~/code/buildtools/api-client.js and ~/code/buildtools/api-test-results.md.
 */

import { createHash } from "node:crypto";

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import {
  PURCHASE_ORDER_STATUS_CODES,
  PURCHASE_ORDER_STATUS_LABELS,
  PURCHASE_ORDER_WRITE_LOCKED_STATUSES,
  formatPurchaseOrderLockError,
} from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";
import { requiresConfirmation, type ConfirmationStore } from "../confirm/index.js";
import {
  IdempotencyStore,
  checkIdempotency,
  storeIdempotencyResult,
} from "../idempotency/index.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

/**
 * Resolve `status` (number | label) → numeric code; `undefined` passthrough.
 * Throws on unknown string labels — Zod blocks them at the schema layer,
 * but internal callers constructing args in code (tests, future
 * auto-transition logic) bypass schema validation and would otherwise
 * silently drop the status from the POST payload.
 */
function resolvePoStatusCode(s: number | string | undefined): number | undefined {
  if (s === undefined) return undefined;
  if (typeof s === "number") {
    // PR #64 review fix (MEDIUM): validate numeric codes against the
    // known enum. Without this guard `status: 999` passes through to
    // BT's POST and the server's behavior on unknown codes is
    // undocumented — could silently no-op or trigger undefined
    // transitions. Tighten at the boundary.
    const known = new Set(Object.values(PURCHASE_ORDER_STATUS_CODES));
    if (!known.has(s)) {
      throw new Error(
        `Unknown PO status code ${s}. Expected one of: ${[...known].sort().join(", ")}.`,
      );
    }
    return s;
  }
  const code = PURCHASE_ORDER_STATUS_CODES[s];
  if (code === undefined) {
    throw new Error(
      `Unknown PO status label "${s}". Expected one of: ${Object.keys(PURCHASE_ORDER_STATUS_CODES).join(", ")}.`,
    );
  }
  return code;
}

/** Render a status code as its canonical label (or fall back to "code N"). */
function poStatusLabel(code: number | undefined): string {
  if (code === undefined) return "—";
  return PURCHASE_ORDER_STATUS_LABELS[code] ?? `code ${code}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
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

/**
 * Escape Markdown control characters in user-controlled prose so values
 * stored on BuildTools (company names, PO names, descriptions) can't
 * inject formatting into the LLM context when they echo back in error
 * messages or confirmation prompts. See `companies.ts` for matching impl.
 */
function escapeMarkdownInline(s: unknown): string {
  if (s === undefined || s === null) return "";
  // PR #63 security fix: include \n and \r in the escape set so
  // BT-sourced data (vendor names, PO names, error fragments) can't
  // break out of their markdown row and inject instructions into the
  // LLM context. Newlines are replaced with a literal space — escaping
  // them via backslash would render as a hard line break in some
  // markdown viewers, which still leaks the breakout.
  return String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

/**
 * Strip common trailing legal suffixes (`, LLC`, `, Inc`, `, Corp`, etc.)
 * so the BuildTools datatable tokenizer matches on the core name.
 * Verbatim queries like "Smith, LLC" return zero hits because BT splits
 * on whitespace and the comma kills the match.
 */
function stripLegalSuffix(name: string): string {
  return name
    .replace(/,?\s+(LLC|L\.?L\.?C\.?|Inc\.?|Corp\.?|Ltd\.?|Co\.?)\b.*$/i, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateProjectSchema = z.object({
  name: z.string().describe("Project name (e.g. 'Smith 1 Addition')."),
  status: z
    .number()
    .optional()
    .describe("Project status code. Default: 6 (Omega team). Active teams: 5=Nexus, 6=Omega, 7=Invicta, 8=Alpha."),
  project_manager_id: z
    .union([z.number(), z.string()])
    .describe("Employee ID for the project manager (required)."),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  description: z.string().optional(),
  confirmation_id: z.string().optional(),
});
type CreateProjectArgs = z.infer<typeof CreateProjectSchema>;

const CreateChangeOrderSchema = z.object({
  name: z.string().describe("Change order name (e.g. 'Smith - Bathroom Tile Upgrade')."),
  project_id: z.number().describe("BuildTools project ID."),
  total: z.number().optional().describe("Total dollar amount (used if items not provided)."),
  description: z.string().optional(),
  items: z
    .array(z.object({
      name: z.string(),
      total: z.number(),
      budget_category_id: z.number().optional(),
    }))
    .optional()
    .describe("Line items. If omitted, a single item is created from the total."),
  confirmation_id: z.string().optional(),
});
type CreateChangeOrderArgs = z.infer<typeof CreateChangeOrderSchema>;

const CreatePurchaseOrderSchema = z
  .object({
    name: z.string().describe("Purchase order name."),
    project_id: z.number().describe("BuildTools project ID."),
    company_id: z
      .number()
      .optional()
      .describe(
        "Vendor/subcontractor company ID. Provide either `company_id` or `company_name` — if both are present, `company_id` wins.",
      ),
    company_name: z
      .string()
      .optional()
      .describe(
        "Vendor/subcontractor name. Resolved server-side via fuzzy match against the companies directory. If zero or multiple matches, returns an error with the candidate list. Provide either `company_id` or `company_name`.",
      ),
    total: z.number().optional().describe("Total dollar amount (used if items not provided)."),
    prefix: z.string().optional().describe("PO number prefix. Default: 'PO'."),
    notes: z.string().optional(),
    items: z
      .array(z.object({ name: z.string(), total: z.number() }))
      .optional(),
    confirmation_id: z.string().optional(),
  })
  .refine((d) => d.company_id !== undefined || d.company_name !== undefined, {
    message: "Provide either `company_id` or `company_name`.",
    path: ["company_id"],
  });
type CreatePurchaseOrderArgs = z.infer<typeof CreatePurchaseOrderSchema>;

const UpdatePurchaseOrderItemSchema = z.object({
  // Caller passes EXACTLY ONE of these three. budget_category_id (the
  // catalog id BT actually wants) is the most precise; budget_code
  // ("7051") is the most ergonomic for humans; budget_item_id is what
  // list_budget surfaces in its "ID" column and trips up callers who
  // assume it's the category id.
  budget_category_id: z
    .number()
    .optional()
    .describe(
      "Catalog category ID (e.g. 1680 for Countertops Allowance). Get from `list_selection_categories` or the underlying budget data. Mutually exclusive with budget_item_id and budget_code.",
    ),
  budget_item_id: z
    .number()
    .optional()
    .describe(
      "Per-project budget row ID (e.g. 56990) — what `list_budget` shows in its ID column. Resolved server-side to the underlying category id. Mutually exclusive with budget_category_id and budget_code.",
    ),
  budget_code: z
    .string()
    .optional()
    .describe(
      'Human budget code prefix (e.g. "7051" for "7051 - Countertops Allowance"). Resolved server-side. Mutually exclusive with budget_category_id and budget_item_id.',
    ),
  description: z
    .string()
    .describe("Line description shown to the vendor (e.g. 'Plumbing rough-in')."),
  total: z.number().describe("Line total in dollars."),
  quantity: z.number().optional().describe("Default 1."),
  unit: z.string().optional().describe("Default '1' (BuildTools' unit code; rarely changed)."),
  notes: z.string().optional().describe("Line note visible to the vendor."),
  internal_notes: z
    .string()
    .optional()
    .describe("Internal-only note (not shown to the vendor). Default empty."),
  company_id: z
    .number()
    .optional()
    .describe(
      "Per-line vendor override. Defaults to the parent PO's company_id; most callers omit.",
    ),
});

const UpdatePurchaseOrderSchema = z.object({
  purchase_order_id: z.number().describe("BuildTools purchase order ID."),
  name: z.string().optional().describe("New PO name."),
  prefix: z.string().optional().describe("PO number prefix. Usually 'PO'."),
  description: z
    .string()
    .optional()
    .describe(
      "PO description body (the main rich-text block shown on the printed PO). Note: BuildTools' PO model has no `notes` field — use `description` for PO-level prose. Line-level notes go on each item.",
    ),
  company_id: z
    .number()
    .optional()
    .describe("Change the PO's vendor (use search_companies / get_company to look up IDs)."),
  status: z
    .union([z.number(), z.enum(["Draft", "Sent", "Confirmed", "Rejected"])])
    .optional()
    .describe(
      "Status — accepts either a numeric code (1=Draft, 2=Sent, 3=Confirmed, 4=Rejected) or a label string. Omit to preserve the current status; BuildTools doesn't merge partial payloads so omitting + not echoing back would reset it. " +
        "NOTE: BuildTools LOCKS Confirmed POs against ALL writes via /save (including status-only transitions). Attempting to update a Confirmed PO returns a clear error explaining the lock — there's no API path to unlock.",
    ),
  items: z
    .array(UpdatePurchaseOrderItemSchema)
    .optional()
    .describe(
      "Full replacement for the line items. OMIT to preserve existing items. Pass `[]` to clear all items. Each item must identify a budget category via ONE of `budget_category_id`, `budget_item_id`, or `budget_code`. Mutually exclusive with `items_append`.",
    ),
  items_append: z
    .array(UpdatePurchaseOrderItemSchema)
    .optional()
    .describe(
      "Items to APPEND to the existing line items, preserving originals. Use this when you want to add a delta line (e.g. a +$2,153 correction) without re-sending the existing lines. Mutually exclusive with `items`. Each item identifies a budget category the same way as items[].",
    ),
  verify: z
    .boolean()
    .optional()
    .describe(
      "After the save succeeds, re-fetch the PO and confirm the result matches intent. Default true. Set false to skip the verification fetch (saves one HTTP call; useful for high-throughput batch updates).",
    ),
  unlock_if_locked: z
    .boolean()
    .optional()
    .describe(
      "If the PO is in a write-locked status (currently: Confirmed), automatically demote to Draft via /purchase-orders/status/update, apply your changes via /save, then transition forward — to your `status` arg if set, otherwise to Sent (so the vendor re-acknowledges your change). " +
        "Default false; on a locked PO with this off, the call returns the standard lock-detection error. " +
        "**Side effects when this fires**: vendor sees status flip in their portal; BT may send a vendor email when status moves back to Sent. Use only when you actually want to change a confirmed PO.",
    ),
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .optional()
    .describe(
      "Optional client-supplied idempotency key. When set, a successful execution is cached for 1 hour. A retry with the SAME key + same args returns the cached result immediately (no BT call) — useful when an ambiguous failure leaves you unsure whether the first call took effect. Reusing the same key with DIFFERENT args returns an error so accidental key reuse can't apply different changes.",
    ),
  confirmation_id: z.string().optional(),
}).refine(
  (d) => !(d.items !== undefined && d.items_append !== undefined),
  {
    message:
      "Pass either `items` (full replacement) OR `items_append` (delta add) — not both. Use `items` to fully replace the line items; use `items_append` to add a new line without re-sending existing ones.",
    path: ["items_append"],
  },
);
type UpdatePurchaseOrderArgs = z.infer<typeof UpdatePurchaseOrderSchema>;

const CreateTaskSchema = z.object({
  name: z.string().describe("Task name."),
  project_id: z.number().describe("BuildTools project ID."),
  status: z.number().optional().describe("1=Open (default), 2=In Progress, 3=Complete."),
  priority: z.number().optional().describe("1=Normal (default), 2=High, 3=Urgent."),
  due_date: z.string().optional().describe("MM/DD/YYYY format."),
  assigned_to: z.union([z.number(), z.string()]).optional().describe("User ID to assign to."),
  description: z.string().optional(),
  confirmation_id: z.string().optional(),
});
type CreateTaskArgs = z.infer<typeof CreateTaskSchema>;

const CreateRFISchema = z.object({
  subject: z.string().describe("RFI subject line."),
  project_id: z.number().describe("BuildTools project ID."),
  question: z.string().optional().describe("RFI question body."),
  priority: z.number().optional().describe("1=Normal (default), 2=High, 3=Urgent."),
  assigned_to: z.union([z.number(), z.string()]).optional(),
  confirmation_id: z.string().optional(),
});
type CreateRFIArgs = z.infer<typeof CreateRFISchema>;

const CreateInvoiceSchema = z.object({
  company_id: z.number().describe("Vendor company ID."),
  number: z.string().describe("Invoice number."),
  date: z.string().describe("Invoice date (MM/DD/YYYY)."),
  due_date: z.string().describe("Due date (MM/DD/YYYY)."),
  payment_days: z.string().optional().describe("Payment terms in days. Default: '30'."),
  notes: z.string().optional(),
  confirmation_id: z.string().optional(),
});
type CreateInvoiceArgs = z.infer<typeof CreateInvoiceSchema>;

const CreateFinancialStatementSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
  name: z.string().describe("Statement name (e.g. 'Draw Request #5'). Use ASCII only — special characters get HTML-encoded."),
  amount: z.number().describe("Dollar amount for the statement."),
  notes: z.string().optional(),
  status: z.number().optional().describe("1=Draft (default), 2=Pending, 4=Partial, 5=Sent, 6=Paid."),
  confirmation_id: z.string().optional(),
});
type CreateFinancialStatementArgs = z.infer<typeof CreateFinancialStatementSchema>;

// create_draw_request (PR #65) — collapses the "set up a new project
// draw" workflow into one confirmed call.
//
// Today this takes ~3 round trips: list_financial_statements (to find
// the next draw number + prior draws sum) → math the user has to do
// in their head → create_financial_statement.
//
// The tool replaces the manual arithmetic + lookup steps. The PM still
// needs to know either (a) the exact dollar amount they want to bill,
// or (b) the cumulative work-completed value (the tool will then
// deduct prior draws and apply retainage).
const CreateDrawRequestSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
  amount: z
    .number()
    .positive()
    .finite()
    .max(10_000_000)
    .optional()
    .describe(
      "Direct dollar amount to bill on this draw. Skips the work-completed math. Mutually exclusive with `work_completed_to_date`.",
    ),
  work_completed_to_date: z
    .number()
    .positive()
    .finite()
    .max(10_000_000)
    .optional()
    .describe(
      "Cumulative work-completed dollar value to date. Tool computes the draw amount as `(work_completed_to_date × (1 - retainage_percent/100)) − sum(prior draws)`. " +
        "**This is the standard cumulative-work-completed method. NOT AIA G702/G703** (which separates retainage on completed work vs stored materials). " +
        "If your draw schedule uses a different methodology, pass `amount` directly. " +
        "Mutually exclusive with `amount`.",
    ),
  retainage_percent: z
    .number()
    .min(0)
    .max(50)
    .optional()
    .describe(
      "Percentage retainage held back from this draw (typical: 5-10%). Default 0. ONLY meaningful when `work_completed_to_date` is used — passing this with `amount` is rejected (caller is presumed to have already applied retainage to the direct amount).",
    ),
  draw_number: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Override the auto-incremented draw number. Default: max(existing draws on project)+1, or 1 if none.",
    ),
  name: z
    .string()
    .max(200)
    .regex(/^[\x20-\x7E]*$/, "name must be ASCII printable characters only — BT HTML-encodes non-ASCII and the list view doesn't decode")
    .optional()
    .describe(
      "Override the auto-generated statement name. Default: `\"Draw #N - YYYY-MM-DD\"` (ASCII hyphen). Max 200 chars; ASCII printable only.",
    ),
  // PR #65 review HIGH 1: due_date was accepted in the schema but
  // `createFinancialStatementWithAmount` has no due_date field — the
  // value was shown in the prompt and silently dropped on commit.
  // Removed entirely until the BT API method gains support.
  notes: z
    .string()
    .max(2000)
    .optional()
    .describe("Internal notes on the statement. Max 2000 chars."),
  status: z
    .number()
    .int()
    .refine((v) => [1, 2, 4, 5, 6].includes(v), {
      message: "status must be one of: 1 (Draft), 2 (Pending), 4 (Partial), 5 (Sent), 6 (Paid)",
    })
    .optional()
    .describe(
      "FS status code. Default 1 (Draft) so PM can review in the BT UI before sending. 1=Draft, 2=Pending, 4=Partial, 5=Sent, 6=Paid. Note: 3 is intentionally absent from the FS enum.",
    ),
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .optional()
    .describe(
      "Optional client-supplied idempotency key. Successful executions cached for 1 hour. Retry with same key + same args replays the result (no second BT call) — protects against ambiguous-timeout double-creates.",
    ),
  confirmation_id: z.string().optional(),
})
  .refine(
    (data) => (data.amount === undefined) !== (data.work_completed_to_date === undefined),
    {
      message: "Exactly one of `amount` or `work_completed_to_date` must be provided.",
      path: ["amount"],
    },
  )
  .refine(
    (data) => !(data.amount !== undefined && data.retainage_percent !== undefined),
    {
      message: "`retainage_percent` only applies to the `work_completed_to_date` path; when `amount` is set, the caller is presumed to have already applied retainage.",
      path: ["retainage_percent"],
    },
  );
type CreateDrawRequestArgs = z.infer<typeof CreateDrawRequestSchema>;

// apply_vendor_quote (PR #63) — collapses the 6-round-trip "vendor sent
// a new quote PDF, update the PO + attach + send" workflow into ONE
// confirmed tool call. See `docs/TOOLS.md` for the workflow rationale.
const ApplyVendorQuoteSchema = z.object({
  vendor_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Vendor / subcontractor name. The tool will search_companies and disambiguate if multiple match. Mutually exclusive with company_id.",
    ),
  company_id: z
    .number()
    .optional()
    .describe(
      "Vendor / subcontractor company ID — skips the search step. Mutually exclusive with vendor_name.",
    ),
  purchase_order_id: z
    .number()
    .optional()
    .describe(
      "Target PO ID directly. Skips the per-project lookup. Mutually exclusive with project_id.",
    ),
  project_id: z
    .number()
    .optional()
    .describe(
      "Project ID — the tool will find the unique open PO on this project for the resolved vendor. Disambiguation prompt returned if multiple POs exist. Mutually exclusive with purchase_order_id.",
    ),
  quote_total: z
    .number()
    .positive()
    .finite()
    .max(10_000_000)
    .describe("New total dollar amount the vendor quoted. Must be positive and finite. Replaces existing line items with a SINGLE line (collapse-to-one — for per-line granularity use update_purchase_order directly)."),
  filename: z
    .string()
    .min(1)
    .describe("Filename for the quote PDF (e.g. 'ADMO55739-F.pdf')."),
  file_base64: z
    .string()
    .min(4)
    .describe("Base64-encoded file bytes. NO `data:` URL prefix. Hard cap: 25 MB after decode."),
  content_type: z
    .string()
    .regex(
      /^[a-z][a-z0-9!#&\-^_]*\/[a-z0-9!#&\-^_+.]+$/i,
      "content_type must be a valid MIME type (e.g. 'application/pdf', 'image/png')",
    )
    .optional()
    .describe("MIME type. Default: 'application/pdf' if filename ends with .pdf, else 'application/octet-stream'. Validated against MIME format to prevent stored-XSS attacks via BT's file server."),
  quote_reference: z
    .string()
    .optional()
    .describe("Quote reference identifier (e.g. 'ADMO55739-F'). Used as the line description: 'Confirmed order {quote_reference}'. If omitted, defaults to 'Quote applied {YYYY-MM-DD} — {filename minus extension}'."),
  budget_code: z
    .string()
    .optional()
    .describe("Budget code prefix for the line (e.g. '7051'). Defaults to the existing PO's first item category — works for nearly all single-category POs."),
  notes: z
    .string()
    .optional()
    .describe("Internal-only note on the line (not shown to vendor)."),
  auto_send: z
    .boolean()
    .optional()
    .describe(
      "After applying the quote, transition the PO to Sent so the vendor re-acknowledges. Default true. Set false to leave the PO in Draft (no vendor email).",
    ),
  unlock_if_locked: z
    .boolean()
    .optional()
    .describe(
      "If the PO is in Confirmed (write-locked) state, auto-orchestrate demote → edit → restore to the target status. Default true. Mirrors update_purchase_order's unlock_if_locked behavior.",
    ),
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .optional()
    .describe(
      "Optional client-supplied idempotency key. Same semantics as update_purchase_order — successful executions cached for 1 hour; retry with same key + same args replays the result.",
    ),
  confirmation_id: z.string().optional(),
})
  .refine(
    (data) => (data.vendor_name === undefined) !== (data.company_id === undefined),
    {
      message: "Exactly one of `vendor_name` or `company_id` must be provided.",
      path: ["vendor_name"],
    },
  )
  .refine(
    (data) =>
      (data.purchase_order_id === undefined) !== (data.project_id === undefined),
    {
      message:
        "Exactly one of `purchase_order_id` or `project_id` must be provided.",
      path: ["purchase_order_id"],
    },
  );
type ApplyVendorQuoteArgs = z.infer<typeof ApplyVendorQuoteSchema>;

const TransitionPurchaseOrderStatusSchema = z.object({
  purchase_order_id: z.number().describe("BuildTools purchase order ID."),
  status: z
    .union([
      z.number(),
      z.enum(["Draft", "Sent", "Confirmed", "Rejected"]),
    ])
    .describe(
      "Target status — accepts either a numeric code (1=Draft, 2=Sent, 3=Confirmed, 4=Rejected) or a label string. " +
        "NOTE: Promoting TO Confirmed (3) requires a canvas-drawn signature on the PO that this tool doesn't supply; that transition will fail with 'Signature field is required'. The vendor advances the PO to Confirmed on their side after acknowledging.",
    ),
  // PR #64 review fix (MEDIUM): cross-tool consistency — other mutation
  // tools (update_purchase_order, apply_vendor_quote) accept
  // idempotency_key. Standalone transition omitted it; restoring parity.
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .optional()
    .describe(
      "Optional client-supplied idempotency key. When set, a successful execution is cached for 1 hour. Retry with same key + same args returns the cached result (no second BT call).",
    ),
  confirmation_id: z.string().optional(),
});
type TransitionPurchaseOrderStatusArgs = z.infer<typeof TransitionPurchaseOrderStatusSchema>;

const DeleteFinancialStatementSchema = z.object({
  statement_ids: z.array(z.number()).min(1).describe("Array of financial statement IDs to delete."),
  project_id: z.number().describe("BuildTools project ID (required for session scoping)."),
  confirmation_id: z.string().optional(),
});
type DeleteFinancialStatementArgs = z.infer<typeof DeleteFinancialStatementSchema>;

const CreateServiceSchema = z.object({
  name: z.string().describe("Service request name."),
  project_id: z.number().describe("BuildTools project ID."),
  description: z.string().describe("Service description."),
  status: z.number().optional().describe("1=Draft (default)."),
  due_date: z.string().optional().describe("MM/DD/YYYY format."),
  assigned_to: z.union([z.number(), z.string()]).optional(),
  confirmation_id: z.string().optional(),
});
type CreateServiceArgs = z.infer<typeof CreateServiceSchema>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMutationTools(
  getApi: () => BuildToolsAPI,
  store: ConfirmationStore,
  /**
   * Subject scoping the confirmation store. For HTTP/OAuth this is
   * `user.id` so the same person can complete a two-step mutation
   * across separate SSE sessions (Claude Desktop opens a fresh session
   * per tool call). Omit for stdio + legacy-bearer sessions.
   * Field name `sessionId` is a historical leftover.
   */
  sessionId?: string,
  /**
   * Optional idempotency cache. When provided, mutation tools that
   * accept an `idempotency_key` arg consult the cache before
   * confirmation and after success. Pass undefined to disable the
   * cache (every call hits BT fresh — historical behavior).
   */
  idempotencyStore?: IdempotencyStore,
): ToolDefinition[] {
  // -- create_project -------------------------------------------------------
  const createProjectConfirmed = requiresConfirmation<CreateProjectArgs>(
    "create_project",
    (a) => `Create project **"${a.name}"** (status ${a.status ?? 6}, PM #${a.project_manager_id}).`,
    async (a) => {
      try {
        const result = await getApi().createProject({
          name: a.name,
          status: String(a.status ?? 6),
          projectManager: a.project_manager_id,
          address: a.address,
          city: a.city,
          state: a.state,
          zip: a.zip,
          description: a.description,
        });
        if (result.success) return markdown(`Project **#${result.projectId}** created successfully.`);
        return errorMarkdown(`Failed to create project: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_project"); }
    },
  );

  // -- create_change_order --------------------------------------------------
  const createCOConfirmed = requiresConfirmation<CreateChangeOrderArgs>(
    "create_change_order",
    (a) => `Create change order **"${a.name}"** on project #${a.project_id}${a.total ? ` for $${a.total.toFixed(2)}` : ""}.`,
    async (a) => {
      try {
        const result = await getApi().createChangeOrder({
          name: a.name,
          projectId: a.project_id,
          total: a.total,
          description: a.description,
          items: a.items?.map((i) => ({
            name: i.name,
            total: i.total,
            budget_category_id: i.budget_category_id ?? 0,
          })),
        });
        if (result.success) return markdown(`Change order **#${result.changeOrderId}** created. ${result.message ?? ""}`);
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_change_order"); }
    },
  );

  // -- create_purchase_order ------------------------------------------------
  // The executor expects a resolved `company_id`. When the caller passed
  // `company_name` instead, we resolve it up-front (see resolveCompanyId
  // below) and overwrite the field before reaching the confirmation
  // framework — so the prompt shows the actual vendor and the args stored
  // for replay already carry the numeric id.
  //
  // `_resolved_from` carries the caller's ORIGINAL `company_name` input
  // when (and only when) we did the fuzzy resolution. The confirmation
  // prompt surfaces this explicitly so the user can see the substitution
  // ("Resolved 'Kai Mutn' → #977 (Kai Muten, LLC)") rather than the
  // server quietly accepting their misspelling.
  type CreatePOExecutorArgs = CreatePurchaseOrderArgs & {
    company_id: number;
    _resolved_from?: string;
  };
  const createPOConfirmed = requiresConfirmation<CreatePOExecutorArgs>(
    "create_purchase_order",
    (a) => {
      const safeName = escapeMarkdownInline(a.name);
      const safeCompanyName = escapeMarkdownInline(a.company_name ?? "");
      const safeFrom = escapeMarkdownInline(a._resolved_from ?? "");
      const base = `Create purchase order **"${safeName}"** on project #${a.project_id}`;
      if (a._resolved_from && a._resolved_from !== a.company_name) {
        return `${base}. Resolved \`company_name: "${safeFrom}"\` → #${a.company_id} (${safeCompanyName}).`;
      }
      if (a.company_name) {
        return `${base} for company #${a.company_id} (${safeCompanyName}).`;
      }
      return `${base} for company #${a.company_id}.`;
    },
    async (a) => {
      try {
        const result = await getApi().createPurchaseOrder({
          name: a.name,
          projectId: a.project_id,
          companyId: a.company_id,
          prefix: a.prefix,
          total: a.total,
          notes: a.notes,
          items: a.items,
        });
        if (result.success) return markdown(`Purchase order **#${result.purchaseOrderId}** created. ${result.message ?? ""}`);
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_purchase_order"); }
    },
  );

  // -- update_purchase_order ------------------------------------------------
  // Internal args shape: extends the public schema with an optional
  // resolved vendor name. When the caller changes `company_id`, we look
  // up the vendor name once before the confirmation prompt fires so the
  // user can see WHICH vendor they're switching to (rather than just a
  // raw numeric id). The lookup happens in the outer handler, not the
  // confirmed executor.
  type UpdatePOInternalArgs = UpdatePurchaseOrderArgs & {
    _resolved_company_name?: string;
    /**
     * Status code resolved from the (possibly label-form) `status` arg by
     * the outer handler. Single resolution at handler entry — the prompt
     * builder and the executor both read this rather than calling
     * `resolvePoStatusCode` again. Undefined when caller didn't pass a
     * `status` at all. NEVER undefined when `status !== undefined`
     * (the handler throws/Zod-fails earlier on an unresolvable label).
     */
    _resolved_status_code?: number;
    /**
     * Snapshot from a pre-confirmation `getPurchaseOrder` call. The
     * outer handler does this fetch ONCE on the first (no-confirmation_id)
     * call so the prompt can show the auto-transition plan when
     * `unlock_if_locked` is set against a locked PO. The executor reuses
     * it for routing decisions on the second call. Null when the
     * pre-fetch failed (network or 404) — both prompt and executor
     * degrade gracefully.
     */
    _pre_snapshot?: {
      status: number | null;
      totalNumeric: number;
      itemCount: number;
    } | null;
  };
  const updatePOConfirmed = requiresConfirmation<UpdatePOInternalArgs>(
    "update_purchase_order",
    (a) => {
      const safeName = escapeMarkdownInline(a.name ?? "");
      const parts: string[] = [];
      if (a.name !== undefined) parts.push(`rename to **"${safeName}"**`);
      if (a.company_id !== undefined) {
        const vendorLabel = a._resolved_company_name
          ? `#${a.company_id} (${escapeMarkdownInline(a._resolved_company_name)})`
          : `#${a.company_id}`;
        parts.push(`change vendor → ${vendorLabel}`);
      }
      if (a.status !== undefined) {
        // The outer handler resolved status → code once and stashed it
        // on `_resolved_status_code`. We just render it here — no
        // re-resolution, no second throw path. (If the resolution
        // failed earlier the handler would have returned an error
        // before storing the confirmation.)
        const code = a._resolved_status_code;
        parts.push(
          `status → ${poStatusLabel(code)}${code === undefined ? "" : ` (${code})`}`,
        );
      }
      if (a.description !== undefined) parts.push("update description");
      if (a.prefix !== undefined) parts.push(`prefix → "${escapeMarkdownInline(a.prefix)}"`);
      if (a.items !== undefined) {
        parts.push(
          a.items.length === 0
            ? "**clear all line items**"
            : `replace items (${a.items.length} line${a.items.length === 1 ? "" : "s"}, $${a.items.reduce((s, i) => s + i.total, 0).toFixed(2)} total)`,
        );
      }
      if (a.items_append !== undefined && a.items_append.length > 0) {
        parts.push(
          `append items (${a.items_append.length} new line${a.items_append.length === 1 ? "" : "s"}, +$${a.items_append.reduce((s, i) => s + i.total, 0).toFixed(2)})`,
        );
      }
      const summary = parts.length > 0 ? parts.join("; ") : "_(no changes specified)_";
      const base = `Update purchase order #${a.purchase_order_id}: ${summary}.`;

      // Auto-transition banner — surfaced when the pre-snapshot says
      // the PO is in a write-locked status AND the caller opted in via
      // unlock_if_locked. We render the FULL transition plan so the
      // user can see the side effects (vendor status flip + likely
      // re-acknowledgement email) before confirming.
      const snap = a._pre_snapshot;
      if (
        a.unlock_if_locked &&
        snap &&
        snap.status !== null &&
        PURCHASE_ORDER_WRITE_LOCKED_STATUSES.has(snap.status)
      ) {
        const fromLabel = poStatusLabel(snap.status);
        const restoreCode = a._resolved_status_code ?? 2;
        const restoreLabel = poStatusLabel(restoreCode);
        // PR #61 review MEDIUM-1: if the requested restore target is
        // ITSELF a write-locked status (Confirmed is the only one in
        // practice), surface that BT will refuse the restore step
        // because it requires a signature we don't supply. Caller can
        // then choose Sent instead — far better than silently applying
        // the content edit and stranding the PO in Draft.
        const restoreIsLocked = PURCHASE_ORDER_WRITE_LOCKED_STATUSES.has(restoreCode);
        const restoreWarning = restoreIsLocked
          ? `\n\n⛔ **The restore step is likely to fail**: promoting to **${restoreLabel}** requires a canvas-drawn signature (\`PurchaseOrder[signature]\`) that this tool doesn't supply. The plan above will roll back to **${fromLabel}** if the restore fails. Consider using \`status: "Sent"\` instead — the vendor can advance to ${restoreLabel} on their side.`
          : "";
        return (
          `${base}\n\n⚠️ **Auto-transition** (\`unlock_if_locked\`): PO is currently **${fromLabel}**. ` +
          `Plan: ${fromLabel} → Draft → apply edits → ${restoreLabel}. ` +
          `_The vendor will see the status flip in their portal; BT may send a vendor email when status moves back to ${restoreLabel}._` +
          restoreWarning
        );
      }
      return base;
    },
    async (a) => {
      try {
        // Status code (resolved once in the outer handler).
        const targetStatusCode = a._resolved_status_code;

        // Workflow steps to surface in the success message — populated
        // as we go through the orchestration so the caller can see
        // exactly what happened (especially important for the
        // auto-transition path).
        const workflowSteps: string[] = [];

        // === Determine current state when we actually need it ===
        // Reuse the outer-handler's pre-snapshot when present. Else
        // fetch only when we genuinely need currentStatus or the
        // items_append delta numbers — every other code path can
        // operate without (status-only changes route through
        // /status/update which accepts transitions /save refuses,
        // and the API method does its own lock check for /save calls).
        // PR #61 review HIGH-1 race fix: for `unlock_if_locked` we
        // ALWAYS re-fetch live in the executor — never trust the
        // outer-handler's snapshot for the demote decision. The
        // snapshot was captured during the prompt phase (potentially
        // minutes ago given the confirmation TTL) and a concurrent
        // user could have moved the PO out of Confirmed in the
        // meantime. Issuing a demote against a stale-Confirmed PO
        // that's now in Sent would silently regress the vendor-facing
        // state. The outer snapshot is fine for prompt rendering;
        // routing decisions need ground truth.
        let preSnapshot = a._pre_snapshot;
        const needLiveStatus = !!a.unlock_if_locked;
        const needAppendSnapshot =
          a.items_append !== undefined &&
          a.items_append.length > 0 &&
          (a.verify ?? true);
        if (needLiveStatus || (preSnapshot === undefined && needAppendSnapshot)) {
          try {
            const pre = await getApi().getPurchaseOrder(a.purchase_order_id);
            preSnapshot = pre
              ? {
                  status: pre.status,
                  totalNumeric: pre.totalNumeric,
                  itemCount: pre.items.length,
                }
              : null;
          } catch {
            preSnapshot = null;
          }
        }
        const currentStatus = preSnapshot?.status ?? null;
        const isLocked =
          currentStatus !== null &&
          PURCHASE_ORDER_WRITE_LOCKED_STATUSES.has(currentStatus);
        const preSaveItemCount = preSnapshot?.itemCount;
        const preSaveTotal = preSnapshot?.totalNumeric;

        // === Locked PO without unlock opt-in: refuse cleanly ===
        if (isLocked && !a.unlock_if_locked) {
          return errorMarkdown(
            formatPurchaseOrderLockError(
              a.purchase_order_id,
              currentStatus as number,
            ),
          );
        }

        // === Has content changes? ===
        // /save echoes status; we never CHANGE status via /save. So
        // when there's no content change, we skip /save entirely and
        // only do the status transition (if any).
        const hasContentChange =
          a.name !== undefined ||
          a.prefix !== undefined ||
          a.description !== undefined ||
          a.company_id !== undefined ||
          a.items !== undefined ||
          a.items_append !== undefined;

        // === Auto-transition: demote first if needed ===
        if (isLocked && a.unlock_if_locked) {
          const demote = await getApi().transitionPurchaseOrderStatus({
            purchaseOrderId: a.purchase_order_id,
            status: 1, // Draft / Cancel
          });
          if (!demote.success) {
            return errorMarkdown(
              `**Auto-transition: demote failed** for PO #${a.purchase_order_id}: ${String(demote.errors ?? "(no detail)")}. PO unchanged.`,
            );
          }
          workflowSteps.push(
            `demoted ${poStatusLabel(currentStatus as number)} → Draft`,
          );
        }

        // === Apply content changes via /save ===
        // CRITICAL: we deliberately DO NOT pass `status` to /save. /save's
        // status field is unreliable (BT refuses certain transitions
        // there) — all status changes route through /status/update
        // instead, in the dedicated section below.
        const mapItem = (
          i: z.infer<typeof UpdatePurchaseOrderItemSchema>,
        ) => ({
          budgetCategoryId: i.budget_category_id,
          budgetItemId: i.budget_item_id,
          budgetCode: i.budget_code,
          description: i.description,
          total: i.total,
          quantity: i.quantity,
          unit: i.unit,
          notes: i.notes,
          internalNotes: i.internal_notes,
          companyId: i.company_id,
        });
        // Default: nothing to save (status-only / no-op case). The
        // headline below reads off result.message which we leave
        // undefined; workflowSteps drives the user-visible summary.
        let result: {
          success: boolean;
          purchaseOrderId?: string | number;
          message?: unknown;
          errors?: unknown;
        } = { success: true, purchaseOrderId: a.purchase_order_id };
        if (hasContentChange) {
          result = await getApi().updatePurchaseOrder({
            purchaseOrderId: a.purchase_order_id,
            name: a.name,
            prefix: a.prefix,
            description: a.description,
            companyId: a.company_id,
            items: a.items?.map(mapItem),
            itemsAppend: a.items_append?.map(mapItem),
          });
          if (!result.success) {
            const errorBody = String(result.errors ?? "(no detail)");
            // If we demoted earlier, attempt to restore the original
            // status so the PO doesn't get stranded in Draft.
            let restoreNote = "";
            if (isLocked && a.unlock_if_locked && currentStatus !== null) {
              const restore = await getApi().transitionPurchaseOrderStatus({
                purchaseOrderId: a.purchase_order_id,
                status: currentStatus,
              });
              restoreNote = restore.success
                ? `\n\n_Restored to original **${poStatusLabel(currentStatus)}** state._`
                : `\n\n**Could not restore to ${poStatusLabel(currentStatus)}** (${String(restore.errors)}). **PO is now in Draft — fix manually in the BT UI.**`;
            }
            return errorMarkdown(
              `**Failed to update PO #${a.purchase_order_id}**: ${errorBody}${restoreNote}`,
            );
          }
          workflowSteps.push("applied content changes");
        }

        // === Final status transition ===
        // Compute the FINAL target status:
        //   - Auto-transition path: caller's target if set, else 2 (Sent
        //     — the vendor re-acknowledges the change).
        //   - Normal path: caller's target (if it differs from current).
        //   - Otherwise: no transition.
        let finalTarget: number | undefined;
        if (isLocked && a.unlock_if_locked) {
          finalTarget = targetStatusCode ?? 2;
        } else if (
          targetStatusCode !== undefined &&
          targetStatusCode !== currentStatus
        ) {
          finalTarget = targetStatusCode;
        }
        if (finalTarget !== undefined) {
          const transition = await getApi().transitionPurchaseOrderStatus({
            purchaseOrderId: a.purchase_order_id,
            status: finalTarget,
          });
          if (!transition.success) {
            // PR #61 review HIGH-2: if we entered via the auto-transition
            // path, the PO is now in Draft with the user's content
            // applied — silently leaving it there strands the PO in a
            // state the caller never asked for. Mirror the /save
            // failure path: attempt to restore the original status, and
            // report concretely (Draft / original) — never "intermediate".
            const headlineVerb = hasContentChange
              ? "Content updated"
              : "No content change requested";
            if (isLocked && a.unlock_if_locked && currentStatus !== null) {
              const rollback = await getApi().transitionPurchaseOrderStatus({
                purchaseOrderId: a.purchase_order_id,
                status: currentStatus,
              });
              const rollbackNote = rollback.success
                ? `\n\n_Rolled back to original **${poStatusLabel(currentStatus)}** state — your content edits remain applied but the status didn't move forward._`
                : `\n\n**Rollback to ${poStatusLabel(currentStatus)} ALSO failed** (${String(rollback.errors ?? "(no detail)")}). **PO is now in Draft with your content edits applied — fix manually in the BT UI.**`;
              return errorMarkdown(
                `**${headlineVerb}** for PO #${a.purchase_order_id} but **status transition to ${poStatusLabel(finalTarget)} failed**: ${String(transition.errors ?? "(no detail)")}.${rollbackNote}`,
              );
            }
            // Non-auto-transition path: nothing to rollback (caller is
            // making a deliberate status change against a non-locked PO
            // and BT refused). The PO's status is unchanged from
            // currentStatus — be concrete about that.
            const stateNote = currentStatus !== null
              ? `\n\n_PO status is unchanged at **${poStatusLabel(currentStatus)}**._`
              : "";
            return errorMarkdown(
              `**${headlineVerb}** for PO #${a.purchase_order_id} but **status transition to ${poStatusLabel(finalTarget)} failed**: ${String(transition.errors ?? "(no detail)")}.${stateNote}`,
            );
          }
          workflowSteps.push(`set status → ${poStatusLabel(finalTarget)}`);
        }

        // Verify-after-write (default on). Re-fetch the PO and confirm
        // EVERY caller-passed field matches intent. Catches BT's edge
        // cases where the save returns success but a field didn't stick.
        //
        // Coverage rule: a field is verified IFF the caller passed it.
        // We don't assert anything about fields the caller didn't touch
        // (they could legitimately have been left at their old values).
        // The summary message ("Verified: ...") only mentions fields
        // actually checked so the user can't read it as a green-checkmark
        // for fields we didn't look at.
        const verify = a.verify ?? true;
        const verifyLines: string[] = [];
        if (verify) {
          try {
            const detail = await getApi().getPurchaseOrder(a.purchase_order_id);
            if (!detail) {
              // Re-fetch returned null (404 / parse failure). Explicitly
              // surface the gap so the caller knows verify didn't run —
              // silently omitting was misleading.
              verifyLines.push(
                "_Verify skipped: re-fetched PO not found (possible race or transient BT issue). The save itself reported success._",
              );
            } else {
              const mismatches: string[] = [];
              const verified: string[] = [];

              if (a.name !== undefined) {
                if (detail.name !== a.name) {
                  mismatches.push(`name: expected "${a.name}", got "${detail.name}"`);
                } else {
                  verified.push(`name="${escapeMarkdownInline(detail.name)}"`);
                }
              }
              if (a.prefix !== undefined) {
                if (detail.prefix !== a.prefix) {
                  mismatches.push(`prefix: expected "${a.prefix}", got "${detail.prefix}"`);
                } else {
                  verified.push(`prefix="${escapeMarkdownInline(detail.prefix)}"`);
                }
              }
              if (a.description !== undefined) {
                if (detail.description !== a.description) {
                  mismatches.push(
                    `description: expected ${JSON.stringify(a.description.slice(0, 80))}, got ${JSON.stringify(detail.description.slice(0, 80))}`,
                  );
                } else {
                  verified.push(`description (${detail.description.length} chars)`);
                }
              }
              // Status verify: check whenever the orchestration moved
              // the status (either because the caller asked for it OR
              // because the auto-transition path defaulted to Sent).
              // `finalTarget` is the orchestrator's final intended
              // status — undefined when no transition was issued.
              // Null-safety on detail.status mirrors the company_id pattern.
              if (finalTarget !== undefined) {
                if (
                  detail.status !== null &&
                  detail.status !== finalTarget
                ) {
                  mismatches.push(
                    `status: expected ${finalTarget} (${poStatusLabel(finalTarget)}), got ${detail.status} (${poStatusLabel(detail.status)})`,
                  );
                } else if (detail.status !== null) {
                  // PR #61 review LOW-2: qualify when the target was
                  // auto-chosen by the unlock path rather than asked
                  // for explicitly, so the verify line doesn't read as
                  // "user wanted Sent" when they didn't say that.
                  const autoDefaulted =
                    targetStatusCode === undefined &&
                    isLocked &&
                    a.unlock_if_locked;
                  const qualifier = autoDefaulted ? " (auto-transition default)" : "";
                  verified.push(
                    `status=${poStatusLabel(detail.status)} (${detail.status})${qualifier}`,
                  );
                }
              }
              // Vendor: skip the mismatch check if the re-fetch couldn't
              // parse the company block — null vs number always trips
              // strict-equality and would fire a false positive when
              // the save actually succeeded.
              if (a.company_id !== undefined) {
                if (detail.companyId !== null && detail.companyId !== a.company_id) {
                  mismatches.push(
                    `company_id: expected ${a.company_id}, got ${detail.companyId}`,
                  );
                } else if (detail.companyId !== null) {
                  verified.push(
                    `vendor=${detail.companyName ? escapeMarkdownInline(detail.companyName) : "—"} (#${detail.companyId})`,
                  );
                }
              }
              if (a.items !== undefined) {
                const expectedTotal = a.items.reduce((s, i) => s + i.total, 0);
                // Tolerance is in CENTS (0.01 dollars). Reasonable for
                // single-PO line-item totals; accumulated rounding noise
                // across many items stays well under this for currency.
                const totalOk =
                  Math.abs(detail.totalNumeric - expectedTotal) <= 0.01;
                const countOk = detail.items.length === a.items.length;
                if (!totalOk) {
                  mismatches.push(
                    `items total: expected $${expectedTotal.toFixed(2)}, got $${detail.totalNumeric.toFixed(2)}`,
                  );
                }
                if (!countOk) {
                  mismatches.push(
                    `item count: expected ${a.items.length}, got ${detail.items.length}`,
                  );
                }
                if (totalOk && countOk) {
                  verified.push(`${detail.items.length} item(s), total $${detail.totalNumeric.toFixed(2)}`);
                }
              }
              if (a.items_append !== undefined && a.items_append.length > 0) {
                const appendDelta = a.items_append.reduce((s, i) => s + i.total, 0);
                if (preSaveItemCount !== undefined && preSaveTotal !== undefined) {
                  // Strict delta assertion when the pre-save snapshot
                  // succeeded. expected count = pre + N appended;
                  // expected total = pre + Δ.
                  const expectedCount = preSaveItemCount + a.items_append.length;
                  const expectedTotal = preSaveTotal + appendDelta;
                  const countOk = detail.items.length === expectedCount;
                  const totalOk = Math.abs(detail.totalNumeric - expectedTotal) <= 0.01;
                  if (!countOk) {
                    mismatches.push(
                      `appended item count: expected ${expectedCount} (${preSaveItemCount} pre + ${a.items_append.length} appended), got ${detail.items.length}`,
                    );
                  }
                  if (!totalOk) {
                    mismatches.push(
                      `appended total: expected $${expectedTotal.toFixed(2)} ($${preSaveTotal.toFixed(2)} pre + $${appendDelta.toFixed(2)} appended), got $${detail.totalNumeric.toFixed(2)}`,
                    );
                  }
                  if (countOk && totalOk) {
                    verified.push(
                      `appended ${a.items_append.length} line(s) (+$${appendDelta.toFixed(2)}); PO now has ${detail.items.length} item(s) totalling $${detail.totalNumeric.toFixed(2)}`,
                    );
                  }
                } else {
                  // Pre-fetch failed; degrade to a post-state-only
                  // report so the caller knows the strict check
                  // didn't run.
                  verifyLines.push(
                    `_Append verify: pre-save snapshot failed; reporting post-save state only — PO now has ${detail.items.length} item(s) totalling $${detail.totalNumeric.toFixed(2)}._`,
                  );
                }
              }
              if (mismatches.length > 0) {
                return errorMarkdown(
                  `**Update reported success but verify-after-write found mismatches** on PO #${a.purchase_order_id}:\n` +
                    mismatches.map((m) => `- ${m}`).join("\n") +
                    "\n\nRe-run `get_purchase_order` for current state. The save endpoint sometimes returns 200 OK while silently dropping fields.",
                );
              }
              if (verified.length > 0) {
                verifyLines.push(`Verified: ${verified.join(", ")}.`);
              }
            }
          } catch (err) {
            // Verify is best-effort — don't fail the whole update if
            // the re-fetch itself errors. Just note it.
            const msg = err instanceof Error ? err.message : String(err);
            verifyLines.push(`_Verify skipped: ${escapeMarkdownInline(msg)}._`);
          }
        }

        // Compose the headline with a workflow trail (especially
        // useful for the auto-transition case — caller sees exactly
        // what happened).
        const headline = workflowSteps.length > 0
          ? `Purchase order **#${a.purchase_order_id}** updated — ${workflowSteps.join(" → ")}.`
          : `Purchase order **#${a.purchase_order_id}** updated.`;
        return markdown(
          headline +
            (result.message ? ` ${result.message}` : "") +
            (verifyLines.length > 0 ? `\n\n${verifyLines.join("\n")}` : ""),
        );
      } catch (err) { return formatError(err, "update_purchase_order"); }
    },
  );

  // ---------------------------------------------------------------------
  // transition_purchase_order_status — standalone status-only tool
  // ---------------------------------------------------------------------
  //
  // Wraps the workflow endpoint `/purchase-orders/status/update`
  // directly. Useful when caller wants ONLY a status change with no
  // content edits — same routing the `update_purchase_order` tool uses
  // internally for the status step.
  //
  // Why two tools instead of just `update_purchase_order`?
  //   - This tool's surface is intentionally narrow (PO id + target
  //     status). Easier to reason about for the LLM than
  //     `update_purchase_order` which carries 10+ fields.
  //   - The endpoint is `ids[]`-capable; future bulk-status workflows
  //     can extend this tool without touching the larger update tool.
  //   - Discoverability: a tool named `transition_purchase_order_status`
  //     surfaces the capability via tool search in a way that "look at
  //     the rarely-used `status` field of `update_purchase_order`" does
  //     not.
  const transitionPOStatusConfirmed = requiresConfirmation<TransitionPurchaseOrderStatusArgs & { _resolved_status_code?: number; _current_status?: number | null; _po_name?: string }>(
    "transition_purchase_order_status",
    (a) => {
      const targetLabel = a._resolved_status_code !== undefined
        ? `${poStatusLabel(a._resolved_status_code)} (${a._resolved_status_code})`
        : String(a.status);
      // PR #64 review fix (MEDIUM): include the current status in the
      // confirmation prompt. Two reasons: (1) a from→to delta is far
      // more meaningful for the user gating the action than a target
      // alone, and (2) it's an injection-defense anchor — a
      // BT-sourced field can't fake live state, so an LLM under
      // indirect prompt injection can't confidently confirm a
      // transition without the actual live current state matching the
      // attacker's expectation.
      const currentLabel = a._current_status !== null && a._current_status !== undefined
        ? `${poStatusLabel(a._current_status)} (${a._current_status})`
        : "_(could not fetch current state)_";
      const poName = a._po_name ? ` — ${escapeMarkdownInline(a._po_name)}` : "";
      return `Transition purchase order **#${a.purchase_order_id}**${poName} from **${currentLabel}** → **${targetLabel}**.`;
    },
    async (a) => {
      try {
        const code = a._resolved_status_code;
        if (code === undefined) {
          return errorMarkdown(
            `**Error calling \`transition_purchase_order_status\`**: status code was not resolved`,
          );
        }
        const result = await getApi().transitionPurchaseOrderStatus({
          purchaseOrderId: a.purchase_order_id,
          status: code,
        });
        if (!result.success) {
          return errorMarkdown(
            `**Failed to transition PO #${a.purchase_order_id} to ${poStatusLabel(code)}**: ${String(result.errors ?? "(no detail)")}`,
          );
        }
        return markdown(
          `Purchase order **#${a.purchase_order_id}** status → **${poStatusLabel(code)}** (${code}). ${String(result.message ?? "")}`,
        );
      } catch (err) {
        return formatError(err, "transition_purchase_order_status");
      }
    },
  );

  // ---------------------------------------------------------------------
  // apply_vendor_quote — multi-step workflow consolidator (PR #63)
  // ---------------------------------------------------------------------
  //
  // The single most common "vendor sent a new quote" workflow. Collapses
  // 6 round-trips (search_companies → list_purchase_orders → get_po →
  // update_po → upload_attachment → transition) into one confirmed call.
  //
  // Inherits semantics from the underlying primitives:
  //   - unlock_if_locked     ←  update_purchase_order
  //   - idempotency_key      ←  update_purchase_order
  //   - data: prefix reject  ←  upload_attachment
  //   - confirmation pattern ←  requiresConfirmation
  //
  // Orchestration on confirmation:
  //   1. updatePurchaseOrder with the new items + unlock_if_locked
  //   2. uploadAttachment with the PDF (PO module = 1500)
  //   3. transitionPurchaseOrderStatus to Sent (if auto_send)
  // Steps 2 and 3 are independent of step 1's success; we run them and
  // surface partial failures distinctly so the caller knows the exact
  // outcome.

  /** Resolve `vendor_name` to a single company. Returns disambiguation prompt as an Error result if N>1. */
  type CompanyRow = {
    DT_RowId: string;
    name?: string;
    type_name?: string;
  };
  type ResolutionOk<T> = { ok: true; value: T };
  type ResolutionFail = { ok: false; result: ToolResult };
  type Resolution<T> = ResolutionOk<T> | ResolutionFail;

  async function resolveVendorCompany(
    args: ApplyVendorQuoteArgs,
  ): Promise<Resolution<{ id: number; name: string }>> {
    if (args.company_id !== undefined) {
      const name = await lookupCompanyName(args.company_id);
      return {
        ok: true,
        value: { id: args.company_id, name: name ?? `Company #${args.company_id}` },
      };
    }
    const query = args.vendor_name!;
    const results = (await getApi().searchCompanies<{ data: CompanyRow[] }>(query, { limit: 25 })) ?? { data: [] };
    const rows = results.data ?? [];
    if (rows.length === 0) {
      return {
        ok: false,
        result: errorMarkdown(
          `**No vendor matches** "${escapeMarkdownInline(query)}". Verify the name or pass \`company_id\` directly.`,
        ),
      };
    }
    // Decode BOTH BT's emitted name (HTML entities + tags) AND the
    // caller's query through the same normalizer so e.g. "M&D
    // Construction" matches the stored "M&amp;D Construction".
    const decoded = rows.map((r) => {
      const cleanName = decodeBtNameEntities((r.name ?? "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      return {
        id: Number(r.DT_RowId.replace(/^row_/, "")),
        name: cleanName,
        type: (r.type_name ?? "").trim(),
        normalized: cleanName.toLowerCase(),
      };
    });
    const normalizedQuery = normalizeVendorName(query);
    // Exact-name match takes precedence over partial matches.
    const exact = decoded.filter(
      (r) => r.normalized === normalizedQuery,
    );
    const matches = exact.length === 1 ? exact : decoded;
    if (matches.length === 1) {
      const m = matches[0];
      return { ok: true, value: { id: m.id, name: m.name || `Company #${m.id}` } };
    }
    const list = matches
      .slice(0, 8)
      .map((r) => `- #${r.id} **${escapeMarkdownInline(r.name)}**${r.type ? ` (${escapeMarkdownInline(r.type)})` : ""}`)
      .join("\n");
    return {
      ok: false,
      result: errorMarkdown(
        `**Multiple vendors match** "${escapeMarkdownInline(query)}":\n\n${list}\n\nRe-invoke with \`company_id\` set to the right one.`,
      ),
    };
  }

  /** Resolve target PO. */
  type POListRow = {
    DT_RowId?: string;
    info?: number | string;
    name?: string;
    number?: string;
    total?: string;
    status?: string;
    company?: string;
  };
  async function resolveTargetPurchaseOrder(
    args: ApplyVendorQuoteArgs,
    vendor: { id: number; name: string },
  ): Promise<Resolution<{ id: number; name?: string }>> {
    if (args.purchase_order_id !== undefined) {
      return { ok: true, value: { id: args.purchase_order_id } };
    }
    const projectId = args.project_id!;
    // Filter the per-project PO datatable by company. Column-based
    // filtering varies by tenant; we filter client-side off the
    // resolved detail since PO list rows expose the company name as
    // text.
    const params = {
      "columns[10][search][value]": String(projectId), // project filter
      length: 200,
    } as const;
    const list = (await getApi().getPurchaseOrders<{ data: POListRow[] }>(params as any)) ?? { data: [] };
    const rows = list.data ?? [];
    // Match strictly on the `company` column (NOT the PO name — a PO
    // named "Smith Plumbing rough-in" should never match vendor "Smith"
    // when the actual company is Acme). Normalize both sides through
    // the same path that resolved the vendor in the first place to
    // tolerate HTML-entity drift between datatable views.
    const normalizedVendor = normalizeVendorName(vendor.name);
    const candidates = rows.filter((r) => {
      const company = normalizeVendorName(r.company ?? "");
      return company === normalizedVendor;
    });
    if (candidates.length === 0) {
      return {
        ok: false,
        result: errorMarkdown(
          `**No existing PO** for **${escapeMarkdownInline(vendor.name)}** on project #${projectId}. Create one with \`create_purchase_order\`.`,
        ),
      };
    }
    if (candidates.length === 1) {
      const c = candidates[0];
      const id = Number(c.info ?? c.DT_RowId?.replace(/^row_/, "") ?? 0);
      if (!Number.isFinite(id) || id <= 0) {
        return {
          ok: false,
          result: errorMarkdown(`**Could not parse PO id** from datatable row.`),
        };
      }
      return { ok: true, value: { id, name: stripHtml(String(c.name ?? "")) } };
    }
    const listLines = candidates
      .slice(0, 8)
      .map((r) => {
        const id = Number(r.info ?? r.DT_RowId?.replace(/^row_/, "") ?? 0);
        const total = (r.total ?? "").replace(/<[^>]*>/g, "").trim();
        const name = stripHtml(String(r.name ?? ""));
        return `- #${id} ${escapeMarkdownInline(name)} — ${total}`;
      })
      .join("\n");
    return {
      ok: false,
      result: errorMarkdown(
        `**Multiple POs** for **${escapeMarkdownInline(vendor.name)}** on project #${projectId}:\n\n${listLines}\n\nRe-invoke with \`purchase_order_id\` set to the right one.`,
      ),
    };
  }

  // 25 MB cap (per brief). PDF spec says theoretical max is ~50 MB for
  // most viewers; 25 MB is comfortable for quote docs and prevents
  // accidental huge uploads.
  const APPLY_VENDOR_QUOTE_MAX_BYTES = 25 * 1024 * 1024;

  type ApplyVendorQuoteInternalArgs = ApplyVendorQuoteArgs & {
    _resolved_vendor?: { id: number; name: string };
    _resolved_po?: { id: number; name?: string };
    _pre_state?: {
      status: number | null;
      totalNumeric: number;
      itemCount: number;
      companyId: number | null;
      companyName: string | null;
      projectId: number | null;
      firstItemBudgetCode?: string;
    } | null;
    _decoded_bytes?: number;
  };

  function defaultContentType(filename: string): string {
    return filename.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : "application/octet-stream";
  }

  function defaultLineDescription(args: ApplyVendorQuoteArgs, todayIso: string): string {
    if (args.quote_reference) return `Confirmed order ${args.quote_reference}`;
    const filenameBase = args.filename.replace(/\.[a-z0-9]+$/i, "");
    return `Quote applied ${todayIso} — ${filenameBase}`;
  }

  function stripHtml(s: string): string {
    return s.replace(/<[^>]*>/g, "").trim();
  }

  // Decode the HTML entities BT emits in datatable names (M&amp;D
  // Construction → M&D Construction). Without this the exact-name match
  // in resolveVendorCompany silently fails on any vendor with `&`, `<`,
  // `>`, or quoted characters in the name. The set is small because BT
  // only encodes a fixed handful — no need for a full HTML parser.
  function decodeBtNameEntities(s: string): string {
    return s
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&nbsp;/gi, " ");
  }

  function normalizeVendorName(s: string): string {
    return decodeBtNameEntities(stripHtml(s)).replace(/\s+/g, " ").trim().toLowerCase();
  }

  const applyVendorQuoteConfirmed = requiresConfirmation<ApplyVendorQuoteInternalArgs>(
    "apply_vendor_quote",
    (a) => {
      const vendor = a._resolved_vendor;
      const po = a._resolved_po;
      const pre = a._pre_state;
      const bytes = a._decoded_bytes ?? 0;
      const sizeKb = (bytes / 1024).toFixed(1);
      const ct = a.content_type ?? defaultContentType(a.filename);
      const finalStatus = a.auto_send === false ? "Draft" : "Sent";
      const lines: string[] = [];
      lines.push(`Apply vendor quote${a.quote_reference ? ` **${escapeMarkdownInline(a.quote_reference)}**` : ""} to purchase order **#${po?.id}**.`);
      lines.push("");
      if (vendor) lines.push(`- **Vendor**: ${escapeMarkdownInline(vendor.name)} (#${vendor.id})`);
      if (po?.name) lines.push(`- **PO**: #${po.id} — ${escapeMarkdownInline(po.name)}`);
      if (pre) {
        const deltaSign = a.quote_total > pre.totalNumeric ? "+" : "";
        const delta = a.quote_total - pre.totalNumeric;
        lines.push(
          `- **Total**: $${pre.totalNumeric.toFixed(2)} → **$${a.quote_total.toFixed(2)}** (Δ ${deltaSign}$${delta.toFixed(2)})`,
        );
        lines.push(`- **Current status**: ${poStatusLabel(pre.status ?? -1)}`);
      } else {
        lines.push(`- **New total**: $${a.quote_total.toFixed(2)}`);
      }
      lines.push(`- **Attachment**: ${escapeMarkdownInline(a.filename)} (${sizeKb} KB, ${ct})`);
      lines.push(`- **Final status**: ${finalStatus}`);
      // PR #63 review MEDIUM (architect): warn when the collapse-to-one
      // replacement will destroy multiple existing line items — the
      // single-line PO is the common case but a 3-line plumbing PO
      // collapsed to one is a real loss of structure that the user
      // should consent to explicitly.
      if (pre && pre.itemCount > 1) {
        lines.push(
          `- **Line items**: replaces **${pre.itemCount} existing line${pre.itemCount === 1 ? "" : "s"}** with 1 new line ("${escapeMarkdownInline(a.quote_reference ? `Confirmed order ${a.quote_reference}` : `Quote applied`)}"). For per-line granularity use \`update_purchase_order\` directly.`,
        );
      }
      const isLocked =
        pre && pre.status !== null && PURCHASE_ORDER_WRITE_LOCKED_STATUSES.has(pre.status);
      if (isLocked && a.unlock_if_locked !== false) {
        lines.push(
          "",
          `⚠️ **Auto-transition** (PO is currently **${poStatusLabel(pre.status as number)}**): demote → apply edits + attach PDF → ${finalStatus}. Vendor will see status flip in their portal.`,
        );
      } else if (isLocked && a.unlock_if_locked === false) {
        lines.push(
          "",
          `⛔ PO is **${poStatusLabel(pre.status as number)}** (write-locked) and \`unlock_if_locked\` is false. This call will fail with a lock error — re-invoke with \`unlock_if_locked: true\` to auto-orchestrate.`,
        );
      }
      // PR #63 review MEDIUM (security): unconditional vendor-email
      // warning when finalStatus is Sent. The original implementation
      // only warned inside the isLocked branch, hiding the
      // outbound-email side effect on the common Draft→Sent path.
      if (finalStatus === "Sent" && a.auto_send !== false) {
        lines.push(
          `- _Vendor will receive an email when status moves to Sent._`,
        );
      }
      return lines.join("\n");
    },
    async (a) => {
      try {
        const vendor = a._resolved_vendor!;
        const po = a._resolved_po!;
        let pre = a._pre_state;
        const finalStatusCode = a.auto_send === false ? 1 : 2; // Draft : Sent
        const unlockIfLocked = a.unlock_if_locked !== false;

        // PR #63 review HIGH (race fix): re-fetch live status when we
        // might need to demote. The outer handler's pre-snapshot was
        // captured at confirmation-prompt time (potentially minutes
        // ago) — a concurrent user could have moved the PO out of
        // Confirmed in the meantime. Trusting the stale snapshot
        // would issue an unintended demote against a now-Sent PO.
        // Mirror the PR #61 fix in update_purchase_order.
        if (unlockIfLocked) {
          try {
            const fresh = await getApi().getPurchaseOrder(po.id);
            if (fresh) {
              pre = {
                status: fresh.status,
                totalNumeric: fresh.totalNumeric,
                itemCount: fresh.items.length,
                companyId: fresh.companyId,
                companyName: fresh.companyName,
                projectId: fresh.projectId != null ? Number(fresh.projectId) : null,
                firstItemBudgetCode: fresh.items[0]?.budgetCategoryCode,
              };
            }
          } catch {
            // Best-effort; fall through to whatever the outer snapshot says.
          }
        }
        const isLocked =
          !!pre && pre.status !== null && PURCHASE_ORDER_WRITE_LOCKED_STATUSES.has(pre.status);
        const originalStatus = pre?.status ?? null;

        // === Step 1: update PO content + status orchestration ===
        // We replicate update_purchase_order's auto-transition logic
        // inline rather than calling the tool layer because we need
        // tighter control over the final-status target (driven by
        // auto_send, not the caller's status arg).
        // PR #63 review HIGH: the line `description` is ALWAYS derived
        // from quote_reference (or the dated default). `notes` is
        // internal-only and goes to internalNotes ONLY — the schema
        // documents it as such, and using it as the public description
        // would silently expose internal notes to the vendor.
        const lineDescription = defaultLineDescription(a, new Date().toISOString().slice(0, 10));
        // Pick budget code: caller-supplied → pre-state first item → reject
        const budgetCode = a.budget_code ?? pre?.firstItemBudgetCode;
        if (!budgetCode) {
          return errorMarkdown(
            `**No budget code resolvable** for PO #${po.id}: pass \`budget_code\` explicitly, or the existing PO must have at least one line item with a budget category.`,
          );
        }
        const workflowSteps: string[] = [];

        // 1a. Demote if locked.
        if (isLocked && unlockIfLocked) {
          const demote = await getApi().transitionPurchaseOrderStatus({
            purchaseOrderId: po.id,
            status: 1,
          });
          if (!demote.success) {
            return errorMarkdown(
              `**Demote failed** for PO #${po.id}: ${String(demote.errors ?? "(no detail)")}. PO unchanged; no attachment uploaded.`,
            );
          }
          workflowSteps.push(`demoted ${poStatusLabel(pre!.status as number)} → Draft`);
        } else if (isLocked && !unlockIfLocked) {
          // Standard lock error message.
          return errorMarkdown(
            formatPurchaseOrderLockError(po.id, pre!.status as number),
          );
        }

        // 1b. Apply content via /save.
        const updateResult = await getApi().updatePurchaseOrder({
          purchaseOrderId: po.id,
          items: [
            {
              budgetCode,
              description: lineDescription,
              total: a.quote_total,
              notes: a.quote_reference
                ? `Quote ${a.quote_reference}`
                : undefined,
              internalNotes: a.notes,
            },
          ],
        });
        if (!updateResult.success) {
          // Restore lock state on failure (mirrors update_purchase_order).
          let restoreNote = "";
          if (isLocked && unlockIfLocked && pre?.status !== null) {
            const restore = await getApi().transitionPurchaseOrderStatus({
              purchaseOrderId: po.id,
              status: pre!.status as number,
            });
            restoreNote = restore.success
              ? `\n\n_Rolled back to **${poStatusLabel(pre!.status as number)}**._`
              : `\n\n**Rollback ALSO failed**. PO is now in Draft — fix manually in the BT UI.`;
          }
          return errorMarkdown(
            `**Update step failed** for PO #${po.id}: ${String(updateResult.errors ?? "(no detail)")}${restoreNote}`,
          );
        }
        workflowSteps.push(`applied content (new total $${a.quote_total.toFixed(2)})`);

        // 1c. Final status transition.
        // PR #63 review MEDIUM: skip when the PO is already at the
        // target status AND we didn't demote — avoids a redundant
        // Sent→Sent call that BT may treat as a duplicate vendor
        // email trigger.
        const currentAfterEdit = isLocked && unlockIfLocked ? 1 : originalStatus;
        if (finalStatusCode !== currentAfterEdit) {
          const transitionResult = await getApi().transitionPurchaseOrderStatus({
            purchaseOrderId: po.id,
            status: finalStatusCode,
          });
          if (!transitionResult.success) {
            // PR #63 review HIGH (architect): mirror update_purchase_order's
            // rollback on final-transition failure. When we entered via
            // the auto-transition path, the PO is now in Draft with the
            // edits applied — try to restore the original status so the
            // PO doesn't get stranded in a state the caller didn't ask
            // for. Report concretely either way.
            if (isLocked && unlockIfLocked && originalStatus !== null) {
              const rollback = await getApi().transitionPurchaseOrderStatus({
                purchaseOrderId: po.id,
                status: originalStatus,
              });
              const rollbackNote = rollback.success
                ? `\n\n_Rolled back to original **${poStatusLabel(originalStatus)}** state — your content edits remain applied but the status didn't move forward._`
                : `\n\n**Rollback to ${poStatusLabel(originalStatus)} ALSO failed** (${String(rollback.errors ?? "(no detail)")}). **PO is now in Draft with content applied — fix manually in the BT UI.**`;
              return errorMarkdown(
                `**Content updated** for PO #${po.id} but **status transition to ${poStatusLabel(finalStatusCode)} failed**: ${String(transitionResult.errors ?? "(no detail)")}.${rollbackNote}`,
              );
            }
            return errorMarkdown(
              `**Content updated** for PO #${po.id} but **status transition to ${poStatusLabel(finalStatusCode)} failed**: ${String(transitionResult.errors ?? "(no detail)")}. PO status is unchanged from ${poStatusLabel(currentAfterEdit ?? -1)}.`,
            );
          }
          workflowSteps.push(`status → ${poStatusLabel(finalStatusCode)}`);
        }

        // === Step 2: upload attachment ===
        // Independent of step 1. We surface partial failures here
        // distinctly: the PO is already correctly updated; attachment
        // is best-effort.
        let attachmentNote: string;
        try {
          const fileBuffer = Buffer.from(a.file_base64, "base64");
          // Project id from pre-state if available (typical), else
          // re-fetch the PO. Pre-state should always have it when the
          // outer handler succeeded.
          const projectId = pre?.projectId ?? (await fetchProjectId(po.id));
          const upload = await getApi().uploadAttachment({
            projectId,
            module: 1500,
            moduleId: po.id,
            fileBuffer,
            filename: a.filename,
            contentType: a.content_type ?? defaultContentType(a.filename),
          });
          // PR #63 review MEDIUM: validate downloadUrl before
          // interpolating into a markdown link. An unvalidated URL
          // from BT's response could include `)` that terminates the
          // link early (and injects trailing text into the LLM
          // context), or a `javascript:` scheme that some markdown
          // renderers will execute. The file domain is fixed; reject
          // anything that doesn't match.
          const safeDownloadUrl = typeof upload.downloadUrl === "string"
            && /^https:\/\/file\.buildtools\.app\//.test(upload.downloadUrl)
            && !upload.downloadUrl.includes(")")
            ? upload.downloadUrl
            : null;
          const downloadFragment = safeDownloadUrl
            ? ` [Download](${safeDownloadUrl})`
            : "";
          attachmentNote = `Attached **${escapeMarkdownInline(upload.name)}** (file_id ${upload.fileId}).${downloadFragment}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          attachmentNote = `⚠️ **Attachment upload failed**: ${escapeMarkdownInline(msg)}. PO was updated successfully; re-attach manually with \`upload_attachment\` or via the BT UI.`;
        }

        // === Compose the final result ===
        const headline = `Vendor quote applied to **PO #${po.id}** — ${workflowSteps.join(" → ")}.`;
        return markdown(`${headline}\n\n${attachmentNote}`);
      } catch (err) {
        return formatError(err, "apply_vendor_quote");
      }
    },
  );

  /** Resolve the project id behind a PO. Uses getPurchaseOrder. */
  async function fetchProjectId(poId: number): Promise<number> {
    const detail = await getApi().getPurchaseOrder(poId);
    if (!detail) throw new Error(`Could not re-fetch PO #${poId} for project lookup`);
    return Number(detail.projectId);
  }

  /**
   * Best-effort vendor-name lookup for the confirmation prompt. Returns
   * the company's name on success, or undefined if the lookup fails —
   * the prompt then falls back to showing just the numeric id. We never
   * fail the call over this; it's a UX polish, not a correctness gate.
   */
  async function lookupCompanyName(id: number): Promise<string | undefined> {
    try {
      const row = (await getApi().getCompany<{ name?: string }>(id)) ?? undefined;
      return row?.name?.replace(/<[^>]*>/g, "").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve `company_name` to a numeric `company_id` via the same
   * companies datatable that backs `search_companies`. Returns either
   * the resolved id, or an errorMarkdown describing the failure:
   *   - 0 matches  → "No company matches …"
   *   - >1 matches → list candidates so the caller can pick
   */
  async function resolveCompanyId(
    name: string,
  ): Promise<{ id: number; resolvedName: string } | ToolResult> {
    type CompaniesResp = {
      data?: Array<Record<string, unknown>>;
      recordsFiltered?: number;
    };

    const formatCandidates = (rows: Array<Record<string, unknown>>): string =>
      rows
        .slice(0, 10)
        .map((r) => {
          const dt = typeof r.DT_RowId === "string" ? r.DT_RowId.replace(/^row_/, "") : "?";
          const nm = escapeMarkdownInline(
            String(r.name ?? "").replace(/<[^>]*>/g, "").trim(),
          );
          const role = escapeMarkdownInline(String(r.type_name ?? "—"));
          return `  - #${dt} **${nm}** (${role})`;
        })
        .join("\n");

    // Initial query.
    const resp =
      (await getApi().searchCompanies<CompaniesResp>(name, { limit: 10 })) ??
      ({ data: [] } as CompaniesResp);
    const rows = resp.data ?? [];
    const safeName = escapeMarkdownInline(name);

    // Zero matches: best-effort retry with legal suffixes stripped (so
    // "Kai Muten, LLC" → "Kai Muten"). If the retry surfaces near-matches,
    // return them as candidates so the caller can pick rather than getting
    // a dead-end "no match" message.
    if (rows.length === 0) {
      const stripped = stripLegalSuffix(name);
      if (stripped !== name && stripped.length >= 2) {
        const retry =
          (await getApi().searchCompanies<CompaniesResp>(stripped, {
            limit: 10,
          })) ?? ({ data: [] } as CompaniesResp);
        const retryRows = retry.data ?? [];
        if (retryRows.length > 0) {
          return errorMarkdown(
            `**Error calling \`create_purchase_order\`**: no exact match for "${safeName}", but ${retryRows.length} near-match${retryRows.length === 1 ? "" : "es"} via "${escapeMarkdownInline(stripped)}". Pass an explicit \`company_id\`:\n${formatCandidates(retryRows)}`,
          );
        }
      }
      return errorMarkdown(
        `**Error calling \`create_purchase_order\`**: no company matches "${safeName}". Try \`search_companies\` to find the right vendor.`,
      );
    }

    // Ambiguity check: trust `recordsFiltered`, not the visible page. A
    // search for "Smith" with limit=10 might return 1 visible row but
    // actually match dozens — auto-resolving the top hit would create a
    // PO against the wrong vendor. Require BOTH the visible count AND
    // the filtered total to equal exactly 1 before resolving.
    const totalMatches = resp.recordsFiltered ?? rows.length;
    if (rows.length > 1 || totalMatches > 1) {
      return errorMarkdown(
        `**Error calling \`create_purchase_order\`**: "${safeName}" matched ${totalMatches} compan${totalMatches === 1 ? "y" : "ies"} (showing first ${Math.min(rows.length, 10)}). Pass an explicit \`company_id\`:\n${formatCandidates(rows)}`,
      );
    }

    const only = rows[0];
    const id = Number(
      typeof only.DT_RowId === "string" ? only.DT_RowId.replace(/^row_/, "") : NaN,
    );
    if (!Number.isFinite(id)) {
      return errorMarkdown(
        `**Error calling \`create_purchase_order\`**: matched company has no usable id (DT_RowId=${escapeMarkdownInline(only.DT_RowId)}).`,
      );
    }
    return {
      id,
      resolvedName: String(only.name ?? "").replace(/<[^>]*>/g, "").trim(),
    };
  }

  // -- create_task ----------------------------------------------------------
  const createTaskConfirmed = requiresConfirmation<CreateTaskArgs>(
    "create_task",
    (a) => `Create task **"${a.name}"** on project #${a.project_id}.`,
    async (a) => {
      try {
        const result = await getApi().createTask({
          name: a.name,
          projectId: a.project_id,
          status: String(a.status ?? 1),
          priority: String(a.priority ?? 1),
          dueDate: a.due_date,
          assignedTo: a.assigned_to ? String(a.assigned_to) : undefined,
          description: a.description,
        });
        if (result.success) return markdown(`Task **#${result.taskId}** created. ${result.message ?? ""}`);
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_task"); }
    },
  );

  // -- create_rfi -----------------------------------------------------------
  const createRFIConfirmed = requiresConfirmation<CreateRFIArgs>(
    "create_rfi",
    (a) => `Create RFI **"${a.subject}"** on project #${a.project_id}.`,
    async (a) => {
      try {
        const result = await getApi().createRFI({
          subject: a.subject,
          projectId: a.project_id,
          question: a.question,
          priority: String(a.priority ?? 1),
          assignedTo: a.assigned_to ? String(a.assigned_to) : undefined,
        });
        if (result.success) return markdown(`RFI **#${result.rfiId}** created. ${result.message ?? ""}`);
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_rfi"); }
    },
  );

  // -- create_invoice -------------------------------------------------------
  const createInvoiceConfirmed = requiresConfirmation<CreateInvoiceArgs>(
    "create_invoice",
    (a) => `Create vendor invoice **#${a.number}** for company #${a.company_id} (date ${a.date}, due ${a.due_date}).`,
    async (a) => {
      try {
        const result = await getApi().createInvoice({
          companyId: a.company_id,
          number: a.number,
          date: a.date,
          dueDate: a.due_date,
          paymentDays: a.payment_days,
          notes: a.notes,
        });
        if (result.success) return markdown(`Invoice **#${result.invoiceId}** created. ${result.message ?? ""}`);
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_invoice"); }
    },
  );

  // -- create_financial_statement -------------------------------------------
  const createFSConfirmed = requiresConfirmation<CreateFinancialStatementArgs>(
    "create_financial_statement",
    (a) => `Create financial statement **"${a.name}"** on project #${a.project_id} for **$${a.amount.toFixed(2)}**.`,
    async (a) => {
      try {
        const result = await getApi().createFinancialStatementWithAmount({
          projectId: a.project_id,
          name: a.name,
          amount: a.amount,
          notes: a.notes,
          status: a.status,
        });
        if (result.success) return markdown(`Financial statement **#${result.statementId}** created for $${result.amount ?? a.amount}.`);
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_financial_statement"); }
    },
  );

  // ---------------------------------------------------------------------
  // create_draw_request (PR #65) — workflow consolidator for new draws
  // ---------------------------------------------------------------------
  //
  // Inputs:
  //   project_id (req)
  //   EITHER amount (direct $) OR work_completed_to_date (tool computes)
  //   retainage_percent (optional, only used with work_completed_to_date)
  //   draw_number, name, due_date, notes, status, idempotency_key (all optional)
  //
  // The tool fetches prior FS on the project, computes the math when
  // work_completed_to_date is used, auto-names the draw, surfaces every
  // component in the confirmation prompt, and calls createFinancialStatement
  // with the final values.

  type CreateDrawRequestInternalArgs = CreateDrawRequestArgs & {
    _project_name?: string;
    _prior_draws_count?: number;
    _prior_draws_sum?: number;
    _resolved_amount?: number;
    _resolved_draw_number?: number;
    _resolved_name?: string;
  };

  const createDrawRequestConfirmed = requiresConfirmation<CreateDrawRequestInternalArgs>(
    "create_draw_request",
    (a) => {
      const projectLabel = a._project_name
        ? `**${escapeMarkdownInline(a._project_name)}** (#${a.project_id})`
        : `#${a.project_id}`;
      const lines: string[] = [];
      lines.push(`Create draw request on project ${projectLabel}.`);
      lines.push("");
      lines.push(`- **Draw name**: ${a._resolved_name ? escapeMarkdownInline(a._resolved_name) : "_(unresolved)_"}`);
      // PR #65 review MEDIUM 5: BT FS records have no standalone
      // "draw number" column — the # only lives inside the name
      // string. Showing a separate "Draw #: N" line when the caller
      // overrode `name` would imply BT will store the number
      // separately, which it won't. Only render when the auto-name
      // is being used (i.e. caller didn't override `name`).
      if (a._resolved_draw_number !== undefined && a.name === undefined) {
        lines.push(`- **Draw #**: ${a._resolved_draw_number}`);
      }
      if (a._prior_draws_count !== undefined && a._prior_draws_sum !== undefined) {
        lines.push(`- **Prior draws**: ${a._prior_draws_count} statement(s) totalling $${a._prior_draws_sum.toFixed(2)}`);
      }
      if (a.work_completed_to_date !== undefined) {
        const retainage = a.retainage_percent ?? 0;
        const billable = a.work_completed_to_date * (1 - retainage / 100);
        lines.push(
          `- **Work completed to date**: $${a.work_completed_to_date.toFixed(2)}`,
          `- **Retainage**: ${retainage}% ($${(a.work_completed_to_date - billable).toFixed(2)} held back)`,
          `- **Billable to date (after retainage)**: $${billable.toFixed(2)}`,
          `- **− Prior draws**: $${(a._prior_draws_sum ?? 0).toFixed(2)}`,
        );
      }
      lines.push(`- **This draw amount**: **$${(a._resolved_amount ?? 0).toFixed(2)}**`);
      const cumulative = (a._prior_draws_sum ?? 0) + (a._resolved_amount ?? 0);
      lines.push(`- **Cumulative after**: $${cumulative.toFixed(2)}`);
      const statusLabel = a.status === undefined ? "Draft (default)" : `status code ${a.status}`;
      lines.push(`- **Statement status**: ${statusLabel}`);
      return lines.join("\n");
    },
    async (a) => {
      try {
        const finalAmount = a._resolved_amount;
        const finalName = a._resolved_name;
        if (finalAmount === undefined || finalName === undefined) {
          return errorMarkdown(
            `**Error calling \`create_draw_request\`**: amount or name was not resolved (internal — outer handler should have set these).`,
          );
        }
        if (finalAmount <= 0) {
          return errorMarkdown(
            `**Computed draw amount is non-positive** ($${finalAmount.toFixed(2)}). This typically means prior draws already cover (or exceed) the cumulative work. Verify \`work_completed_to_date\` or pass \`amount\` directly.`,
          );
        }
        const result = await getApi().createFinancialStatementWithAmount({
          projectId: a.project_id,
          name: finalName,
          amount: finalAmount,
          notes: a.notes,
          status: a.status ?? 1,
        });
        if (!result.success) {
          return errorMarkdown(
            `**Failed to create draw request** on project #${a.project_id}: ${String(result.errors ?? "(no detail)")}`,
          );
        }
        return markdown(
          `Draw request **#${result.statementId}** ("${escapeMarkdownInline(finalName)}") created on project #${a.project_id} for **$${result.amount ?? finalAmount.toFixed(2)}**. Status: ${a.status === undefined ? "Draft" : `code ${a.status}`}.`,
        );
      } catch (err) {
        return formatError(err, "create_draw_request");
      }
    },
  );

  // -- delete_financial_statement -------------------------------------------
  const deleteFSConfirmed = requiresConfirmation<DeleteFinancialStatementArgs>(
    "delete_financial_statement",
    (a) => `Delete **${a.statement_ids.length}** financial statement(s) (IDs: ${a.statement_ids.join(", ")}) from project #${a.project_id}.`,
    async (a) => {
      try {
        const result = await getApi().deleteFinancialStatement(a.statement_ids, a.project_id);
        if (result.success) return markdown(`Deleted ${result.succeeded} statement(s) successfully.`);
        return errorMarkdown(`Delete failed: succeeded=${result.succeeded}, failed=${result.failed}`);
      } catch (err) { return formatError(err, "delete_financial_statement"); }
    },
  );

  // -- create_service -------------------------------------------------------
  const createServiceConfirmed = requiresConfirmation<CreateServiceArgs>(
    "create_service",
    (a) => `Create service **"${a.name}"** on project #${a.project_id}.`,
    async (a) => {
      try {
        const result = await getApi().createService({
          name: a.name,
          projectId: a.project_id,
          description: a.description,
          status: String(a.status ?? 1),
          dueDate: a.due_date,
          assignedTo: a.assigned_to ? String(a.assigned_to) : undefined,
        });
        if (result.success) return markdown(`Service **#${result.serviceId}** created. ${result.message ?? ""}`);
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_service"); }
    },
  );

  // -- create_selection -----------------------------------------------------
  const CreateSelectionSchema = z.object({
    project_id: z.number().describe("BuildTools project ID."),
    name: z.string().describe("Selection item name (e.g. 'Countertop', 'Faucet')."),
    budget_category_id: z.number().describe("Budget category ID. Use list_selection_categories to find valid IDs."),
    status: z.number().optional().describe("1=Open (default), 2=Selected, 3=Approved, 4=Rejected, 5=Complete."),
    location_room_id: z.number().optional().describe("Location/room ID. Default: 2 (Non-Specified)."),
    notes: z.string().optional(),
    due_date: z.string().optional().describe("MM/DD/YYYY format."),
    items: z
      .array(
        z.object({
          title: z.string().describe("Option name (e.g. 'Steel Grey Granite')."),
          price: z.union([z.number(), z.string()]).optional().describe("Option price in dollars (number or string)."),
          description: z.string().optional(),
          model: z.string().optional().describe("Model number or SKU."),
          url: z.string().optional().describe("Product URL."),
          company_id: z.union([z.number(), z.string()]).optional().describe("Vendor company ID."),
          selected: z.boolean().optional().describe("True if this is the chosen option. Default: true."),
        }),
      )
      .optional()
      .describe("Selection options/choices. Each has its own price + vendor. Omit for an empty selection (add options later via the UI)."),
    confirmation_id: z.string().optional(),
  });
  type CreateSelectionArgs = z.infer<typeof CreateSelectionSchema>;

  const createSelectionConfirmed = requiresConfirmation<CreateSelectionArgs>(
    "create_selection",
    (a) => {
      const itemCount = a.items?.length ?? 0;
      const itemSummary = itemCount > 0
        ? ` with ${itemCount} option${itemCount === 1 ? "" : "s"}`
        : "";
      return `Create selection **"${a.name}"** on project #${a.project_id} (category #${a.budget_category_id})${itemSummary}.`;
    },
    async (a) => {
      try {
        const result = await getApi().createSelection({
          projectId: a.project_id,
          name: a.name,
          budgetCategoryId: a.budget_category_id,
          status: a.status,
          locationRoomId: a.location_room_id,
          notes: a.notes,
          dueDate: a.due_date,
          items: a.items?.map((it) => ({
            title: it.title,
            price: it.price,
            description: it.description,
            model: it.model,
            url: it.url,
            companyId: it.company_id,
            selected: it.selected,
          })),
        });
        if (result.success) {
          const itemsNote = result.itemsSaved !== undefined && result.itemsSaved > 0
            ? ` with ${result.itemsSaved} option${result.itemsSaved === 1 ? "" : "s"}`
            : "";
          return markdown(`Selection **#${result.selectionId}** created${itemsNote}.`);
        }
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_selection"); }
    },
  );

  // -- delete_selection -----------------------------------------------------
  const DeleteSelectionSchema = z.object({
    selection_ids: z.array(z.number()).min(1).describe("Array of selection IDs to delete."),
    project_id: z.number().describe("BuildTools project ID (required for session scoping)."),
    confirmation_id: z.string().optional(),
  });
  type DeleteSelectionArgs = z.infer<typeof DeleteSelectionSchema>;

  const deleteSelectionConfirmed = requiresConfirmation<DeleteSelectionArgs>(
    "delete_selection",
    (a) => `Delete **${a.selection_ids.length}** selection(s) (IDs: ${a.selection_ids.join(", ")}) from project #${a.project_id}.`,
    async (a) => {
      try {
        const result = await getApi().deleteSelection(a.selection_ids, a.project_id);
        if (result.success) return markdown(`Deleted ${result.succeeded} selection(s) successfully.`);
        return errorMarkdown(`Delete failed: succeeded=${result.succeeded}, failed=${result.failed}`);
      } catch (err) { return formatError(err, "delete_selection"); }
    },
  );

  // -- create_budget_item ---------------------------------------------------
  const CreateBudgetItemSchema = z.object({
    project_id: z.number().describe("BuildTools project ID."),
    budget_category_id: z.number().describe("Leaf budget category ID (e.g. 1614 = '4520 - Interior Trim Materials'). Use list_selection_categories to find valid IDs."),
    if_exists: z
      .enum(["skip", "error", "force"])
      .optional()
      .describe(
        "Behavior when a budget row for (project_id, budget_category_id) already exists. \"skip\" (default) returns the existing row's id without writing. \"error\" returns a tool error. \"force\" inserts a duplicate — NOT recommended (breaks Power BI's m budgets_selections measure which keys on category||project).",
      ),
    confirmation_id: z.string().optional(),
  });
  type CreateBudgetItemArgs = z.infer<typeof CreateBudgetItemSchema>;

  const createBudgetItemConfirmed = requiresConfirmation<CreateBudgetItemArgs>(
    "create_budget_item",
    (a) => `Add budget category #${a.budget_category_id} to project #${a.project_id}${a.if_exists ? ` (if_exists: ${a.if_exists})` : ""}.`,
    async (a) => {
      try {
        const result = await getApi().createBudgetItem({
          projectId: a.project_id,
          budgetCategoryId: a.budget_category_id,
          ifExists: a.if_exists,
        });
        if (result.success) {
          if (result.existed) {
            return markdown(
              `Budget item **#${result.budgetItemId}** already exists for category #${a.budget_category_id} on project #${a.project_id}. Returning existing row (no write). Use update_budget_item to change its amount.`,
            );
          }
          return markdown(
            `Budget item **#${result.budgetItemId}** created. Use update_budget_item to set its amount.`,
          );
        }
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "create_budget_item"); }
    },
  );

  // -- update_budget_item ---------------------------------------------------
  const UpdateBudgetItemSchema = z.object({
    project_id: z.number().describe("BuildTools project ID."),
    budget_item_id: z.number().describe("Budget item ID (from list_budget)."),
    budget_category_id: z.number().describe("Budget category ID — must match the item's existing category."),
    amount_working: z.number().optional().describe("New working budget amount in dollars."),
    is_allowance: z.boolean().optional().describe("Mark this budget item as a customer-facing allowance."),
    confirmation_id: z.string().optional(),
  });
  type UpdateBudgetItemArgs = z.infer<typeof UpdateBudgetItemSchema>;

  const updateBudgetItemConfirmed = requiresConfirmation<UpdateBudgetItemArgs>(
    "update_budget_item",
    (a) => {
      const parts: string[] = [];
      if (a.amount_working !== undefined) parts.push(`amount = $${a.amount_working.toFixed(2)}`);
      if (a.is_allowance !== undefined) parts.push(`allowance = ${a.is_allowance}`);
      return `Update budget item #${a.budget_item_id} on project #${a.project_id}: ${parts.join(", ") || "(no changes)"}.`;
    },
    async (a) => {
      try {
        const result = await getApi().updateBudgetItem({
          projectId: a.project_id,
          budgetItemId: a.budget_item_id,
          budgetCategoryId: a.budget_category_id,
          amountWorking: a.amount_working,
          isAllowance: a.is_allowance,
        });
        if (result.success) return markdown(`Budget item **#${a.budget_item_id}** updated.`);
        return errorMarkdown(`Failed: ${JSON.stringify(result.errors)}`);
      } catch (err) { return formatError(err, "update_budget_item"); }
    },
  );

  // -- delete_budget_item ---------------------------------------------------
  const DeleteBudgetItemSchema = z.object({
    project_id: z.number().describe("BuildTools project ID."),
    budget_item_id: z.number().describe("Budget item ID to delete."),
    confirmation_id: z.string().optional(),
  });
  type DeleteBudgetItemArgs = z.infer<typeof DeleteBudgetItemSchema>;

  const deleteBudgetItemConfirmed = requiresConfirmation<DeleteBudgetItemArgs>(
    "delete_budget_item",
    (a) => `Delete budget item #${a.budget_item_id} from project #${a.project_id}.`,
    async (a) => {
      try {
        const result = await getApi().deleteBudgetItem(a.budget_item_id, a.project_id);
        if (result.success) return markdown(`Budget item **#${a.budget_item_id}** deleted (${result.succeeded} succeeded).`);
        return errorMarkdown(`Delete failed: succeeded=${result.succeeded}, failed=${result.failed}, errors=${JSON.stringify(result.errors)?.substring(0, 200)}`);
      } catch (err) { return formatError(err, "delete_budget_item"); }
    },
  );

  // -- Build ToolDefinition array ------------------------------------------

  function makeTool(
    name: string,
    description: string,
    schema: z.ZodTypeAny,
    confirmed: (
      args: any,
      store: ConfirmationStore,
      sessionId?: string,
    ) => Promise<ToolResult>,
    permission: string,
  ): ToolDefinition {
    return {
      name,
      description,
      inputSchema: zodToJsonSchema(schema),
      permission,
      // _api is intentionally unused — mutation tools access the API via
      // closure over getApi() to ensure the lazy singleton is resolved at
      // execution time, not at registration time.
      handler: async (rawArgs: unknown, _api: BuildToolsAPI) => {
        // confirmed() must only receive Zod-validated data — the confirmation
        // framework stores and replays these args on the second call.
        const parsed = schema.safeParse(rawArgs ?? {});
        if (!parsed.success) return formatZodError(parsed.error, name);
        return confirmed(parsed.data, store, sessionId);
      },
    };
  }

  return [
    makeTool(
      "create_project",
      "Create a new BuildTools project. Requires confirmation. Default status: Omega (6).",
      CreateProjectSchema,
      createProjectConfirmed,
      "write:project",
    ),
    makeTool(
      "create_change_order",
      "Create a change order on a project. Requires confirmation. Default status: Draft (1).",
      CreateChangeOrderSchema,
      createCOConfirmed,
      "write:financial",
    ),
    // create_purchase_order — custom wrapper (not makeTool) so we can
    // resolve `company_name` → `company_id` *before* the confirmation
    // prompt fires. The framework otherwise replays the stored args
    // verbatim on the second (confirm) call, so resolution has to happen
    // up-front to avoid a double-lookup and to ensure the prompt names
    // the actual vendor.
    {
      name: "create_purchase_order",
      description:
        "Create a purchase order for a vendor on a project. Requires confirmation. " +
        "Provide either `company_id` (preferred — exact) OR `company_name` (resolved server-side via fuzzy match; errors if 0 or >1 matches).",
      inputSchema: zodToJsonSchema(CreatePurchaseOrderSchema),
      permission: "write:financial",
      handler: async (rawArgs: unknown, _api: BuildToolsAPI) => {
        const parsed = CreatePurchaseOrderSchema.safeParse(rawArgs ?? {});
        if (!parsed.success) return formatZodError(parsed.error, "create_purchase_order");
        const data = parsed.data;

        let companyId = data.company_id;
        // Only carry a `company_name` into the confirmation prompt when we
        // resolved it ourselves — a user-supplied `company_name` accompanying
        // an explicit `company_id` is ignored (id wins) and shouldn't be
        // shown back to them as if it were authoritative.
        let resolvedName: string | undefined;
        // The caller's ORIGINAL `company_name` input (only set when we
        // resolved). Threaded into the confirmation prompt so the user
        // sees "Resolved 'Kai Mutn' → #977 (Kai Muten, LLC)" instead of
        // a silent substitution.
        let resolvedFrom: string | undefined;
        if (companyId === undefined) {
          if (!data.company_name) {
            return errorMarkdown(
              "**Error calling `create_purchase_order`**: provide either `company_id` or `company_name`.",
            );
          }
          const result = await resolveCompanyId(data.company_name);
          if ("content" in result) return result; // errorMarkdown branch
          companyId = result.id;
          resolvedName = result.resolvedName;
          resolvedFrom = data.company_name;
        }

        return createPOConfirmed(
          {
            ...data,
            company_id: companyId,
            company_name: resolvedName,
            _resolved_from: resolvedFrom,
          },
          store,
          sessionId,
        );
      },
    },
    // update_purchase_order — custom wrapper (not makeTool) so the
    // confirmation prompt can show the resolved vendor name when
    // company_id is being changed. Without this lookup the user sees
    // only a raw numeric id ("change vendor → #4271") with no way to
    // verify they picked the right vendor.
    {
      name: "update_purchase_order",
      description:
        "[v1 2026-06-23] Update an existing purchase order — rename, change vendor, status, description, or REPLACE line items. " +
        "Items[] omitted preserves existing; `[]` clears all; otherwise fully replaces (no partial diff). " +
        "Each item requires `budget_category_id` (use `list_budget` to find IDs on the parent project). " +
        "Status omitted preserves current — BuildTools doesn't merge partial payloads so omitting + not echoing back would reset it. " +
        "Requires confirmation.",
      inputSchema: zodToJsonSchema(UpdatePurchaseOrderSchema),
      permission: "write:financial",
      handler: async (rawArgs: unknown, _api: BuildToolsAPI) => {
        const parsed = UpdatePurchaseOrderSchema.safeParse(rawArgs ?? {});
        if (!parsed.success) return formatZodError(parsed.error, "update_purchase_order");
        const data = parsed.data;

        // Idempotency check (PR #67 — uses shared helper). Strips
        // fields that don't represent the semantic write BT will
        // apply: confirmation_id (rotates per call), idempotency_key
        // (already in the cache key), and verify (a client-side
        // post-write check — if a caller retries with verify:false
        // after timing out on verify:true, it's the SAME write).
        const { confirmation_id: _ci, idempotency_key: _ik, verify: _v, ...semantic } = data;
        const idemContext = checkIdempotency({
          toolName: "update_purchase_order",
          idempotencyStore,
          sessionId,
          idempotencyKey: data.idempotency_key,
          fingerprintInput: semantic,
        });
        if (idemContext.replayResult) return idemContext.replayResult;
        if (idemContext.mismatchError) return idemContext.mismatchError;

        // Resolve the status label → code ONCE up-front, fail-fast on
        // unknown labels (Zod blocks them already, but a programmatic
        // internal caller bypassing the schema would otherwise reach
        // updatePurchaseOrder with the status silently dropped). Both
        // the prompt builder and the executor read the resolved code
        // off `_resolved_status_code` rather than re-resolving.
        let resolvedStatusCode: number | undefined;
        if (data.status !== undefined) {
          try {
            resolvedStatusCode = resolvePoStatusCode(data.status);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return errorMarkdown(
              `**Error calling \`update_purchase_order\`**: ${msg}`,
            );
          }
        }

        // If the caller is changing the vendor AND hasn't already gone
        // through the confirmation handshake (i.e. first call), resolve
        // the company name so the prompt shows it. Skip the lookup on
        // the second call — the args replayed by the framework already
        // carry the resolved name.
        let resolvedCompanyName: string | undefined;
        if (data.company_id !== undefined && !data.confirmation_id) {
          resolvedCompanyName = await lookupCompanyName(data.company_id);
        }

        // Pre-snapshot: one PO fetch on the FIRST call so the prompt
        // can show the auto-transition plan. Gated on `unlock_if_locked`
        // because every other code path either doesn't need it
        // (status-only changes route blindly through /status/update,
        // the API method does its own lock check for /save calls) or
        // needs it later in the executor (items_append delta verify).
        // Skipping it on the common path keeps the prompt phase fast.
        let preSnapshot: UpdatePOInternalArgs["_pre_snapshot"];
        if (!data.confirmation_id && data.unlock_if_locked) {
          try {
            const pre = await getApi().getPurchaseOrder(data.purchase_order_id);
            preSnapshot = pre
              ? {
                  status: pre.status,
                  totalNumeric: pre.totalNumeric,
                  itemCount: pre.items.length,
                }
              : null;
          } catch {
            preSnapshot = null;
          }
        }

        const result = await updatePOConfirmed(
          {
            ...data,
            _resolved_company_name: resolvedCompanyName,
            _resolved_status_code: resolvedStatusCode,
            _pre_snapshot: preSnapshot,
          },
          store,
          sessionId,
        );

        // Cache the result on success only — never on confirmation
        // prompts (no commit happened yet) and never on errors (the
        // caller should be able to retry without hitting a cached
        // failure). `isError === true` is the failure marker;
        // confirmation prompts have isError undefined AND no
        // confirmation_id was consumed — but distinguishing those at
        // this layer is hard. We use a simpler proxy: cache only when
        // this WAS the execute call (confirmation_id was passed in)
        // AND the result is not an error.
        storeIdempotencyResult({
          context: idemContext,
          result,
          isExecuteCall: !!data.confirmation_id,
        });
        return result;
      },
    },
    // transition_purchase_order_status — standalone status-only tool
    // (PR #62). Custom wrapper (not makeTool) so we can resolve the
    // status label → code once and pass through to the confirmed
    // executor and prompt.
    {
      name: "transition_purchase_order_status",
      description:
        "Transition a purchase order's status via BuildTools' workflow endpoint (`/purchase-orders/status/update`). " +
        "Unlike status changes via `update_purchase_order` (which run through `/save` and refuse on Confirmed POs), this endpoint accepts ALL transitions including Confirmed → Draft. " +
        "Requires confirmation. " +
        "Use for: pure status workflow steps (sending a Draft PO, cancelling a Sent PO, demoting a Confirmed PO for editing). " +
        "WARNING: Promoting TO Confirmed (3) requires a canvas-drawn signature this tool doesn't supply — that transition will fail with 'Signature field is required'. The vendor advances the PO to Confirmed on their side after acknowledging.",
      inputSchema: zodToJsonSchema(TransitionPurchaseOrderStatusSchema),
      permission: "write:financial",
      handler: async (rawArgs: unknown, _api: BuildToolsAPI) => {
        const parsed = TransitionPurchaseOrderStatusSchema.safeParse(rawArgs ?? {});
        if (!parsed.success) return formatZodError(parsed.error, "transition_purchase_order_status");
        const data = parsed.data;
        let resolvedStatusCode: number | undefined;
        try {
          resolvedStatusCode = resolvePoStatusCode(data.status);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorMarkdown(
            `**Error calling \`transition_purchase_order_status\`**: ${msg}`,
          );
        }

        // Idempotency check (PR #67 — shared helper).
        const { confirmation_id: _ci, idempotency_key: _ik, ...semantic } = data;
        const idemContext = checkIdempotency({
          toolName: "transition_purchase_order_status",
          idempotencyStore,
          sessionId,
          idempotencyKey: data.idempotency_key,
          fingerprintInput: semantic,
        });
        if (idemContext.replayResult) return idemContext.replayResult;
        if (idemContext.mismatchError) return idemContext.mismatchError;

        // PR #64 review fix (MEDIUM): fetch current status for the
        // confirmation prompt. Best-effort — a failed fetch leaves
        // _current_status undefined and the describer renders
        // "(could not fetch current state)" rather than blocking.
        // Only on the FIRST call (the framework replays stored args
        // on the second call with the snapshot already attached).
        let currentStatus: number | null | undefined;
        let poName: string | undefined;
        if (!data.confirmation_id) {
          try {
            const detail = await getApi().getPurchaseOrder(data.purchase_order_id);
            if (detail) {
              currentStatus = detail.status;
              poName = detail.name;
            } else {
              currentStatus = null;
            }
          } catch {
            currentStatus = null;
          }
        }

        const result = await transitionPOStatusConfirmed(
          {
            ...data,
            _resolved_status_code: resolvedStatusCode,
            _current_status: currentStatus,
            _po_name: poName,
          },
          store,
          sessionId,
        );

        storeIdempotencyResult({
          context: idemContext,
          result,
          isExecuteCall: !!data.confirmation_id,
        });
        return result;
      },
    },
    // apply_vendor_quote (PR #63) — multi-step workflow consolidator.
    // Custom handler because of vendor + PO resolution + pre-snapshot.
    {
      name: "apply_vendor_quote",
      description:
        "Apply a vendor's quote PDF to an existing purchase order in ONE call. Collapses the 6-round-trip workflow (find vendor → find PO → check state → update items → attach PDF → send) into a single confirmed operation. " +
        "Resolves vendor by name OR id; resolves target PO by id OR by (project_id + vendor). Disambiguation prompts returned on ambiguity. " +
        "Replaces existing line items with a SINGLE line at the new total (use update_purchase_order for per-line granularity). Attaches the PDF to the PO. Optionally transitions to Sent so the vendor re-acknowledges. " +
        "Inherits unlock_if_locked + idempotency_key from update_purchase_order semantics.",
      inputSchema: zodToJsonSchema(ApplyVendorQuoteSchema),
      permission: "write:financial",
      handler: async (rawArgs: unknown, _api: BuildToolsAPI) => {
        const parsed = ApplyVendorQuoteSchema.safeParse(rawArgs ?? {});
        if (!parsed.success) return formatZodError(parsed.error, "apply_vendor_quote");
        const data = parsed.data;

        // Reject `data:` prefix (mirrors upload_attachment defense).
        if (data.file_base64.toLowerCase().startsWith("data:")) {
          return errorMarkdown(
            `**Error calling \`apply_vendor_quote\`**: \`file_base64\` must be raw base64 — strip any \`data:image/...;base64,\` URL prefix before passing.`,
          );
        }

        // PR #63 review LOW: estimate decoded size from base64 length
        // BEFORE allocating the Buffer, so a 100 MB upload is rejected
        // without actually allocating 100 MB. Final precise check
        // happens after if the estimate is close to the cap.
        const approxBytes = Math.ceil(
          data.file_base64.replace(/=+$/, "").length * 0.75,
        );
        if (approxBytes > APPLY_VENDOR_QUOTE_MAX_BYTES + 1024) {
          return errorMarkdown(
            `**File too large**: ~${(approxBytes / 1024 / 1024).toFixed(1)} MB exceeds the 25 MB cap.`,
          );
        }
        // Compute decoded byte length, enforce 25 MB cap precisely.
        let decodedBytes: number;
        try {
          decodedBytes = Buffer.from(data.file_base64, "base64").byteLength;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorMarkdown(`**Error calling \`apply_vendor_quote\`**: could not decode \`file_base64\`: ${msg}`);
        }
        if (decodedBytes > APPLY_VENDOR_QUOTE_MAX_BYTES) {
          return errorMarkdown(
            `**File too large**: ${(decodedBytes / 1024 / 1024).toFixed(1)} MB exceeds the 25 MB cap.`,
          );
        }

        // Idempotency check (PR #67 — shared helper). file_base64 is
        // substituted by its SHA-256 in the fingerprint to keep the
        // cache key small while still detecting different file
        // contents as different writes.
        // PR #67 review HIGH: skip the SHA computation entirely on
        // the common path where idempotency_key isn't passed —
        // base64 SHA on a ~33 MB file is tens of ms; not worth it
        // when the helper would short-circuit anyway.
        const { confirmation_id: _ci, idempotency_key: _ik, file_base64: _fb, ...semantic } = data;
        const idemContext = checkIdempotency({
          toolName: "apply_vendor_quote",
          idempotencyStore,
          sessionId,
          idempotencyKey: data.idempotency_key,
          fingerprintInput: data.idempotency_key
            ? {
                ...semantic,
                _file_sha256: createHash("sha256").update(data.file_base64).digest("hex"),
              }
            : semantic,
        });
        if (idemContext.replayResult) return idemContext.replayResult;
        if (idemContext.mismatchError) return idemContext.mismatchError;

        // === First-call resolution (skip on confirmation_id replay
        //     — the framework already has the resolved args stored).
        let resolvedVendor: { id: number; name: string } | undefined;
        let resolvedPo: { id: number; name?: string } | undefined;
        let preState: ApplyVendorQuoteInternalArgs["_pre_state"];
        if (!data.confirmation_id) {
          // 1. Resolve vendor
          const vRes = await resolveVendorCompany(data);
          if (!vRes.ok) return vRes.result;
          resolvedVendor = vRes.value;

          // 2. Resolve target PO
          const pRes = await resolveTargetPurchaseOrder(data, resolvedVendor);
          if (!pRes.ok) return pRes.result;
          resolvedPo = pRes.value;

          // 3. Pre-fetch PO detail (status + total + items + vendor + project).
          const detail = await getApi().getPurchaseOrder(resolvedPo.id);
          if (!detail) {
            return errorMarkdown(
              `**Could not fetch PO #${resolvedPo.id}** — verify the PO exists and is accessible.`,
            );
          }
          preState = {
            status: detail.status,
            totalNumeric: detail.totalNumeric,
            itemCount: detail.items.length,
            companyId: detail.companyId,
            companyName: detail.companyName,
            // PR #63 review MEDIUM: preserve null (not coerce to 0
            // via Number()) so the executor's `pre.projectId ??
            // fetchProjectId(...)` fallback actually fires when BT's
            // form omits the project id field.
            projectId: detail.projectId != null ? Number(detail.projectId) : null,
            firstItemBudgetCode: detail.items[0]?.budgetCategoryCode,
          };

          // 4. Vendor/PO consistency check.
          // PR #63 review HIGH: a PO with companyId=null (vendor-unassigned)
          // must NOT silently pass this gate — that lets a caller
          // overwrite any unassigned PO with arbitrary content under
          // ANY vendor id. Treat null as a definite mismatch against
          // any specific resolved vendor.
          if (
            detail.companyId === null ||
            resolvedVendor.id !== detail.companyId
          ) {
            const detailVendorLabel = detail.companyId === null
              ? "_(no vendor assigned)_"
              : `**${escapeMarkdownInline(detail.companyName ?? `#${detail.companyId}`)}** (#${detail.companyId})`;
            return errorMarkdown(
              `**Vendor mismatch**: PO #${resolvedPo.id} is for vendor ${detailVendorLabel}, not **${escapeMarkdownInline(resolvedVendor.name)}** (#${resolvedVendor.id}). Either pass \`company_id\` matching the PO, or change the vendor first with \`update_purchase_order\`.`,
            );
          }

          // 5. Reject already-rejected POs.
          if (detail.status === 4) {
            return errorMarkdown(
              `**PO #${resolvedPo.id} is Rejected** — vendor already declined. Create a new PO with \`create_purchase_order\` instead of applying a quote to a closed one.`,
            );
          }
        }

        const result = await applyVendorQuoteConfirmed(
          {
            ...data,
            _resolved_vendor: resolvedVendor,
            _resolved_po: resolvedPo,
            _pre_state: preState,
            _decoded_bytes: decodedBytes,
          },
          store,
          sessionId,
        );

        storeIdempotencyResult({
          context: idemContext,
          result,
          isExecuteCall: !!data.confirmation_id,
        });
        return result;
      },
    },
    makeTool(
      "create_task",
      "Create a task on a project. Requires confirmation. Status: 1=Open, 2=In Progress, 3=Complete.",
      CreateTaskSchema,
      createTaskConfirmed,
      "write:tasks",
    ),
    makeTool(
      "create_rfi",
      "Create an RFI (Request for Information) on a project. Requires confirmation.",
      CreateRFISchema,
      createRFIConfirmed,
      "write:tasks",
    ),
    makeTool(
      "create_invoice",
      "Create a vendor invoice. Requires confirmation. Note: 'invoices' in BuildTools are vendor bills, not client billing (that's financial statements).",
      CreateInvoiceSchema,
      createInvoiceConfirmed,
      "write:financial",
    ),
    makeTool(
      "create_financial_statement",
      "Create a financial statement (client bill / draw request) on a project with a specific dollar amount. Requires confirmation. Use ASCII-only titles.",
      CreateFinancialStatementSchema,
      createFSConfirmed,
      "write:financial",
    ),
    // create_draw_request (PR #65) — workflow consolidator for billings.
    // Custom handler because of pre-fetch (prior FS), math, and
    // auto-naming.
    {
      name: "create_draw_request",
      description:
        "Create a new project draw request (financial statement) in ONE call. " +
        "Looks up prior draws on the project, computes the new draw number (max+1), " +
        "auto-names the statement, and creates it with the right amount. " +
        "Pass EITHER `amount` (direct $ — caller already did the math) OR `work_completed_to_date` " +
        "(tool computes `(work × (1 - retainage/100)) − prior_draws_sum`). " +
        "Defaults to Draft status so the PM can review in the BT UI before sending. " +
        "Inherits idempotency semantics from the other consolidator tools.",
      inputSchema: zodToJsonSchema(CreateDrawRequestSchema),
      permission: "write:financial",
      handler: async (rawArgs: unknown, _api: BuildToolsAPI) => {
        const parsed = CreateDrawRequestSchema.safeParse(rawArgs ?? {});
        if (!parsed.success) return formatZodError(parsed.error, "create_draw_request");
        const data = parsed.data;

        // Idempotency check (PR #67 — shared helper).
        const { confirmation_id: _ci, idempotency_key: _ik, ...semantic } = data;
        const idemContext = checkIdempotency({
          toolName: "create_draw_request",
          idempotencyStore,
          sessionId,
          idempotencyKey: data.idempotency_key,
          fingerprintInput: semantic,
        });
        if (idemContext.replayResult) return idemContext.replayResult;
        if (idemContext.mismatchError) return idemContext.mismatchError;

        // === First-call resolution (skip on confirmation_id replay) ===
        let projectName: string | undefined;
        let priorDrawsCount: number | undefined;
        let priorDrawsSum: number | undefined;
        let resolvedDrawNumber: number | undefined;
        let resolvedAmount: number | undefined;
        let resolvedName: string | undefined;
        if (!data.confirmation_id) {
          // Project lookup (best-effort for the prompt).
          try {
            const project = await getApi().getProject<{
              name?: string;
              title?: string;
            }>(data.project_id);
            const rawName = project?.name ?? project?.title ?? "";
            projectName = rawName.replace(/<[^>]*>/g, "").trim() || undefined;
          } catch {
            // ignore — prompt will show only the id
          }

          // Prior FS lookup — required for next draw # and sum.
          type FsResult = {
            statements: Array<{ id: string; name: string; amount: number }>;
          };
          let fsResult: FsResult | null = null;
          try {
            fsResult = (await getApi().getFinancialStatements(data.project_id)) as FsResult;
          } catch (err) {
            return errorMarkdown(
              `**Could not list prior draws** on project #${data.project_id}: ${err instanceof Error ? err.message : String(err)}. Fix and retry, or pass \`amount\` + \`draw_number\` directly to skip the lookup.`,
            );
          }
          const priorStatements = fsResult?.statements ?? [];
          priorDrawsCount = priorStatements.length;
          // PR #65 review LOW 7: round the accumulated sum to cents
          // before downstream subtraction. A 12-statement project
          // each at $33,333.33 accumulates to $399,999.96 raw due to
          // IEEE 754 — and the prompt rendered the raw sum, while
          // the executor's amount used post-subtraction Math.round.
          // Round here so prompt and executor agree on display.
          const rawSum = priorStatements.reduce(
            (acc: number, s: { amount: number }) =>
              acc + (typeof s.amount === "number" && Number.isFinite(s.amount) ? s.amount : 0),
            0,
          );
          priorDrawsSum = Math.round(rawSum * 100) / 100;

          // Next draw number. Caller can override; otherwise auto.
          if (data.draw_number !== undefined) {
            resolvedDrawNumber = data.draw_number;
          } else {
            // Try to parse "Draw #N" from existing statement names;
            // fall back to count+1 if nothing parseable.
            const maxParsed = priorStatements.reduce(
              (max: number, s: { name: string }) => {
                const m = (s.name ?? "").match(/Draw\s*#?(\d+)/i);
                return m ? Math.max(max, parseInt(m[1], 10)) : max;
              },
              0,
            );
            resolvedDrawNumber = (maxParsed > 0 ? maxParsed : priorStatements.length) + 1;
          }

          // Amount resolution.
          if (data.amount !== undefined) {
            resolvedAmount = data.amount;
          } else if (data.work_completed_to_date !== undefined) {
            const retainage = data.retainage_percent ?? 0;
            const billable = data.work_completed_to_date * (1 - retainage / 100);
            resolvedAmount = Math.round((billable - (priorDrawsSum ?? 0)) * 100) / 100;
          }

          // Name resolution.
          if (data.name) {
            resolvedName = data.name;
          } else {
            const todayIso = new Date().toISOString().slice(0, 10);
            resolvedName = `Draw #${resolvedDrawNumber} - ${todayIso}`;
          }

          // PR #65 review MEDIUM 4: non-positive amount check fires
          // BEFORE the confirmation prompt — saves the user a wasted
          // confirm round on impossible math.
          if (resolvedAmount !== undefined && resolvedAmount <= 0) {
            return errorMarkdown(
              `**Computed draw amount is non-positive** ($${resolvedAmount.toFixed(2)}) for project #${data.project_id}. ` +
                `This typically means prior draws ($${(priorDrawsSum ?? 0).toFixed(2)}) already cover (or exceed) the cumulative work-completed ($${(data.work_completed_to_date ?? 0).toFixed(2)}). ` +
                `Verify \`work_completed_to_date\` or pass \`amount\` directly.`,
            );
          }
        }

        const result = await createDrawRequestConfirmed(
          {
            ...data,
            _project_name: projectName,
            _prior_draws_count: priorDrawsCount,
            _prior_draws_sum: priorDrawsSum,
            _resolved_draw_number: resolvedDrawNumber,
            _resolved_amount: resolvedAmount,
            _resolved_name: resolvedName,
          },
          store,
          sessionId,
        );

        storeIdempotencyResult({
          context: idemContext,
          result,
          isExecuteCall: !!data.confirmation_id,
        });
        return result;
      },
    },
    makeTool(
      "delete_financial_statement",
      "Delete one or more financial statements from a project. Requires confirmation. This is destructive and cannot be undone.",
      DeleteFinancialStatementSchema,
      deleteFSConfirmed,
      "delete",
    ),
    makeTool(
      "create_service",
      "Create a service request on a project. Requires confirmation.",
      CreateServiceSchema,
      createServiceConfirmed,
      "write:operations",
    ),
    makeTool(
      "create_selection",
      "Create a material/finish selection on a project. Requires a budget_category_id (use list_selection_categories to find valid IDs). Requires confirmation.",
      CreateSelectionSchema,
      createSelectionConfirmed,
      "write:selections",
    ),
    makeTool(
      "delete_selection",
      "Delete one or more selections from a project. Requires confirmation. This is destructive.",
      DeleteSelectionSchema,
      deleteSelectionConfirmed,
      "delete",
    ),
    makeTool(
      "create_budget_item",
      "Add a budget category line item to a project. The amount is set separately via update_budget_item. Requires confirmation.",
      CreateBudgetItemSchema,
      createBudgetItemConfirmed,
      "write:budget",
    ),
    makeTool(
      "update_budget_item",
      "Update a budget line item's working amount and/or allowance flag. Requires confirmation.",
      UpdateBudgetItemSchema,
      updateBudgetItemConfirmed,
      "write:budget",
    ),
    makeTool(
      "delete_budget_item",
      "Delete a budget line item from a project. Will fail if the item has related change orders. Requires confirmation.",
      DeleteBudgetItemSchema,
      deleteBudgetItemConfirmed,
      "delete",
    ),
  ];
}
