/**
 * Session-credentials tool for the HTTP/SSE transport (MOS-220, Phase 6).
 *
 * Exposes ONE tool — `set_session_credentials` — which lets an SSE client
 * hand its BuildTools username/password (and optional tenant) to the server.
 * The credentials are stored in an in-memory `SessionStore` keyed by the
 * SDK-generated SSE `sessionId`, and the HTTP transport layer constructs a
 * fresh `BuildToolsAPI` per session from them on first BuildTools-bound call.
 *
 * Why a factory per session?
 *   The tool needs to know which session it is running under in order to write
 *   into the store under the right key. The MCP SDK's request-handler API
 *   does not surface a sessionId to individual tool handlers, so we close over
 *   the sessionId at server-construction time (one `Server` per SSE session)
 *   and emit a tool whose handler already knows its own session.
 *
 * Validation:
 *   Lazy. We DO NOT call `authenticate()` here — credentials are simply
 *   stashed. The first BuildTools-bound tool call validates them naturally
 *   via `BuildToolsAPI.ensureAuthenticated()`. This keeps the integration
 *   test runnable without network access (a deliberate choice per the
 *   MOS-220 contract's Open Question #3).
 *
 * Security:
 *   - The password value flows through this handler but is NEVER logged.
 *   - Failures from the Zod parse are surfaced as Markdown `isError: true`
 *     responses, not thrown — matches the rest of the tool surface.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { SessionStore } from "../transports/session-store.js";
import type { ToolDefinition, ToolResult } from "./projects.js";

const SetSessionCredentialsSchema = z.object({
  username: z
    .string()
    .min(1)
    .describe("Per-user BuildTools username/email."),
  password: z
    .string()
    .min(1)
    .describe("Per-user BuildTools password. Treated as a secret — never logged."),
  tenant: z
    .string()
    .min(1)
    .optional()
    .describe(
      "BuildTools tenant subdomain (e.g. 'moss'). Optional — falls back to the server's BUILDTOOLS_TENANT env var when omitted.",
    ),
});

function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Build the `set_session_credentials` tool bound to a specific SSE session.
 *
 * @param opts.sessionStore   - Process-wide store the tool writes into.
 * @param opts.sessionId      - SDK-generated SSE sessionId — the store key.
 * @param opts.defaultTenant  - Fallback tenant if the caller omits `tenant`
 *                              (typically `process.env.BUILDTOOLS_TENANT`).
 */
export function createSessionCredentialsTool(opts: {
  sessionStore: SessionStore;
  sessionId: string;
  defaultTenant?: string;
}): ToolDefinition {
  return {
    name: "set_session_credentials",
    description:
      "Set the BuildTools credentials this SSE session will use for all subsequent tool calls. " +
      "Required before any BuildTools-bound tool will run over the HTTP transport. " +
      "Credentials are held in memory until the SSE connection closes. " +
      "Inputs: `username` (string), `password` (string), and optional `tenant` (string, defaults to the server's BUILDTOOLS_TENANT).",
    inputSchema: zodToJsonSchema(SetSessionCredentialsSchema),
    handler: async (args) => {
      const parsed = SetSessionCredentialsSchema.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => {
            const path = i.path.length > 0 ? i.path.join(".") : "(root)";
            // Do NOT echo the offending value (it may be the password).
            return `- \`${path}\`: ${i.message}`;
          })
          .join("\n");
        return errorMarkdown(
          `**Invalid input for \`set_session_credentials\`:**\n${issues}`,
        );
      }

      const { username, password } = parsed.data;
      const tenant = parsed.data.tenant ?? opts.defaultTenant;
      if (!tenant || tenant.length === 0) {
        return errorMarkdown(
          "**Error calling `set_session_credentials`**: `tenant` is required " +
            "(neither the call arg nor the server's BUILDTOOLS_TENANT env var was set).",
        );
      }

      // Store eagerly; defer actual BuildTools authentication to the first
      // BuildTools-bound tool call (see file-level docblock).
      opts.sessionStore.set(opts.sessionId, { tenant, username, password });

      return {
        content: [
          {
            type: "text",
            text:
              `Credentials set for this session. Subsequent BuildTools tool calls ` +
              `will authenticate as \`${username}\` against tenant \`${tenant}\`. ` +
              `Credentials are forgotten when the SSE connection closes.`,
          },
        ],
      };
    },
  };
}
