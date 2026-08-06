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
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { loadConfigFromEnv } from "../client/config.js";
import { ConfirmationStore } from "../confirm/index.js";
import { getOperationsManagementApi } from "../operations/factory.js";
import { buildMossDbFromEnv } from "../db/MossDb.js";
import { IdempotencyStore } from "../idempotency/index.js";
import {
  attachmentTools,
  briefTools,
  budgetTools,
  companyTools,
  createMutationTools,
  forecastTools,
  invoiceTools,
  customerTools,
  financialTools,
  operationTools,
  projectTools,
  purchaseOrderTools,
  selectionTools,
  taskTools,
  workTrackingTools,
  type ToolContext,
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
export async function startStdioTransport(
  // Test-only DI seam: inject an in-memory transport instead of the real
  // stdio one so the dispatch (tools/list, ping, tool errors) is coverable
  // in-process. Production (`src/index.ts`) calls with no args.
  opts: { transport?: Transport } = {},
): Promise<Server> {
  const server = new Server(
    { name: "buildtools-mcp", version: "0.0.1" },
    // listChanged: true lets the client trust `notifications/tools/list_changed`
    // when emitted by the `refresh_tools` tool below.
    { capabilities: { tools: { listChanged: true } } },
  );

  // -------------------------------------------------------------------------
  // Lazy singleton client
  // -------------------------------------------------------------------------
  // PR #82: shared DB fast-path pool, opt-in via MYSQL_* env vars.
  const sharedDb = buildMossDbFromEnv();

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
    apiSingleton.db = sharedDb;
    // The neutral operations adapter (MOS-747). Attached here, alongside the
    // DB fast path, so tool handlers read through one surface that owns both
    // the db-vs-http choice and DT_RowId normalisation.
    apiSingleton.ops = getOperationsManagementApi(
      { provider: "buildtools" },
      { buildToolsApi: apiSingleton },
    );
    return apiSingleton;
  }

  // -------------------------------------------------------------------------
  // Confirmation framework (MOS-217, Phase 4)
  // -------------------------------------------------------------------------
  const confirmationStore = new ConfirmationStore();
  const SWEEP_INTERVAL_MS = confirmationStore.ttlMilliseconds;
  setInterval(() => confirmationStore.sweep(), SWEEP_INTERVAL_MS).unref();

  // Idempotency cache for mutation tools (PR #60). Process-local, sweep
  // unref'd so stdio process exits cleanly on Claude Desktop disconnect.
  const idempotencyStore = new IdempotencyStore();
  setInterval(
    () => idempotencyStore.sweep(),
    idempotencyStore.ttlMilliseconds,
  ).unref();

  // -------------------------------------------------------------------------
  // Tool registry
  // -------------------------------------------------------------------------
  const mutationTools = createMutationTools(
    () => getApi(),
    confirmationStore,
    undefined,
    idempotencyStore,
  );

  const toolsByName: Map<string, ToolDefinition<ToolContext>> = new Map([
    ...projectTools.map((t) => [t.name, t] as const),
    ...financialTools.map((t) => [t.name, t] as const),
    ...customerTools.map((t) => [t.name, t] as const),
    ...attachmentTools.map((t) => [t.name, t] as const),
    ...taskTools.map((t) => [t.name, t] as const),
    ...purchaseOrderTools.map((t) => [t.name, t] as const),
    ...companyTools.map((t) => [t.name, t] as const),
    ...workTrackingTools.map((t) => [t.name, t] as const),
    ...operationTools.map((t) => [t.name, t] as const),
    ...selectionTools.map((t) => [t.name, t] as const),
    ...budgetTools.map((t) => [t.name, t] as const),
    ...briefTools.map((t) => [t.name, t] as const),
    ...forecastTools.map((t) => [t.name, t] as const),
    ...invoiceTools.map((t) => [t.name, t] as const),
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
      {
        name: "refresh_tools",
        description:
          "[v1 2026-06-03] Force the MCP client to refresh its tool-list cache. Sends notifications/tools/list_changed; compliant clients re-fetch tools/list immediately.",
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

    if (name === "refresh_tools") {
      try {
        await server.sendToolListChanged();
      } catch (err) {
        process.stderr.write(
          `[stdio-transport] sendToolListChanged failed: ${(err as Error)?.message ?? err}\n`,
        );
      }
      auditLog({ sessionId: "stdio", username: undefined, tool: "refresh_tools", result: "ok" });
      return {
        content: [
          {
            type: "text",
            text:
              "Sent notifications/tools/list_changed. Compliant clients will re-fetch tools/list immediately.",
          },
        ],
      };
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

    // `ops` is attached when the client is built, so this is a real
    // ToolContext rather than a hopeful cast.
    const result = await tool.handler(args, api as ToolContext);
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

  const transport = opts.transport ?? new StdioServerTransport();
  await server.connect(transport);
  return server;
}
