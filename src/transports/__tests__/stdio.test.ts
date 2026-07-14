/**
 * Stdio transport dispatch (MOS-220). Drives the real server through a linked
 * in-memory transport (the DI seam) + a real MCP Client, so tool-list assembly,
 * ping/refresh_tools, unknown-tool handling, and the config-error path are
 * exercised in-process without touching process stdio or BuildTools.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startStdioTransport } from "../stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

async function connect(): Promise<{ client: Client; server: Server }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = await startStdioTransport({ transport: serverT });
  const client = new Client({ name: "stdio-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientT);
  return { client, server };
}

let openClient: Client | null = null;
afterEach(async () => {
  await openClient?.close();
  openClient = null;
});

describe("startStdioTransport dispatch", () => {
  it("lists ping, refresh_tools, and the domain tools", async () => {
    const { client } = await connect();
    openClient = client;
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ping", "refresh_tools", "list_projects"]));
  });

  it("answers ping with pong", async () => {
    const { client } = await connect();
    openClient = client;
    const res: any = await client.callTool({ name: "ping", arguments: {} });
    expect(res.content[0].text).toBe("pong");
    expect(res.isError).toBeFalsy();
  });

  it("refresh_tools emits list_changed and returns a message", async () => {
    const { client } = await connect();
    openClient = client;
    const res: any = await client.callTool({ name: "refresh_tools", arguments: {} });
    expect(JSON.stringify(res.content)).toMatch(/list_changed/i);
  });

  it("returns an isError result for an unknown tool", async () => {
    const { client } = await connect();
    openClient = client;
    const res: any = await client.callTool({ name: "does_not_exist", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/unknown tool/i);
  });

  it("surfaces a config error (not a crash) when BuildTools creds are absent", async () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("BUILDTOOLS_")) delete process.env[k];
    }
    try {
      const { client } = await connect();
      openClient = client;
      const res: any = await client.callTool({ name: "list_projects", arguments: {} });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/configuration error/i);
    } finally {
      process.env = saved;
    }
  });
});
