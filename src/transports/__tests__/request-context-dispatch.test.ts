/**
 * Regression guard for the ALS-through-real-SDK-dispatch assumption (MOS-631).
 *
 * The transport wraps `handlePostMessage` in `runWithRequestAuth`, and the MCP
 * handlers read the identity back via `currentRequestAuth()`. That only works
 * because the SDK invokes the request handler synchronously within the caller's
 * async context (so AsyncLocalStorage propagates). This test drives the REAL
 * `SSEServerTransport` + `Server` dispatch path — if a future SDK upgrade defers
 * handler execution off the caller's context, `seen` becomes `undefined` and
 * this test fails loudly instead of the change silently disabling RBAC.
 */
import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runWithRequestAuth, currentRequestAuth } from "../request-context.js";
import type { AuthContext } from "../../auth/resolver.js";

// Minimal ServerResponse stand-in — SSEServerTransport.start() needs
// writeHead/write/on; send() writes SSE frames we discard.
function fakeRes(): any {
  return {
    writeHead() {
      return this;
    },
    write() {
      return true;
    },
    on() {
      return this;
    },
    end() {},
  };
}

describe("AsyncLocalStorage propagates through the real SDK dispatch", () => {
  it("a request handler reads the same auth the transport was wrapped with", async () => {
    const transport = new SSEServerTransport("/messages", fakeRes());
    const server = new Server(
      { name: "als-test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    let seen: unknown = "UNSET";
    let resolveSeen: () => void;
    const handlerRan = new Promise<void>((r) => (resolveSeen = r));
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      seen = currentRequestAuth();
      resolveSeen();
      return { tools: [] };
    });

    await server.connect(transport); // calls transport.start()

    const ctx = { kind: "human", user: { id: "u-als" } } as unknown as AuthContext;
    await runWithRequestAuth(ctx, () =>
      // handleMessage is the same path handlePostMessage funnels into.
      transport.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    );
    await handlerRan;

    expect(seen).toBe(ctx);
    await transport.close();
  });
});
