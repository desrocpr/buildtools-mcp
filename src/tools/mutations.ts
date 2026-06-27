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
import { IdempotencyStore } from "../idempotency/index.js";

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
  if (typeof s === "number") return s;
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
  return String(s).replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
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
  const transitionPOStatusConfirmed = requiresConfirmation<TransitionPurchaseOrderStatusArgs & { _resolved_status_code?: number }>(
    "transition_purchase_order_status",
    (a) => {
      const targetLabel = a._resolved_status_code !== undefined
        ? `${poStatusLabel(a._resolved_status_code)} (${a._resolved_status_code})`
        : String(a.status);
      return `Transition purchase order #${a.purchase_order_id} to **${targetLabel}**.`;
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

        // Idempotency check (only when the cache is wired and the
        // caller passed a key). We do this BEFORE the confirmation
        // flow so a retry of an already-successful call returns the
        // cached result immediately — no second prompt, no second BT
        // call. Fingerprint excludes `confirmation_id` (rotates per
        // call) and `idempotency_key` itself (already in the cache key).
        let idempotencyCacheKey: string | undefined;
        let idempotencyArgsFingerprint: string | undefined;
        if (idempotencyStore && data.idempotency_key) {
          idempotencyCacheKey = IdempotencyStore.buildCacheKey(
            "update_purchase_order",
            sessionId,
            data.idempotency_key,
          );
          // Strip fields that don't represent the semantic write BT will
          // apply:
          //   - confirmation_id: rotates per call
          //   - idempotency_key: already in the cache key
          //   - verify: a client-side post-write check, not a BT mutation.
          //     If a caller times out with `verify: true` and retries with
          //     `verify: false` to skip the second round-trip, that's the
          //     SAME write — fingerprinting them differently would turn
          //     the safety net into a trap.
          const {
            confirmation_id: _ci,
            idempotency_key: _ik,
            verify: _v,
            ...semantic
          } = data;
          idempotencyArgsFingerprint = IdempotencyStore.fingerprintArgs(semantic);
          const lookup = idempotencyStore.lookup(
            idempotencyCacheKey,
            idempotencyArgsFingerprint,
          );
          if (lookup.kind === "hit") {
            // Replay the original result with a banner so the caller
            // knows this wasn't a fresh write.
            const original = lookup.result;
            const replayNote =
              `_Idempotency replay: returning cached result for key \`${escapeMarkdownInline(data.idempotency_key)}\` — no BT call was made. Cache TTL ${idempotencyStore.ttlMinutes} min._\n\n`;
            return {
              ...original,
              content: original.content.map((c) =>
                "text" in c ? { ...c, text: replayNote + c.text } : c,
              ),
            };
          }
          if (lookup.kind === "mismatch") {
            return errorMarkdown(
              `**Idempotency key reused with different args.** The key \`${escapeMarkdownInline(data.idempotency_key)}\` was previously used (within the last ${idempotencyStore.ttlMinutes} min) with a DIFFERENT set of args. Use a fresh key per distinct write, or wait for the cache to expire.`,
            );
          }
        }

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
        if (
          idempotencyStore &&
          idempotencyCacheKey &&
          idempotencyArgsFingerprint &&
          data.confirmation_id &&
          !result.isError
        ) {
          idempotencyStore.store(
            idempotencyCacheKey,
            idempotencyArgsFingerprint,
            result,
          );
        }
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
        return transitionPOStatusConfirmed(
          { ...data, _resolved_status_code: resolvedStatusCode },
          store,
          sessionId,
        );
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
