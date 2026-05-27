#!/usr/bin/env node
/**
 * buildtools-mcp stdio entrypoint.
 *
 * Tool registration (MOS-214–216, MOS-292–295 — Phases 3.1–3.3 + read-tools expansion):
 *   - `ping` is kept for diagnostics (Phase 1.2 transport smoke).
 *   - Project read tools (`list_projects`, `get_project`, `search_projects`)
 *     are registered via `projectTools` from `src/tools/projects.ts`.
 *   - Financial read tools (`list_change_orders`, `get_change_order`,
 *     `find_unbilled_change_orders`, `get_financial_statement`) are
 *     registered via `financialTools` from `src/tools/financial.ts`.
 *   - Customer read tools (`list_customers`, `get_customer`) are registered
 *     via `customerTools` from `src/tools/customers.ts`.
 *   - Attachment read tools (`list_project_attachments`) are registered via
 *     `attachmentTools` from `src/tools/attachments.ts`.
 *   - Task read tools (`list_tasks`, `search_tasks`) are registered via
 *     `taskTools` from `src/tools/tasks.ts`.
 *   - Purchase-order read tools (`list_purchase_orders`,
 *     `search_purchase_orders`) are registered via `purchaseOrderTools` from
 *     `src/tools/purchase-orders.ts` (MOS-292).
 *   - Work-tracking read tools (`list_certificates`, `list_daily_logs`,
 *     `list_weekly_reports`, `list_work_days`) are registered via
 *     `workTrackingTools` from `src/tools/work-tracking.ts` (MOS-295).
 *   - Operations read tools (`list_rfis`, `list_services`, `list_users`,
 *     `search_users`) are registered via `operationTools` from
 *     `src/tools/operations.ts` (MOS-294).
 *
 * Client lifecycle: the `BuildToolsAPI` instance is lazily constructed on the
 * first tool invocation that needs it. This way, env-var configuration errors
 * surface as a tool-error response inside Claude Desktop (where the user can
 * actually see them) rather than crashing the stdio process at startup.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { BuildToolsAPI } from "./client/BuildToolsAPI.js";
import { loadConfigFromEnv } from "./client/config.js";
import { ConfirmationStore } from "./confirm/index.js";
import {
  attachmentTools,
  createMutationTools,
  customerTools,
  financialTools,
  operationTools,
  projectTools,
  purchaseOrderTools,
  taskTools,
  workTrackingTools,
  type ToolDefinition,
} from "./tools/index.js";

const server = new Server(
  { name: "buildtools-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Lazy singleton client
// ---------------------------------------------------------------------------

let apiSingleton: BuildToolsAPI | null = null;

/**
 * Returns the lazily-initialised `BuildToolsAPI`. Throws if the environment
 * is misconfigured; callers convert that into a tool-error response so the
 * user sees the message in Claude Desktop instead of a silent crash.
 */
function getApi(): BuildToolsAPI {
  if (apiSingleton) return apiSingleton;
  const config = loadConfigFromEnv();
  apiSingleton = new BuildToolsAPI({
    tenant: config.tenant,
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
    sessionTimeoutMinutes: config.sessionTimeoutMinutes,
  });
  return apiSingleton;
}

// ---------------------------------------------------------------------------
// Confirmation framework (MOS-217, Phase 4)
// ---------------------------------------------------------------------------

/**
 * Single in-process `ConfirmationStore` that Phase 5 mutation tools (MOS-218 /
 * MOS-219) will read/write to. Wired here at boot so the periodic `sweep()`
 * timer can be attached and `.unref()`ed once — re-instantiating per-request
 * would leak entries.
 *
 * The interval handle is `.unref()`ed so it does not pin the stdio process:
 * Claude Desktop closing the transport must still let the process exit
 * cleanly. The sweep cadence matches the default TTL (5 min); the worst case
 * is an expired entry lingering up to one sweep cycle, which is fine — a
 * second `consume()` call will still return `null` on its own expiry check.
 */
const confirmationStore = new ConfirmationStore();
const SWEEP_INTERVAL_MS = confirmationStore.ttlMilliseconds;
setInterval(() => confirmationStore.sweep(), SWEEP_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const mutationTools = createMutationTools(() => getApi(), confirmationStore);

const toolsByName: Map<string, ToolDefinition> = new Map([
  ...projectTools.map((t) => [t.name, t] as const),
  ...financialTools.map((t) => [t.name, t] as const),
  ...customerTools.map((t) => [t.name, t] as const),
  ...attachmentTools.map((t) => [t.name, t] as const),
  ...taskTools.map((t) => [t.name, t] as const),
  ...purchaseOrderTools.map((t) => [t.name, t] as const),
  ...workTrackingTools.map((t) => [t.name, t] as const),
  ...operationTools.map((t) => [t.name, t] as const),
  ...mutationTools.map((t) => [t.name, t] as const),
]);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description:
        "Returns pong. Used to verify the buildtools-mcp server is reachable.",
      inputSchema: { type: "object", properties: {} },
    },
    ...Array.from(toolsByName.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "ping") {
    return { content: [{ type: "text", text: "pong" }] };
  }

  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `**Unknown tool**: ${name}` }],
      isError: true,
    };
  }

  let api: BuildToolsAPI;
  try {
    api = getApi();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `**Configuration error**: ${message}`,
        },
      ],
      isError: true,
    };
  }

  // The SDK's `CallToolResult` is a union (one branch requires a `task`
  // field). Our `ToolDefinition.handler` returns the content-only branch by
  // design — widen here so the inferred type doesn't collapse onto the
  // task-required branch.
  const result = await tool.handler(args, api);
  return result as { content: typeof result.content; isError?: boolean };
});

const transport = new StdioServerTransport();
await server.connect(transport);
