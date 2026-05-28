/**
 * Stdio transport for buildtools-mcp (MOS-220, Phase 6 refactor).
 *
 * Extracted from the original `src/index.ts` (MOS-209 / MOS-210). Behavior
 * parity is the goal: a Claude Desktop install that worked before MOS-220 must
 * keep working unchanged. Only the audit-log line is new (acceptance
 * criterion 12) — and it goes to stderr, which Claude Desktop ignores.
 *
 * The HTTP/SSE transport lives in `./http.ts`; `src/index.ts` chooses between
 * them at boot based on `MCP_TRANSPORT`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { loadConfigFromEnv } from "../client/config.js";
import { ConfirmationStore } from "../confirm/index.js";
import {
  attachmentTools,
  createMutationTools,
  customerTools,
  financialTools,
  operationTools,
  projectTools,
  purchaseOrderTools,
  selectionTools,
  taskTools,
  workTrackingTools,
  type ToolDefinition,
} from "../tools/index.js";
import { auditLog } from "./session-store.js";

/**
 * Boot the stdio transport. Returns the connected server so callers (tests,
 * graceful-shutdown wrappers) can introspect or close it.
 *
 * Implementation mirrors the pre-MOS-220 `src/index.ts`:
 *   - Lazy singleton `BuildToolsAPI` (config errors surface as tool-error
 *     responses, not stdio crashes).
 *   - One process-wide `ConfirmationStore` with an unref'ed sweep timer so
 *     graceful shutdown is unblocked.
 *   - `ping` is special-cased outside the registry for cheap health checks.
 */
export async function startStdioTransport(): Promise<Server> {
  const server = new Server(
    { name: "buildtools-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  // -------------------------------------------------------------------------
  // Lazy singleton client
  // -------------------------------------------------------------------------
  let apiSingleton: BuildToolsAPI | null = null;
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

  // -------------------------------------------------------------------------
  // Confirmation framework (MOS-217, Phase 4)
  // -------------------------------------------------------------------------
  const confirmationStore = new ConfirmationStore();
  const SWEEP_INTERVAL_MS = confirmationStore.ttlMilliseconds;
  setInterval(() => confirmationStore.sweep(), SWEEP_INTERVAL_MS).unref();

  // -------------------------------------------------------------------------
  // Tool registry
  // -------------------------------------------------------------------------
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
    ...selectionTools.map((t) => [t.name, t] as const),
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
      auditLog({ sessionId: "stdio", username: undefined, tool: "ping", result: "ok" });
      return { content: [{ type: "text", text: "pong" }] };
    }

    const tool = toolsByName.get(name);
    if (!tool) {
      auditLog({ sessionId: "stdio", username: undefined, tool: name, result: "error" });
      return {
        content: [{ type: "text", text: `**Unknown tool**: ${name}` }],
        isError: true,
      };
    }

    let api: BuildToolsAPI;
    let username: string | undefined;
    try {
      api = getApi();
      username = process.env.BUILDTOOLS_USERNAME;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      auditLog({ sessionId: "stdio", username: undefined, tool: name, result: "error" });
      return {
        content: [{ type: "text", text: `**Configuration error**: ${message}` }],
        isError: true,
      };
    }

    const result = await tool.handler(args, api);
    auditLog({
      sessionId: "stdio",
      username,
      tool: name,
      result: result.isError ? "error" : "ok",
    });
    // The SDK's `CallToolResult` is a union (one branch requires a `task`
    // field). Our `ToolDefinition.handler` returns the content-only branch
    // by design — widen here so the inferred type doesn't collapse onto
    // the task-required branch.
    return result as { content: typeof result.content; isError?: boolean };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
