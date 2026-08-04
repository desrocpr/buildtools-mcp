/**
 * Write outcomes for the operations-management interface (MOS-747).
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every write on `BuildToolsAPI` returns `{ success: boolean }`. That type
 * cannot express "I don't know", and for a remote write "I don't know" is a
 * real, common, and dangerous state:
 *
 *   - `post()` parses the response body as JSON and DISCARDS the HTTP status
 *     (`BuildToolsAPI.post`). A 500 whose body happens to be JSON therefore
 *     parses cleanly, fails the `r === 1` check, and is reported as a clean
 *     failure — even though a 500 can be thrown *after* the row was written.
 *   - When the body does NOT parse (BuildTools drifts — it is a
 *     reverse-engineered app and its templates change), `post()` returns a
 *     `{ status, body }` fallback. That object also fails `r === 1`, so a
 *     drifted response is likewise reported as a clean failure.
 *   - A network error or timeout throws. At least one call site caught that
 *     and converted it into `{ success: false }` too.
 *
 * In all three cases the write MAY HAVE LANDED. Reporting them as failure is
 * how a create that actually succeeded becomes a duplicate on retry — the
 * precise defect MOS-747 exists to stop.
 *
 * THE MODEL
 *
 * Three states, and the distinction that matters is the second vs the third:
 *
 *   ok         — upstream returned a structured success. It landed.
 *   failed     — upstream returned a structured REJECTION. Proof it did not
 *                land. Safe to retry as-is.
 *   ambiguous  — we never got a structured verdict. It may or may not have
 *                landed. NOT safe to retry blindly; reconcile first.
 *
 * `ambiguous` is deliberately the fallback for anything unrecognised. When in
 * doubt the answer is "I don't know", never "it failed" — a false `failed`
 * causes duplicates, whereas a false `ambiguous` only costs a reconcile probe.
 *
 * This mirrors the contract Cambium's `ConstructionPmAdapter` already states
 * ("Throwing = the outcome is AMBIGUOUS ... never assume a throw means 'not
 * created'"), expressed as a value instead of a thrown error so it survives
 * being serialised across the HTTP gateway hop.
 */

import { BuildToolsNetworkError } from "../client/errors.js";

// ---------------------------------------------------------------------------
// The outcome type
// ---------------------------------------------------------------------------

/** Upstream gave a structured success. The write landed. */
export interface WriteOk<T> {
  status: "ok";
  data: T;
}

/**
 * Upstream gave a structured rejection — validation errors, a business-rule
 * refusal, an explicit negative result code. This is PROOF the write did not
 * land, so a caller may retry (after fixing the input) without reconciling.
 */
export interface WriteFailed {
  status: "failed";
  reason: string;
  /** The structured error payload from upstream, when there was one. */
  details?: unknown;
}

/**
 * We did not get a structured verdict. The write MAY have landed.
 *
 * A caller MUST NOT retry blindly. It must first reconcile — determine whether
 * the write is present upstream — and only then decide to retry or not.
 */
export interface WriteAmbiguous {
  status: "ambiguous";
  reason: string;
  /**
   * How to find out whether it landed. Carries the reconcile hint (a marker,
   * a search term, an idempotency key) so the ambiguity is actionable rather
   * than merely alarming. Mirrors Cambium's `findByMarker` probe.
   */
  probe?: string;
}

export type WriteOutcome<T> = WriteOk<T> | WriteFailed | WriteAmbiguous;

// ---------------------------------------------------------------------------
// Constructors — terse, so call sites read as prose
// ---------------------------------------------------------------------------

export function ok<T>(data: T): WriteOk<T> {
  return { status: "ok", data };
}

export function failed(reason: string, details?: unknown): WriteFailed {
  return details === undefined
    ? { status: "failed", reason }
    : { status: "failed", reason, details };
}

