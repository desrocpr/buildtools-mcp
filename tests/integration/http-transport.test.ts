/**
 * HTTP/SSE transport integration test (MOS-220, Phase 6).
 *
 * Spawns the built MCP server as a subprocess with `MCP_TRANSPORT=http` and
 * exercises the new transport via the SDK's `SSEClientTransport` plus a few
 * raw fetch calls (for bearer-token rejection cases).
 *
 * Coverage matches the MOS-220 acceptance criteria:
 *   - 5 — missing HTTP_BEARER_TOKEN at boot → non-zero exit + clear stderr
 *   - 6 — wrong bearer on GET /sse → 401
 *   - 7 — tools/list over a valid SSE session includes ping,
 *         set_session_credentials, list_projects
 *   - 8 — calling list_projects BEFORE set_session_credentials returns a
 *         Markdown isError response naming the missing handshake
 *   - 9 — set_session_credentials with valid args returns a success
 *         (no `isError`) ToolResult
 *   - 12 — at least one audit line appears on stderr for a dispatched call
 *
 * Constraints:
 *   - This test must NOT depend on a live BuildTools tenant. We exercise the
 *     handshake and the pre-creds error path; we do NOT call list_projects
 *     after the handshake (that would hit BuildTools).
 *   - This test must NOT modify the existing stdio transport behavior. The
 *     pre-existing `transport-smoke.test.ts` continues to pass untouched.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const distIndexPath = resolve(projectRoot, "dist/index.js");

const BEARER_TOKEN = "test-bearer-token-MOS-220";

/** Find an unused TCP port by binding port 0 and closing immediately. */
async function pickPort(): Promise<number> {
  return await new Promise<number>((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveFn(port));
      } else {
        srv.close(() => rejectFn(new Error("Could not resolve port")));
      }
    });
  });
}

/** Spawn the server subprocess and resolve once it logs "listening on :<port>". */
function spawnHttpServer(opts: {
  port: number;
  bearerToken?: string;
  defaultTenant?: string;
}): Promise<{ child: ChildProcessWithoutNullStreams; stderr: string[] }> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    MCP_TRANSPORT: "http",
    HTTP_PORT: String(opts.port),
  };
  if (opts.bearerToken) env.HTTP_BEARER_TOKEN = opts.bearerToken;
  else delete env.HTTP_BEARER_TOKEN;
  if (opts.defaultTenant) env.BUILDTOOLS_TENANT = opts.defaultTenant;

  const child = spawn("node", [distIndexPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.length > 0) stderr.push(line);
    }
  });

  return new Promise((resolveFn, rejectFn) => {
    const onError = (err: Error) => {
      rejectFn(err);
    };
    child.on("error", onError);

    const timer = setTimeout(() => {
      rejectFn(
        new Error(
          `Server did not start within 5s. stderr:\n${stderr.join("\n")}`,
        ),
      );
    }, 5000);

    const checkReady = (chunk: string) => {
      if (chunk.includes("listening on :")) {
        clearTimeout(timer);
        child.stderr.off("data", checkReady);
        child.off("error", onError);
        resolveFn({ child, stderr });
      }
    };
    child.stderr.on("data", checkReady);
  });
}

beforeAll(() => {
  // Ensure dist/ is fresh for all subtests.
  execSync("npm run build", { stdio: "inherit", cwd: projectRoot });
}, 60_000);

