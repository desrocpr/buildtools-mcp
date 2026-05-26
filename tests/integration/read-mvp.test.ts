/**
 * Read-MVP integration test — MOS-216 Phase 3.3 (read-only MVP close-out).
 *
 * Boots the built MCP server (`node dist/index.js`) as a subprocess, then
 * exercises the full read surface (Phase 1.2 + 3.1 + 3.2 + 3.3) via the
 * SDK's `Client` + `StdioClientTransport`. Asserts:
 *
 *   1. `tools/list` returns every name expected from the read-only MVP.
 *   2. `tools/call` against `list_projects` returns a `content[0]: text`
 *      shape (does NOT assert on live data values — works against real
 *      tenant creds OR a tenant where the call would fail-soft into
 *      Markdown).
 *
 * Gating: the entire suite is skipped unless
 * `BUILDTOOLS_INTEGRATION_TESTS=1` is set in the env. With the env var
 * unset, `npm test` continues to pass with this suite skipped (NOT failed).
 *
 * To run: `BUILDTOOLS_INTEGRATION_TESTS=1 npm run build && BUILDTOOLS_INTEGRATION_TESTS=1 npm test`
 *
 * NOTE: when enabled, this needs live BUILDTOOLS_* env vars to be set for
 * the spawned subprocess (TENANT, USERNAME, PASSWORD). Without them, the
 * `list_projects` call returns a Markdown configuration error — that's
 * still a valid `content[0]: text` shape, so the smoke passes regardless.
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENABLED = process.env.BUILDTOOLS_INTEGRATION_TESTS === "1";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const distIndexPath = resolve(projectRoot, "dist/index.js");

const EXPECTED_TOOL_NAMES = [
  "ping",
  "list_projects",
  "get_project",
  "search_projects",
  "list_change_orders",
  "get_change_order",
  "find_unbilled_change_orders",
  "get_financial_statement",
  "list_customers",
  "get_customer",
  "list_project_attachments",
];

let client: Client | undefined;

// Vitest's `describe.skipIf` runs the `beforeAll` only when the suite would
// execute, so the gating is honored without any extra branches inside it.
describe.skipIf(!ENABLED)("read-only MVP — full tools surface (MOS-216)", () => {
  beforeAll(async () => {
    execSync("npm run build", { stdio: "inherit", cwd: projectRoot });

    const transport = new StdioClientTransport({
      command: "node",
      args: [distIndexPath],
      stderr: "pipe",
    });

    client = new Client(
      { name: "read-mvp-test", version: "0.0.0" },
      { capabilities: {} },
    );

    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("tools/list returns all 11 expected tool names", async () => {
    if (!client) throw new Error("client not initialized");
    const result = await client.listTools();
    expect(result.tools).toBeDefined();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("tools/call list_projects returns a content[0].type === 'text' shape", async () => {
    if (!client) throw new Error("client not initialized");
    // We intentionally do NOT assert on the inner text — it depends on the
    // live tenant. We only assert on the response shape.
    const result = await client.callTool({
      name: "list_projects",
      arguments: { status: "Active", limit: 5 },
    });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]).toBeDefined();
    expect(content[0].type).toBe("text");
    expect(typeof content[0].text).toBe("string");
  });
});
