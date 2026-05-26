#!/usr/bin/env node
/**
 * buildtools-mcp stdio entrypoint.
 *
 * Tool registration (MOS-214, MOS-215, MOS-216 — Phases 3.1 + 3.2 + 3.3):
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
import {
  attachmentTools,
  customerTools,
  financialTools,
  projectTools,
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
// Tool registry
// ---------------------------------------------------------------------------

const toolsByName: Map<string, ToolDefinition> = new Map([
  ...projectTools.map((t) => [t.name, t] as const),
  ...financialTools.map((t) => [t.name, t] as const),
  ...customerTools.map((t) => [t.name, t] as const),
  ...attachmentTools.map((t) => [t.name, t] as const),
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