describe("MOS-220 — HTTP/SSE transport: boot-time validation", () => {
  it("AC 5 — exits non-zero with a clear stderr error when HTTP_BEARER_TOKEN is missing", async () => {
    const port = await pickPort();
    const child = spawn("node", [distIndexPath], {
      env: {
        ...process.env as Record<string, string>,
        MCP_TRANSPORT: "http",
        HTTP_PORT: String(port),
        HTTP_BEARER_TOKEN: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number>((resolveFn) => {
      child.on("exit", (code) => resolveFn(code ?? -1));
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("HTTP_BEARER_TOKEN");
  }, 10_000);
});

describe("MOS-220 — HTTP/SSE transport: live session", () => {
  let child: ChildProcessWithoutNullStreams;
  let stderr: string[];
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    port = await pickPort();
    const spawned = await spawnHttpServer({
      port,
      bearerToken: BEARER_TOKEN,
      defaultTenant: "moss",
    });
    child = spawned.child;
    stderr = spawned.stderr;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveFn) => {
        const timer = setTimeout(() => resolveFn(), 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveFn();
        });
      });
    }
  });

  it("AC 6 — returns 401 when the bearer token is wrong", async () => {
    const res = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    // Drain the body to release the socket.
    await res.text();
  });

  it("AC 6 — returns 401 when the Authorization header is missing entirely", async () => {
    const res = await fetch(`${baseUrl}/sse`);
    expect(res.status).toBe(401);
    await res.text();
  });

  describe("with a valid bearer-token SSE session", () => {
    let client: Client;

    beforeAll(async () => {
      // Inject Authorization on BOTH the SSE GET and the POST /messages
      // requests (SDK calls them separately).
      const authedFetch: typeof fetch = (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${BEARER_TOKEN}`,
          },
        });
      const transport = new SSEClientTransport(
        new URL(`${baseUrl}/sse`),
        {
          eventSourceInit: { fetch: authedFetch },
          requestInit: { headers: { Authorization: `Bearer ${BEARER_TOKEN}` } },
        },
      );
      client = new Client(
        { name: "mos-220-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
    }, 15_000);

    afterAll(async () => {
      await client?.close();
    });

    it("AC 7 — tools/list includes ping, set_session_credentials, and existing tools", async () => {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("ping");
      expect(names).toContain("set_session_credentials");
      expect(names).toContain("list_projects");
    });

    it("AC 8 — calling list_projects BEFORE set_session_credentials returns an isError ToolResult", async () => {
      const result = await client.callTool({
        name: "list_projects",
        arguments: { limit: 5 },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0].type).toBe("text");
      expect(content[0].text).toMatch(/set_session_credentials/);
    });

    it("AC 9 — set_session_credentials with valid args returns a success ToolResult", async () => {
      const result = await client.callTool({
        name: "set_session_credentials",
        arguments: {
          username: "alice@example.com",
          password: "irrelevant-not-validated-here",
          tenant: "moss",
        },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0].type).toBe("text");
      expect(content[0].text).toMatch(/alice@example\.com/);
      // Defense in depth: the success message MUST NOT echo the password.
      expect(content[0].text).not.toMatch(/irrelevant-not-validated-here/);
    });

    it("AC 12 — at least one audit line was emitted to stderr", async () => {
      // Give the most recent call's stderr a moment to flush.
      await new Promise((r) => setTimeout(r, 100));
      const auditLines = stderr.filter((l) => l.includes("audit "));
      expect(auditLines.length).toBeGreaterThan(0);
      // The audit lines must not contain the bearer token or the password.
      const joined = auditLines.join("\n");
      expect(joined).not.toContain(BEARER_TOKEN);
      expect(joined).not.toContain("irrelevant-not-validated-here");
    });
  });
});

describe("MOS-220 — no logging of secrets", () => {
  it("AC 11 — the new transport source files do NOT console.log the password or bearer", async () => {
    // Smoke-grep the new transport sources; we already cover the runtime
    // behavior in the audit-line test above.
    const { readFileSync } = await import("node:fs");
    const sources = [
      resolve(projectRoot, "src/transports/http.ts"),
      resolve(projectRoot, "src/transports/session-store.ts"),
      resolve(projectRoot, "src/tools/sessions.ts"),
    ];
    for (const src of sources) {
      const text = readFileSync(src, "utf-8");
      // Strip comments before grepping so docstrings naming "password" are
      // not flagged. We're looking for code that LOGS the value.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      // Forbid console.log/error of variables literally named password/bearer.
      expect(stripped).not.toMatch(/console\.(log|error|warn|info)\s*\([^)]*password/i);
      expect(stripped).not.toMatch(/console\.(log|error|warn|info)\s*\([^)]*bearer/i);
      expect(stripped).not.toMatch(/process\.stderr\.write\s*\([^)]*password/i);
      expect(stripped).not.toMatch(/process\.stderr\.write\s*\([^)]*bearer/i);
    }
  });
});
