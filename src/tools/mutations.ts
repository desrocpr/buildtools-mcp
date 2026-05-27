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
import { BuildToolsError } from "../client/errors.js";
import { requiresConfirmation, type ConfirmationStore } from "../confirm/index.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

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

const CreatePurchaseOrderSchema = z.object({
  name: z.string().describe("Purchase order name."),
  project_id: z.number().describe("BuildTools project ID."),
  company_id: z.number().describe("Vendor/subcontractor company ID."),
  total: z.number().optional().describe("Total dollar amount (used if items not provided)."),
  prefix: z.string().optional().describe("PO number prefix. Default: 'PO'."),
  notes: z.string().optional(),
  items: z
    .array(z.object({ name: z.string(), total: z.number() }))
    .optional(),
  confirmation_id: z.string().optional(),
});
type CreatePurchaseOrderArgs = z.infer<typeof CreatePurchaseOrderSchema>;

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
  const createPOConfirmed = requiresConfirmation<CreatePurchaseOrderArgs>(
    "create_purchase_order",
    (a) => `Create purchase order **"${a.name}"** on project #${a.project_id} for company #${a.company_id}.`,
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

  // -- Build ToolDefinition array ------------------------------------------

  function makeTool(
    name: string,
    description: string,
    schema: z.ZodType,
    confirmed: (args: any, store: ConfirmationStore) => Promise<ToolResult>,
  ): ToolDefinition {
    return {
      name,
      description,
      inputSchema: zodToJsonSchema(schema),
      handler: async (rawArgs: unknown, _api: BuildToolsAPI) => {
        const parsed = (schema as z.ZodObject<any>).safeParse(rawArgs ?? {});
        if (!parsed.success) return formatZodError(parsed.error, name);
        return confirmed(parsed.data, store);
      },
    };
  }

  return [
    makeTool(
      "create_project",
      "Create a new BuildTools project. Requires confirmation. Default status: Omega (6).",
      CreateProjectSchema,
      createProjectConfirmed,
    ),
    makeTool(
      "create_change_order",
      "Create a change order on a project. Requires confirmation. Default status: Draft (1).",
      CreateChangeOrderSchema,
      createCOConfirmed,
    ),
    makeTool(
      "create_purchase_order",
      "Create a purchase order for a vendor on a project. Requires confirmation.",
      CreatePurchaseOrderSchema,
      createPOConfirmed,
    ),
    makeTool(
      "create_task",
      "Create a task on a project. Requires confirmation. Status: 1=Open, 2=In Progress, 3=Complete.",
      CreateTaskSchema,
      createTaskConfirmed,
    ),
    makeTool(
      "create_rfi",
      "Create an RFI (Request for Information) on a project. Requires confirmation.",
      CreateRFISchema,
      createRFIConfirmed,
    ),
    makeTool(
      "create_invoice",
      "Create a vendor invoice. Requires confirmation. Note: 'invoices' in BuildTools are vendor bills, not client billing (that's financial statements).",
      CreateInvoiceSchema,
      createInvoiceConfirmed,
    ),
    makeTool(
      "create_financial_statement",
      "Create a financial statement (client bill / draw request) on a project with a specific dollar amount. Requires confirmation. Use ASCII-only titles.",
      CreateFinancialStatementSchema,
      createFSConfirmed,
    ),
    makeTool(
      "delete_financial_statement",
      "Delete one or more financial statements from a project. Requires confirmation. This is destructive and cannot be undone.",
      DeleteFinancialStatementSchema,
      deleteFSConfirmed,
    ),
    makeTool(
      "create_service",
      "Create a service request on a project. Requires confirmation.",
      CreateServiceSchema,
      createServiceConfirmed,
    ),
  ];
}
