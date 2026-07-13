/**
 * OAuth-enabled HTTP/SSE transport integration test (MOS-631 / MOS-328).
 *
 * Boots `startHttpTransport` IN-PROCESS with `oauthEnabled: true` and an
 * injected `authResolver` (no Supabase), then drives the real Express app +
 * middleware + `buildPerSessionServer` to lock down the auth behavior the
 * multi-agent reviews flagged as untested:
 *   - RBAC tool-list filtering by role (viewer vs editor)
 *   - the per-call permission gate (viewer denied a write tool)
 *   - owner-binding on `/messages` (a different bearer → 404, owner → 202)
 *
 * Running in-process (not a subprocess) is deliberate: it lets v8 attribute
 * coverage to `src/transports/http.ts`, which the subprocess-based legacy test
 * cannot.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { startHttpTransport } from "../../src/transports/http.js";
import type { AuthContext } from "../../src/auth/resolver.js";

const mkUser = (id: string, permissions: string[], role: string): AuthContext =>
  ({
    kind: "human",
    user: { id, email: `${id}@example.test`, permissions, roles: [{ name: role }] },
    tokenId: `tok-${id}`,
    tokenKind: "oauth-access",
  }) as unknown as AuthContext;

const EDITOR_PERMS = [
  "read",
  "write:financial",
  "write:selections",
  "write:budget",
  "write:tasks",
  "write:operations",
];

// bearer string -> resolved identity. Unknown bearer -> 401.
const IDENTITIES: Record<string, AuthContext> = {
  "tok-viewer": mkUser("u-viewer", ["read"], "viewer"),
  "tok-editor": mkUser("u-editor", EDITOR_PERMS, "editor"),
  "tok-other": mkUser("u-other", ["read"], "viewer"),
};
const authResolver = async (bearer: string): Promise<AuthContext | null> =>
  IDENTITIES[bearer] ?? null;

let handle: { httpServer: import("node:http").Server; port: number };
const base = () => `http://127.0.0.1:${handle.port}`;

async function listToolNames(token: string): Promise<string[]> {
  const transport = new SSEClientTransport(new URL(`${base()}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

// Open a raw SSE stream and resolve the /messages path (with sessionId).
async function openSse(token: string): Promise<{ path: string; cancel: () => void }> {
  const res = await fetch(`${base()}/sse`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) throw new Error(`/sse ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/data:\s*(\/messages\?sessionId=[^\s]+)/);
    if (m) return { path: m[1], cancel: () => void reader.cancel().catch(() => {}) };
  }
  throw new Error("no endpoint event");
}

const postRpc = (path: string, token: string) =>
  fetch(`${base()}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });

describe("OAuth HTTP/SSE transport — RBAC + owner-binding (in-process)", () => {
  beforeAll(async () => {
    handle = await startHttpTransport({
      port: 0,
      bearerToken: "legacy-not-used-here",
      oauthEnabled: true,
      authResolver,
    });
  });
  afterAll(() => {
    handle?.httpServer.close();
  });

  it("rejects an unknown bearer with 401", async () => {
    const res = await fetch(`${base()}/sse`, {
      headers: { Authorization: "Bearer nope", Accept: "text/event-stream" },
    });
    expect(res.status).toBe(401);
  });

  it("filters tools/list by role — viewer sees reads but no write tools", async () => {
    const names = await listToolNames("tok-viewer");
    expect(names).toContain("list_projects"); // read tool visible
    expect(names).not.toContain("create_task"); // write:tasks hidden
    expect(names).not.toContain("create_selection"); // write:selections hidden
    expect(names).not.toContain("create_project"); // write:project (editor lacks too)
  });

  it("filters tools/list by role — editor sees the write tools it is granted", async () => {
    const names = await listToolNames("tok-editor");
    expect(names).toContain("create_task");
    expect(names).toContain("create_selection");
    expect(names).toContain("create_budget_item");
    expect(names).not.toContain("create_project"); // needs write:project
    expect(names).not.toContain("delete_selection"); // needs delete
  });

  it("enforces the per-call permission gate — viewer is denied a write tool", async () => {
    const transport = new SSEClientTransport(new URL(`${base()}/sse`), {
      requestInit: { headers: { Authorization: "Bearer tok-viewer" } },
    });
    const client = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const res: any = await client.callTool({ name: "create_task", arguments: {} });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/permission denied/i);
    } finally {
      await client.close();
    }
  });

  it("owner-binds /messages — a different bearer gets 404, the owner gets 202", async () => {
    const sess = await openSse("tok-viewer"); // session owned by u-viewer
    try {
      const attacker = await postRpc(sess.path, "tok-other"); // different principal
      const owner = await postRpc(sess.path, "tok-viewer"); // the owner
      expect(attacker.status).toBe(404); // uniform with unknown-session
      expect(owner.status).toBe(202);
    } finally {
      sess.cancel();
    }
  });
});
