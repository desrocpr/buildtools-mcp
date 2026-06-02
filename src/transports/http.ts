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
  /**
   * When true, mount the OAuth 2.1 + enrollment routes alongside the
   * MCP transport. The bearer middleware excludes those paths so
   * they can have their own auth. Defaults to the truthiness of
   * `MCP_OAUTH_ENABLED`.
   */
  oauthEnabled?: boolean;
  /**
   * Public origin Claude Desktop will hit (for absolute redirect URLs
   * inside the OAuth flow). Defaults to `MCP_PUBLIC_ORIGIN` env.
   */
  publicOrigin?: string;
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Filter the advertised tool list by the caller's permissions when
    // we have an OAuth/service AuthContext on the session. Legacy
    // bearer sessions (kind=legacy) and the absence of any auth context
    // both fall through to "show everything" — preserves pre-Phase-6
    // behavior so existing clients continue to work during cutover.
    const authCtx = opts.sessionStore.getAuth<{
      kind: "human" | "service" | "legacy";
      user: { permissions: string[] } | null;
    }>(opts.sessionId);
    const shouldFilter =
      authCtx !== undefined && authCtx.kind !== "legacy" && authCtx.user !== null;
    const { hasPermission } = await import("../auth/types.js");
    const tools = Array.from(toolsByName.values());
    const filtered = shouldFilter
      ? tools.filter((t) =>
          hasPermission(authCtx!.user!.permissions, t.permission),
        )
      : tools;
    return {
      tools: [
        {
          name: "ping",
          description:
            "Returns pong. Used to verify the buildtools-mcp server is reachable.",
          inputSchema: { type: "object", properties: {} },
        },
        ...filtered.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      ],
    };
  });

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

    // Permission enforcement (MOS-328 Phase 6b). Same gating rule as
    // tools/list — applies only when the session has an OAuth/service
    // AuthContext; legacy and unauthed sessions are unaffected.
    const authCtx = opts.sessionStore.getAuth<{
      kind: "human" | "service" | "legacy";
      user: { email: string; permissions: string[] } | null;
    }>(sessionId);
    if (
      authCtx !== undefined &&
      authCtx.kind !== "legacy" &&
      authCtx.user !== null
    ) {
      const { hasPermission } = await import("../auth/types.js");
      if (!hasPermission(authCtx.user.permissions, tool.permission)) {
        auditLog({
          sessionId,
          username: authCtx.user.email,
          tool: name,
          result: "error",
        });
        return {
          content: [
            {
              type: "text",
              text:
                `**Permission denied**: tool \`${name}\` requires \`${tool.permission}\`. ` +
                `Your roles grant: ${authCtx.user.permissions.join(", ") || "(none)"}. ` +
                `Ask an admin to upgrade your role at /admin/users.`,
            },
          ],
          isError: true,
        };
      }
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

  // Decide whether to mount the OAuth + enrollment routes. We do it
  // before installing the bearer middleware so the middleware can skip
  // the public paths cleanly.
  const oauthEnabled =
    opts.oauthEnabled ??
    /^(1|true|yes)$/i.test(process.env.MCP_OAUTH_ENABLED ?? "");
  let resolverDb: import("../auth/db.js").Db | undefined;
  if (oauthEnabled) {
    const publicOrigin =
      opts.publicOrigin ??
      process.env.MCP_PUBLIC_ORIGIN ??
      "https://buildtools-mcp.mossbuildinganddesign.com";
    const { mountWebRoutes } = await import("../web/router.js");
    const handles = await mountWebRoutes(app, { publicOrigin });
    resolverDb = handles.db;
    process.stderr.write(
      `[http-transport] OAuth + enrollment routes mounted (origin=${publicOrigin})\n`,
    );
  }

  // Pre-compute the expected `Authorization` header value once, then use
  // `timingSafeEqual` on every request so the comparison does not leak bytes
  // of the bearer via response timing. (MEDIUM-1, MOS-220 review.)
  const expectedAuthHeader = Buffer.from(`Bearer ${opts.bearerToken}`);

  const { isPublicRoute } = await import("../web/router.js");
  const { parseBearerHeader } = await import("../auth/tokens.js");
  const { resolveBearer } = await import("../auth/resolver.js");

  // Bearer-token middleware — applied to MCP routes only. /oauth/*,
  // /enroll/*, and /.well-known/* are exempt; they have their own auth.
  //
  // When OAuth is enabled we route through the resolver, which:
  //   - accepts mcpa_ / mcps_ tokens and attaches an AuthContext to req
  //   - falls back to constant-time legacy bearer compare during the
  //     2-week deprecation window so existing Claude Desktop sessions
  //     keep working until users re-enroll
  //
  // When OAuth is off the behaviour is exactly the pre-Phase-6 path:
  // constant-time compare against HTTP_BEARER_TOKEN, no DB lookups.
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (oauthEnabled && isPublicRoute(req.path)) {
      return next();
    }

    if (!oauthEnabled) {
      const presented = Buffer.from(req.headers.authorization ?? "");
      if (
        presented.length !== expectedAuthHeader.length ||
        !timingSafeEqual(presented, expectedAuthHeader)
      ) {
        res.status(401).type("text/plain").send("Unauthorized");
        return;
      }
      return next();
    }

    // OAuth-enabled path.
    const bearer = parseBearerHeader(req.headers.authorization ?? null);
    if (!bearer || !resolverDb) {
      res.status(401).type("text/plain").send("Unauthorized");
      return;
    }
    try {
      const ctx = await resolveBearer(bearer, {
        db: resolverDb,
        legacyBearer: opts.bearerToken,
      });
      if (!ctx) {
        res.status(401).type("text/plain").send("Unauthorized");
        return;
      }
      // Attach so the /sse handler can copy it into the session store
      // and the /messages handler can read it back.
      (req as Request & { auth?: unknown }).auth = ctx;
      next();
    } catch (err) {
      // Resolver hit a DB error — fail closed but log loud so we
      // notice infrastructure issues. Token value never reaches stderr;
      // we only log the error message from the DB lookup.
      process.stderr.write(
        `[http-transport] auth resolver error: ${(err as Error)?.message ?? err}\n`,
      );
      res.status(401).type("text/plain").send("Unauthorized");
    }
  });

  app.get(SSE_ENDPOINT, async (req: Request, res: Response) => {
    const transport = new SSEServerTransport(MESSAGES_ENDPOINT, res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    // Phase 6a (MOS-328): if the bearer middleware resolved an
    // AuthContext, persist it on the session so subsequent /messages
    // calls can identify the user without re-resolving. Legacy bearer
    // requests have ctx.kind === 'legacy' (no user) and continue to
    // rely on `set_session_credentials`.
    const ctx = (req as Request & { auth?: unknown }).auth;
    if (ctx) {
      sessionStore.setAuth(sessionId, ctx);
    }

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