export function ambiguous(reason: string, probe?: string): WriteAmbiguous {
  return probe === undefined
    ? { status: "ambiguous", reason }
    : { status: "ambiguous", reason, probe };
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

export function isOk<T>(o: WriteOutcome<T>): o is WriteOk<T> {
  return o.status === "ok";
}

/**
 * True when the caller must reconcile before retrying.
 *
 * Prefer this over `o.status === "ambiguous"` at retry sites — it states the
 * question being asked ("is a blind retry safe?") rather than the shape.
 */
export function needsReconcile<T>(o: WriteOutcome<T>): o is WriteAmbiguous {
  return o.status === "ambiguous";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * A write response with the HTTP status PRESERVED.
 *
 * `BuildToolsAPI.post()` throws the status away whenever the body parses,
 * which is exactly what makes a JSON-bodied 500 indistinguishable from a
 * business rejection. Classification needs the status, so writes must hand us
 * this shape rather than `post()`'s return value.
 */
export interface RawWriteResponse {
  /** HTTP status code. */
  status: number;
  /** Raw response body, for diagnostics when parsing failed. */
  body: string;
  /**
   * The parsed body, or `undefined` when it did not parse as JSON.
   * `undefined` means BuildTools drifted — which is ambiguous, not failure.
   */
  json?: unknown;
}

/** How a caller reads success and rejection out of a parsed body. */
export interface ClassifySpec<T> {
  /**
   * Return the success value when the payload represents a structured
   * success, otherwise `undefined`. For most BuildTools endpoints this is
   * `p.r === 1`.
   */
  readSuccess: (payload: Record<string, unknown>) => T | undefined;
  /**
   * Return the structured rejection detail when the payload represents an
   * explicit upstream refusal, otherwise `undefined`.
   *
   * Returning `undefined` here means "no structured verdict either way",
   * which classifies as AMBIGUOUS — not as failure. Only return a value when
   * upstream actually told us it refused.
   */
  readRejection?: (payload: Record<string, unknown>) => unknown | undefined;
  /** Reconcile hint propagated onto an ambiguous outcome. */
  probe?: string;
}

/**
 * Default rejection reader for BuildTools' save endpoints, which signal
 * refusal with an `e` or `errors` field alongside a non-1 result code.
 */
export function readBuildToolsRejection(
  payload: Record<string, unknown>,
): unknown | undefined {
  const detail = payload.e ?? payload.errors ?? payload.message;
  if (detail !== undefined && detail !== null) return detail;
  // An explicit non-1 result code is itself a structured verdict: the save
  // handler ran and reported a negative. That is proof it did not land.
  if (typeof payload.r === "number" && payload.r !== 1) return { r: payload.r };
  return undefined;
}

/**
 * Classify a raw write response into an outcome.
 *
 * Order matters — status is checked BEFORE the body, because a non-2xx is
 * ambiguous no matter how parseable its body is.
 */
export function classifyWriteResponse<T>(
  res: RawWriteResponse,
  spec: ClassifySpec<T>,
): WriteOutcome<T> {
  // Non-2xx: the server may have applied the write before failing. Unknowable
  // from here, regardless of what the body says.
  if (res.status < 200 || res.status >= 300) {
    return ambiguous(
      `upstream returned HTTP ${res.status}; the write may or may not have been applied`,
      spec.probe,
    );
  }

  // 2xx but the body did not parse — BuildTools drifted. A drifted success
  // page and a drifted error page are indistinguishable to us.
  if (res.json === undefined || res.json === null) {
    return ambiguous(
      "upstream response was not parseable JSON (BuildTools template drift); the write may or may not have been applied",
      spec.probe,
    );
  }

  if (typeof res.json !== "object") {
    return ambiguous(
      `upstream returned a non-object body (${typeof res.json}); the write may or may not have been applied`,
      spec.probe,
    );
  }

  const payload = res.json as Record<string, unknown>;

  const success = spec.readSuccess(payload);
  if (success !== undefined) return ok(success);

  const rejection = (spec.readRejection ?? readBuildToolsRejection)(payload);
  if (rejection !== undefined) {
    return failed(describeRejection(rejection), rejection);
  }

  // Parsed, 2xx, but recognisable as neither success nor rejection. We have no
  // verdict — treat as unknown rather than guessing failure.
  return ambiguous(
    "upstream returned no recognisable success or rejection signal; the write may or may not have been applied",
    spec.probe,
  );
}

/**
 * Classify a thrown error from a write.
 *
 * A network error or timeout is ALWAYS ambiguous: the request may have reached
 * BuildTools and been applied before the connection died. This is the case
 * that was previously swallowed into `{ success: false }`.
 *
 * Re-thrown for anything that is not a recognised transport failure — a bug in
 * our own code should surface as a bug, not be laundered into an outcome.
 */
export function classifyWriteError(err: unknown, probe?: string): WriteAmbiguous {
  if (err instanceof BuildToolsNetworkError) {
    return ambiguous(
      `network failure during write (${err.message}); the write may or may not have been applied`,
      probe,
    );
  }
  if (isAbortLike(err)) {
    return ambiguous(
      "write timed out; the write may or may not have been applied",
      probe,
    );
  }
  throw err;
}

function isAbortLike(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function describeRejection(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.filter((d) => typeof d === "string");
    if (parts.length > 0) return parts.join("; ");
  }
  if (typeof detail === "object" && detail !== null) {
    const msg = (detail as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return "upstream rejected the write";
}
