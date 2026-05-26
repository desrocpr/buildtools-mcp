/**
 * Barrel for MCP tool modules (MOS-214).
 *
 * Re-exports the per-domain tool registries so `src/index.ts` can register
 * all tools with a single import as new phases land (Phase 3.2 financial
 * tools, Phase 3.3 customer/attachment tools, Phase 5 mutations).
 */

export {
  listProjectsTool,
  getProjectTool,
  searchProjectsTool,
  projectTools,
  type ToolDefinition,
  type ToolResult,
} from "./projects.js";
