/**
 * Barrel export for the BuildTools client module.
 *
 * Phase 2.1 surface: the API class, error hierarchy, and the public Zod
 * schemas + inferred types. MCP server wiring lives in later phases
 * (MOS-214+) and intentionally does not import-and-register here.
 */

export { BuildToolsAPI } from "./BuildToolsAPI.js";
export type { PostData } from "./BuildToolsAPI.js";

export {
  BuildToolsError,
  BuildToolsAuthError,
  BuildToolsNetworkError,
  BuildToolsValidationError,
  BuildToolsServerError,
} from "./errors.js";

export {
  BuildToolsClientOptionsSchema,
  DatatableResponseSchema,
  ProjectSchema,
  ProjectSaveResultSchema,
  SuccessSaveResultSchema,
  ChangeOrderAttachmentSchema,
} from "./types.js";

export type {
  BuildToolsClientOptions,
  DatatableResponse,
  DatatableParams,
  Project,
  ProjectSaveResult,
  SuccessSaveResult,
  ChangeOrderAttachment,
} from "./types.js";
