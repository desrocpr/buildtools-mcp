/**
 * HTTP/SSE transport for buildtools-mcp (MOS-220, Phase 6).
 *
 * Adds a second MCP transport so the same server binary can serve hosted
 * agents (not just Claude Desktop). Auth happens in two layers:
 *
 *   1. Express-level bearer-token check — proves the caller is a trusted
 *      MCP client (e.g. the hosted agent gateway). The bearer is read from
 *      `HTTP_BEARER_TOKEN` at boot.
 *   2. Per-session `set_session_credentials` handshake — every SSE session
 *      must hand the server BuildTools credentials before any
 *      BuildTools-bound tool will run for that session. The bearer alone
 *      grants nothing in BuildTools; the credentials live in
 *      `SessionStore` keyed by the SDK-generated `sessionId` and are wiped
 *      on SSE `close`.
 *
 * Per-session BuildTools client:
 *   We construct a brand new `BuildToolsAPI({...})` per session lazily on
 *   first BuildTools-bound tool call (see `resolveApi` below). This keeps
 *   the read-tools' `(args, api) => ToolResult` signature unchanged —
 *   session-awareness is a transport concern, not a tool concern.
 *
 * SDK choice — `SSEServerTransport`:
 *   The MOS-220 contract pins on `SSEServerTransport` (over the newer
 *   `StreamableHTTPServerTransport`) to match the issue's pseudocode and to
 *   minimize migration risk. The SDK deprecates SSE but ships it; we accept
 *   the deprecation warning for Phase 6.
 *
 * Confirmation framework:
 *   The Phase 4 `ConfirmationStore` remains process-local. The Phase 6
 *   contract explicitly defers multi-session isolation of the confirmation
 *   store to a future issue — see `src/confirm/Confirmation.ts` notes. Two
 *   concurrent HTTP sessions could theoretically observe each other's
 *   pending mutation tokens; this is documented and accepted scope.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";

import { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { ConfirmationStore } from "../confirm/index.js";
import {
  attachmentTools,
  budgetTools,
  createMutationTools,
  createSessionCredentialsTool,
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
import { auditLog, SessionStore } from "./session-store.js";

const SSE_ENDPOINT = "/sse";
const MESSAGES_ENDPOINT = "/messages";

/** Options accepted by `startHttpTransport`. Kept narrow for testability. */
export interface HttpTransportOptions {
  /** TCP port to listen on. */
  port: number;
  /** Bearer-token enforced on every HTTP request. */
  bearerToken: string;
  /**
   * Fallback BuildTools tenant when an SSE client omits `tenant` in
   * `set_session_credentials`. Typically `process.env.BUILDTOOLS_TENANT`.
   */
  defaultTenant?: string;
}

/** Handle returned from `startHttpTransport` — exposes the underlying HTTP
 *  server for graceful shutdown in tests. */
export interface HttpTransportHandle {
  /** The express HTTP server. Call `.close()` to shut down. */
  httpServer: HttpServer;
  /** The shared in-memory session store (tests inspect this). */
  sessionStore: SessionStore;
  /** Actual port the server is bound to (useful when `port=0` for tests). */
  port: number;
}

/**
 * Build a per-session MCP `Server` instance with all standard tools PLUS
 * `set_session_credentials`. The dispatcher resolves a `BuildToolsAPI` from
 * the session store on first BuildTools-bound call.
 */
