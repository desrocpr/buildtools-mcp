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
  searchProjectsTool,
  projectTools,
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
  attachmentTools,
} from "./attachments.js";

export {
  listTasksTool,
  searchTasksTool,
  taskTools,
} from "./tasks.js";

export {
  listPurchaseOrdersTool,
  searchPurchaseOrdersTool,
  purchaseOrderTools,
} from "./purchase-orders.js";

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
  searchUsersTool,
  operationTools,
} from "./operations.js";

export {
  listSelectionsTool,
  listAllowancesTool,
  listSelectionCategoriesTool,
  selectionTools,
} from "./selections.js";

export { createMutationTools } from "./mutations.js";
