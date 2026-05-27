#!/usr/bin/env node
/**
 * buildtools-mcp entrypoint (MOS-220, Phase 6).
 *
 * Picks a transport at boot based on `MCP_TRANSPORT`:
 *   - `stdio` (default) — original Claude Desktop transport, unchanged from
 *     the user's perspective. See `./transports/stdio.ts`.
 *   - `http`             — express server with bearer-token auth and a
 *     per-session BuildTools credentials handshake. See `./transports/http.ts`.
 *
 * Backward compat: an existing Claude Desktop install with `command: node, args:
 * [dist/index.js]` and no extra env vars continues to use stdio identically.
 *
 * Failure modes:
 *   - `MCP_TRANSPORT=http` with no `HTTP_BEARER_TOKEN` → process exits non-zero
 *     with a clear stderr message naming the missing variable (acceptance
 *     criterion 5).
 *   - Anything else is delegated to the chosen transport.
 */

import { startStdioTransport } from "./transports/stdio.js";
import { startHttpTransport } from "./transports/http.js";

async function main(): Promise<void> {
  const transport = process.env.MCP_TRANSPORT ?? "stdio";

  if (transport === "http") {
    const portRaw = process.env.HTTP_PORT;
    const port = portRaw ? Number(portRaw) : 3030;
    if (Number.isNaN(port)) {
      process.stderr.write(
        `Invalid HTTP_PORT: ${portRaw} (must be a number)\n`,
      );
      process.exit(1);
    }
    const bearerToken = process.env.HTTP_BEARER_TOKEN;
    if (!bearerToken) {
      process.stderr.write(
        "HTTP_BEARER_TOKEN must be set when MCP_TRANSPORT=http\n",
      );
      process.exit(1);
    }
    await startHttpTransport({
      port,
      bearerToken,
      defaultTenant: process.env.BUILDTOOLS_TENANT,
    });
    // Process stays alive on its own via the express listener.
    return;
  }

  if (transport !== "stdio") {
    process.stderr.write(
      `Unknown MCP_TRANSPORT: ${transport} (expected "stdio" or "http")\n`,
    );
    process.exit(1);
  }

  await startStdioTransport();
}

await main();
