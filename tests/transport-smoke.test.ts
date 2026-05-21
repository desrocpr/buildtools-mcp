/**
 * Transport smoke test — MOS-210 Phase 1.2
 *
 * Spawns the built MCP server (`node dist/index.js`) as a subprocess and
 * exercises the stdio transport handshake using the SDK's own Client +
 * StdioClientTransport. No real Claude Desktop is required.
 *
 * Run order: `npm run build` first (handled by beforeAll), then `npm test`.
 * One-shot: `npm run build && npm test`
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Resolve project root relative to this file's location (tests/ -> project root).
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const distIndexPath = resolve(projectRoot, "dist/index.js");

let client: Client;

beforeAll(async () => {
  // Ensure dist/index.js is fresh before spawning the subprocess.
  execSync("npm run build", { stdio: "inherit", cwd: projectRoot });

  const transport = new StdioClientTransport({
    command: "node",
    args: [distIndexPath],
    // Suppress server's stderr from cluttering test output.
    stderr: "pipe",
  });

  client = new Client(
    { name: "smoke-test", version: "0.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("buildtools-mcp stdio transport", () => {
  it("lists tools and includes ping", async () => {
    const result = await client.listTools();
    expect(result.tools).toBeDefined();
    const pingTool = result.tools.find((t) => t.name === "ping");
    expect(pingTool).toBeDefined();
    expect(pingTool?.name).toBe("ping");
  });

  it("calls ping and receives pong", async () => {
    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.content).toBeDefined();
    expect(result.content[0]).toMatchObject({ type: "text", text: "pong" });
  });
});
