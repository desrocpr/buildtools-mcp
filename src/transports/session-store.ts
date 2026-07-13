/**
 * In-memory session-credentials store for the HTTP/SSE transport (MOS-220,
 * Phase 6).
 *
 * Background
 * ----------
 * Stdio runs one MCP server process per user (spawned by Claude Desktop), so
 * BuildTools credentials live in `process.env` — naturally per-user. The
 * HTTP/SSE transport flips that: ONE server process serves MANY users over
 * separate SSE sessions. Each session must therefore supply its OWN BuildTools
 * credentials via the `set_session_credentials` tool before any BuildTools
 * read/write tool will run for that session.
 *
 * Design
 * ------
 * - The store is keyed by the SDK-generated SSE `sessionId`. The HTTP
 *   transport layer (NOT individual tools) is responsible for both writing
 *   into the store (via `set_session_credentials`) and constructing a fresh
 *   `BuildToolsAPI` per session on demand.
 * - On SSE `close`, the transport MUST call `delete(sessionId)` so credentials
 *   do not outlive the connection.
 * - Credentials are held in plain JS objects in memory. The bearer-token
 *   authenticated express layer is the trust boundary; if that boundary is
 *   broken nothing in this store helps. Never log the password.
 *
 * Audit logging
 * -------------
 * The `auditLog` helper lives in this file (and not in a separate audit-log
 * module) because the MOS-220 contract scopes new transport-layer files to
 * `src/transports/session-store.ts` only. Audit lines are written to stderr
 * by both the stdio and HTTP transports on every tool dispatch.
 * TODO(follow-up): a structured-log-file destination in prod is out of scope
 * for Phase 6 (operator-level concern, not a Phase 6 acceptance criterion).
 */

/**
 * BuildTools credentials supplied by an SSE client via the
 * `set_session_credentials` tool.
 */
export interface SessionCredentials {
  /** BuildTools tenant subdomain (e.g. `"moss"`). */
  tenant: string;
  /** Per-user BuildTools username/email. */
  username: string;
  /** Per-user BuildTools password. Treat as a secret — never log. */
  password: string;
}

/**
 * Maps SSE `sessionId` → credentials. Pure in-memory, process-local.
 */
export class SessionStore {
  private readonly store = new Map<string, SessionCredentials>();
  // Phase 6a (MOS-328): per-session resolved auth context.
  // Kept in a parallel Map so the legacy SessionCredentials shape stays
  // stable for callers that don't need OAuth identity yet.
  // The type is `unknown` here to avoid an import cycle with src/auth/;
  // the HTTP transport casts it back to AuthContext at the dispatch
  // layer in Phase 6b.
  private readonly authStore = new Map<string, unknown>();
  // Owner-binding: the connect-time identity key (see `sessionOwnerKey`).
  // Set once at `/sse` and never mutated; `/messages` rejects requests whose
  // resolved identity does not match.
  private readonly ownerStore = new Map<string, string>();

  /** Replace any prior credentials for `sessionId`. */
  set(sessionId: string, creds: SessionCredentials): void {
    this.store.set(sessionId, creds);
  }

  /** Returns credentials for `sessionId`, or `undefined` if not set. */
  get(sessionId: string): SessionCredentials | undefined {
    return this.store.get(sessionId);
  }

  /** Attach a resolved auth context to a session. */
  setAuth(sessionId: string, ctx: unknown): void {
    this.authStore.set(sessionId, ctx);
  }

  /** Returns the auth context for `sessionId`, or `undefined`. */
  getAuth<T>(sessionId: string): T | undefined {
    return this.authStore.get(sessionId) as T | undefined;
  }

  /** Record the connect-time owner key for a session (owner-binding). */
  setOwner(sessionId: string, ownerKey: string): void {
    this.ownerStore.set(sessionId, ownerKey);
  }

