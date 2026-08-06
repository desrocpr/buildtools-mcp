/**
 * Barrel for MCP tool modules (MOS-214, MOS-215, MOS-216, MOS-295).
 *
 * Re-exports the per-domain tool registries so `src/index.ts` can register
 * all tools with a single import. As of MOS-216 (Phase 3.3) the read-only
 * MVP surface is complete; MOS-295 adds work-tracking read tools
 * (certificates / daily logs / weekly reports / work days). Phase 5
 * mutations will add additional registries here.
 */

export {
  listProjectsTool,
  getProjectTool,
  projectTools,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./projects.js";

export {
  listChangeOrdersTool,
  getChangeOrderTool,
  findUnbilledChangeOrdersTool,
  getFinancialStatementTool,
  listFinancialStatementsTool,
  financialTools,
} from "./financial.js";

export {
  listCustomersTool,
  getCustomerTool,
  customerTools,
} from "./customers.js";

export {
  listProjectAttachmentsTool,
  downloadAttachmentTool,
  uploadAttachmentTool,
  attachmentTools,
} from "./attachments.js";

export {
  listTasksTool,
  taskTools,
} from "./tasks.js";

export {
  listPurchaseOrdersTool,
  getPurchaseOrderTool,
  purchaseOrderTools,
} from "./purchase-orders.js";

export {
  searchCompaniesTool,
  getCompanyTool,
  companyTools,
} from "./companies.js";

export {
  listCertificatesTool,
  listDailyLogsTool,
  listWeeklyReportsTool,
  listWorkDaysTool,
  workTrackingTools,
} from "./work-tracking.js";

export {
  listRfisTool,
  listServicesTool,
  listUsersTool,
  operationTools,
} from "./operations.js";

export {
  listSelectionsTool,
  getSelectionTool,
  listAllowancesTool,
  listSelectionCategoriesTool,
  selectionTools,
} from "./selections.js";

export { listBudgetTool, budgetTools } from "./budget.js";

export { createMutationTools } from "./mutations.js";

export { createSessionCredentialsTool } from "./sessions.js";

export {
  projectStatusBriefTool,
  briefTools,
} from "./briefs.js";

export {
  cashFlowForecastTool,
  forecastTools,
} from "./forecasts.js";

export {
  uncollectedInvoicesTool,
  invoiceTools,
} from "./invoices.js";