function buildPerSessionServer(opts: {
  sessionId: string;
  sessionStore: SessionStore;
  confirmationStore: ConfirmationStore;
  defaultTenant?: string;
}): Server {
  const server = new Server(
    { name: "buildtools-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  // Lazy per-session BuildToolsAPI; constructed once credentials are set.
  let apiInstance: BuildToolsAPI | null = null;
  function resolveApi(): BuildToolsAPI {
    if (apiInstance) return apiInstance;
    const creds = opts.sessionStore.get(opts.sessionId);
    if (!creds) {
      throw new Error(
        "No BuildTools credentials for this session. " +
          "Call the `set_session_credentials` tool first with your BuildTools username + password.",
      );
    }
    apiInstance = new BuildToolsAPI({
      tenant: creds.tenant,
      baseUrl: `https://${creds.tenant}.buildtools.app`,
      username: creds.username,
      password: creds.password,
    });
    return apiInstance;
  }

  // Build the tool registry. `createMutationTools` takes a `() => API`
  // resolver (matches the stdio path).
  const mutationTools = createMutationTools(() => resolveApi(), opts.confirmationStore);
  const sessionTool = createSessionCredentialsTool({
    sessionStore: opts.sessionStore,
    sessionId: opts.sessionId,
    defaultTenant: opts.defaultTenant,
  });

  const toolsByName: Map<string, ToolDefinition> = new Map([
    [sessionTool.name, sessionTool] as const,
    ...projectTools.map((t) => [t.name, t] as const),
    ...financialTools.map((t) => [t.name, t] as const),
    ...customerTools.map((t) => [t.name, t] as const),
    ...attachmentTools.map((t) => [t.name, t] as const),
    ...taskTools.map((t) => [t.name, t] as const),
    ...purchaseOrderTools.map((t) => [t.name, t] as const),
    ...workTrackingTools.map((t) => [t.name, t] as const),
    ...operationTools.map((t) => [t.name, t] as const),
    ...selectionTools.map((t) => [t.name, t] as const),
    ...budgetTools.map((t) => [t.name, t] as const),
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
    const sessionId = opts.sessionId;

    if (name === "ping") {
      auditLog({ sessionId, username: undefined, tool: "ping", result: "ok" });
      return { content: [{ type: "text", text: "pong" }] };
    }

    const tool = toolsByName.get(name);
    if (!tool) {
      auditLog({ sessionId, username: undefined, tool: name, result: "error" });
      return {
        content: [{ type: "text", text: `**Unknown tool**: ${name}` }],
        isError: true,
      };
    }

    // `set_session_credentials` does not need a BuildToolsAPI — it stores
    // credentials so future calls CAN construct one.
    if (name === "set_session_credentials") {
      // `api` is not used by this tool's handler. The handler signature
      // requires the second arg, so pass an un-callable sentinel cast.
      const sentinel = undefined as unknown as BuildToolsAPI;
      const result = await tool.handler(args, sentinel);
      // Invalidate any cached BuildToolsAPI from a prior handshake so the
      // next BuildTools-bound call reconstructs the client from the new
      // credentials (and discards the old cookie jar). Without this,
      // repeated `set_session_credentials` calls within the same SSE
      // session would silently keep using the original user's session
      // because `resolveApi` is memoised. (HIGH-1, MOS-220 review.)
      if (!result.isError) {
        apiInstance = null;
      }
      // After-the-fact: pull the username back out of the store for the
      // audit line (only present on success).
      const stored = opts.sessionStore.get(sessionId);
      auditLog({
        sessionId,
        username: result.isError ? undefined : stored?.username,
        tool: name,
        result: result.isError ? "error" : "ok",
      });
      return result as { content: typeof result.content; isError?: boolean };
    }

    // All other tools need an API; surface "no creds yet" as a tool error
    // rather than a transport-level failure so the client can recover.
    let api: BuildToolsAPI;
    let username: string | undefined;
    try {
      api = resolveApi();
      username = opts.sessionStore.get(sessionId)?.username;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      auditLog({ sessionId, username: undefined, tool: name, result: "error" });
      return {
        content: [
          {
            type: "text",
            text:
              `**Session not authenticated**: ${message}\n\n` +
              "Run `set_session_credentials` first.",
          },
        ],
        isError: true,
      };
    }

    const result = await tool.handler(args, api);
    auditLog({
      sessionId,
      username,
      tool: name,
      result: result.isError ? "error" : "ok",
    });
    return result as { content: typeof result.content; isError?: boolean };
  });

  return server;
}

/**
 * Start the HTTP/SSE transport. Resolves once the server is listening; the
 * returned handle exposes the underlying HTTP server for graceful shutdown.
 *
 * The bearer token is enforced on EVERY request. The token value is never
 * logged: failures emit a plain `Unauthorized` body and a generic stderr
 * line that names the offending route only.
 */
export async function startHttpTransport(
  opts: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  if (!opts.bearerToken || opts.bearerToken.length === 0) {
    throw new Error("HTTP_BEARER_TOKEN must be set when MCP_TRANSPORT=http");
  }

  const sessionStore = new SessionStore();

  // One process-wide ConfirmationStore. The Phase 4 design is single-tenant;
  // Phase 6's contract defers multi-session isolation explicitly (see
  // file-level docblock and src/confirm/ comments).
  const confirmationStore = new ConfirmationStore();
  const sweepInterval = setInterval(
    () => confirmationStore.sweep(),
    confirmationStore.ttlMilliseconds,
  );
  sweepInterval.unref();

  // Map sessionId → live SSE transport, used by /messages to route POST bodies
  // back into the right SSE stream.
  const transports = new Map<string, SSEServerTransport>();

  const app = express();

  // Pre-compute the expected `Authorization` header value once, then use
  // `timingSafeEqual` on every request so the comparison does not leak bytes
  // of the bearer via response timing. (MEDIUM-1, MOS-220 review.)
  const expectedAuthHeader = Buffer.from(`Bearer ${opts.bearerToken}`);

  // Bearer-token middleware — applied to ALL routes.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const presented = Buffer.from(req.headers.authorization ?? "");
    // `timingSafeEqual` throws on length mismatch, so length-check first.
    // Both branches return the same 401 body so a length-difference path
    // is not itself a meaningful oracle.
    if (
      presented.length !== expectedAuthHeader.length ||
      !timingSafeEqual(presented, expectedAuthHeader)
    ) {
      // NOTE: do NOT log either the presented header or the configured
      // bearer. Acceptance criterion 11.
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    next();
  });

  app.get(SSE_ENDPOINT, async (req: Request, res: Response) => {
    const transport = new SSEServerTransport(MESSAGES_ENDPOINT, res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    const server = buildPerSessionServer({
      sessionId,
      sessionStore,
      confirmationStore,
      defaultTenant: opts.defaultTenant,
    });

    // Clean up the session store + transport map on disconnect. Both events
    // are wired so we cover both client-initiated close and transport errors.
    // A `cleaned` guard makes the double-fire idempotent in a way that
    // survives future extensions to cleanup (today `Map.delete` is itself
    // idempotent, but future cleanup steps may not be). (MEDIUM-3, review.)
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      transports.delete(sessionId);
      sessionStore.delete(sessionId);
    };
    res.on("close", cleanup);
    transport.onclose = cleanup;

    try {
      await server.connect(transport);
    } catch (err) {
      // Connection failed before any tool dispatch — clean up immediately.
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[http-transport] sse connect failed: ${message}\n`);
    }
  });

  app.post(MESSAGES_ENDPOINT, async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    if (!sessionId) {
      res.status(400).type("text/plain").send("Missing sessionId query param");
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).type("text/plain").send("Session not found");
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  return new Promise<HttpTransportHandle>((resolve, reject) => {
    const httpServer = app.listen(opts.port, () => {
      const address = httpServer.address() as AddressInfo | null;
      const boundPort = address?.port ?? opts.port;
      process.stderr.write(
        `buildtools-mcp HTTP transport listening on :${boundPort}\n`,
      );
      resolve({ httpServer, sessionStore, port: boundPort });
    });
    httpServer.on("error", (err) => reject(err));
  });
}