  /** Returns the owner key for `sessionId`, or `undefined` if unbound. */
  getOwner(sessionId: string): string | undefined {
    return this.ownerStore.get(sessionId);
  }

  /** Returns `true` if the entry existed and was removed. */
  delete(sessionId: string): boolean {
    this.authStore.delete(sessionId);
    this.ownerStore.delete(sessionId);
    return this.store.delete(sessionId);
  }

  /** Current number of active sessions (useful for tests). */
  size(): number {
    return this.store.size;
  }

  /** Wipe everything — used by tests. */
  clear(): void {
    this.store.clear();
    this.authStore.clear();
    this.ownerStore.clear();
  }
}

/** Minimal structural view of a resolved auth context, so this module needs
 * no import of `AuthContext` (which would create a cycle with `src/auth/`). */
interface AuthContextView {
  kind?: string;
  user?: { id?: string | null } | null;
}

/**
 * Stable identity key for owner-binding an SSE session (MOS-631 follow-up).
 *
 * The `/messages` endpoint routes purely by the `?sessionId=` query param and
 * does not otherwise bind a request to the session's owner — so without a check,
 * any caller who learns a session id could POST into another user's session. The
 * transport records this key for the connecting principal at `/sse` and rejects
 * any `/messages` whose bearer resolves to a different key.
 *
 *   - OAuth / service identities key on `kind:userId` — namespacing by kind so
 *     a human token and a service token are never interchangeable even if they
 *     somehow resolved to the same underlying `mcp_users.id`.
 *   - Legacy-bearer callers share one key (`"legacy"`) — they are one trust
 *     principal (the shared `HTTP_BEARER_TOKEN`), so any legacy caller may post
 *     to a legacy session, but never to an OAuth/service one, and vice-versa.
 *   - Returns `null` when there is no identity to bind (e.g. OAuth disabled);
 *     the caller treats a `null` recorded owner as "no binding to enforce",
 *     preserving pre-Phase-6 behavior.
 */
export function sessionOwnerKey(ctx: AuthContextView | undefined): string | null {
  if (!ctx) return null;
  if (ctx.user?.id) return `${ctx.kind ?? "u"}:${ctx.user.id}`;
  if (ctx.kind === "legacy") return "legacy";
  return null;
}

/**
 * One-line audit record emitted to stderr by both transports on every tool
 * dispatch. The format is intentionally simple so a follower like
 * `grep tool=` is trivial; if structured logging is needed later the parser
 * can match on the `key=value` pairs.
 *
 * Format:
 *   `[<iso-ts>] audit sessionId=<id> user=<username|unauthenticated> tool=<name> result=<ok|error>`
 *
 * Constraints:
 *   - `username` is either the BuildTools username or the literal string
 *     `"unauthenticated"` when the call did not reach BuildTools (e.g. `ping`,
 *     pre-`set_session_credentials` calls).
 *   - `sessionId` is the literal `"stdio"` for the stdio transport.
 *   - The BuildTools password MUST NEVER appear on this line. The bearer
 *     token MUST NEVER appear on this line.
 */
export function auditLog(opts: {
  sessionId: string;
  username: string | undefined;
  tool: string;
  result: "ok" | "error";
}): void {
  const ts = new Date().toISOString();
  const user = opts.username && opts.username.length > 0 ? opts.username : "unauthenticated";
  // Strip CR/LF from any caller-supplied field so a malicious username or
  // tool name cannot forge fake audit lines via log injection. The
  // BuildTools username is taken from `set_session_credentials` input,
  // and the tool name comes from the MCP request — both are attacker-
  // controllable behind a valid bearer. (MEDIUM-2, MOS-220 review.)
  const sanitize = (s: string): string => s.replace(/[\r\n]+/g, " ");
  // eslint-disable-next-line no-console
  process.stderr.write(
    `[${ts}] audit sessionId=${sanitize(opts.sessionId)} user=${sanitize(user)} tool=${sanitize(opts.tool)} result=${opts.result}\n`,
  );
}
