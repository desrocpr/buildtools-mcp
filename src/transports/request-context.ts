/**
 * Per-request auth context for the HTTP/SSE transport (MOS-631 follow-up).
 *
 * The MCP SDK invokes tool-list / tool-call handlers in a call context that
 * cannot see the Express `req`. This `AsyncLocalStorage` is the bridge: the
 * `/messages` handler wraps `transport.handlePostMessage` in `runWithRequestAuth`
 * with the auth context the bearer middleware just re-resolved for THIS request,
 * and the handlers read it back via `currentRequestAuth`.
 *
 * Why this instead of a per-session snapshot: the resolver re-reads the user's
 * roles from the DB on every request, so reading the live request context makes
 * permission decisions always-current (a role change takes effect on the next
 * request) AND removes the mutable per-session auth snapshot as a second,
 * overwritable source of truth. The session's connect-time identity is still
 * kept (for the confirmation subject and owner-binding), but it is never the
 * thing a per-request permission check reads.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthContext } from "../auth/resolver.js";

const store = new AsyncLocalStorage<AuthContext | undefined>();

/** Run `fn` with `auth` as the ambient request auth context. Returns `fn`'s
 * result; the context propagates across awaits within `fn`. */
export function runWithRequestAuth<T>(
  auth: AuthContext | undefined,
  fn: () => T,
): T {
  return store.run(auth, fn);
}

/** The auth context of the in-flight `/messages` request, or `undefined`
 * outside a `runWithRequestAuth` scope (e.g. the stdio transport). */
export function currentRequestAuth(): AuthContext | undefined {
  return store.getStore();
}
