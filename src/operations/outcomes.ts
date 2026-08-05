/**
 * Write outcomes — the NEUTRAL vocabulary of the operations-management
 * interface (MOS-747).
 *
 * This module has ZERO vendor imports by design. It states what a write
 * outcome *is*; how to derive one from a particular vendor's wire format is
 * adapter knowledge and lives in `adapters/<vendor>/classify.ts`. (The repo's
 * agnostic-integration rule: vendor types never appear in shared types.)
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every write on `BuildToolsAPI` returns `{ success: boolean }`. That type
 * cannot express "I don't know", and for a remote write "I don't know" is a
 * real, common, and dangerous state — a create whose result we failed to read
 * may well have landed, and a caller who reads that as failure will retry and
 * duplicate it.
 *
 * THE MODEL
 *
 *   ok         — upstream returned a structured success. The call was applied.
 *   failed     — upstream returned a structured REJECTION. Proof it did not
 *                land. Safe to retry as-is once the input is fixed.
 *   ambiguous  — no structured verdict was obtained. It may or may not have
 *                landed. NOT safe to retry blindly; reconcile first.
 *
 * `ambiguous` is deliberately the fallback for anything unrecognised. A false
 * `failed` costs duplicate records; a false `ambiguous` costs one reconcile
 * probe. The asymmetry decides every ambiguous case in this file.
 *
 * WHAT `ok` MEANS FOR BULK WRITES
 *
 * `ok` means THE CALL WAS APPLIED — not "every item succeeded". Several
 * BuildTools endpoints (`deleteBudgetItem`, `deleteSelection`,
 * `deleteFinancialStatement`, batch PO transitions) return succeeded/failed
 * counts, and `{r:1, s:0, f:0}` is documented upstream as a silent no-op. Those
 * methods therefore carry their counts in `T` (see `BulkWriteData`) rather than
 * collapsing partial application into a boolean. Fixing this reading now, before
 * ~20 methods each pick one implicitly, is deliberate.
 *
 * INTERACTION WITH THE IDEMPOTENCY CACHE (decide before wiring writes)
 *
 * `storeIdempotencyResult` currently refuses to cache when `isError === true`
 * (`src/idempotency/helpers.ts:203`), on the documented rationale that failures
 * should get a fresh attempt. That is right for `failed` and WRONG for
 * `ambiguous`: if an ambiguous write is rendered as an error it will not be
 * cached, so a retry carrying the same `idempotency_key` re-issues the write and
 * produces the duplicate this whole model exists to prevent.
 *
 * The rule when writes are wired: cache `ok` AND `ambiguous`; skip only
 * `failed`. An ambiguous replay must return "unknown — reconcile first" rather
 * than re-firing.
 *
 * WHY A VALUE AND NOT A THROW
 *
 * Cambium's `ConstructionPmAdapter` expresses the same distinction by throwing
 * (`BuildToolsAmbiguousError`). That works in-process but cannot cross the HTTP
 * gateway MOS-747 adds: an exception flattens into an undifferentiated 500,
 * losing exactly the two bits that matter (ambiguous-vs-failed, and the probe).
 * A value serialises. The mapping back to Cambium's convention is total —
 * ok → return, failed → throw Error, ambiguous → throw BuildToolsAmbiguousError.
 */

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

/** Upstream gave a structured success. The call was applied. */
export interface WriteOk<T> {
  status: "ok";
  data: T;
}

/**
 * A bounded shape for upstream rejection detail.
 *
 * Deliberately NOT `unknown`. These outcomes are rendered into MCP tool output
 * and serialised across the HTTP gateway to machine callers, so `details` is a
 * data-egress path. Typing it loosely invites a call site to write
 * `readRejection: (p) => p` and flow an entire upstream payload — which for a
 * construction-PM SaaS can echo other clients' names, addresses, and financial
 * figures — across that boundary. The narrow type makes the careless version a
 * compile error rather than silent over-collection.
 */
export type RejectionDetail = string | string[] | { message: string };

/**
 * Upstream gave a structured rejection — validation errors, a business-rule
 * refusal, an explicit negative result code. PROOF the write did not land, so a
 * caller may retry (after fixing the input) without reconciling.
 */
export interface WriteFailed {
  status: "failed";
  reason: string;
  details?: RejectionDetail;
}

/**
 * How a caller mechanically determines whether an ambiguous write landed.
 *
 * Structured, not prose: a remote caller receiving this across the gateway must
 * be able to act on it without parsing English. Mirrors the shape of Cambium's
 * `findByMarker(marker)` probe.
 */
export type ReconcileProbe =
  | { kind: "marker"; marker: string }
  | { kind: "search"; resource: string; query: string };

/**
 * No structured verdict was obtained. The write MAY have landed.
 *
 * A caller MUST NOT retry blindly. It must first reconcile — determine whether
 * the write is present upstream — and only then decide whether to retry.
 */
export interface WriteAmbiguous {
  status: "ambiguous";
  reason: string;
  /** How to find out whether it landed. Makes the ambiguity actionable. */
  probe?: ReconcileProbe;
}

export type WriteOutcome<T> = WriteOk<T> | WriteFailed | WriteAmbiguous;

/** Payload shape for writes that apply to many rows at once. */
export interface BulkWriteData {
  succeeded: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function ok<T>(data: T): WriteOk<T> {
  return { status: "ok", data };
}

export function failed(reason: string, details?: RejectionDetail): WriteFailed {
  return details === undefined
    ? { status: "failed", reason: redactUrls(reason) }
    : {
        status: "failed",
        reason: redactUrls(reason),
        // `details` is derived from the same upstream string as `reason`, so
        // redacting only one leaks a presigned URL through the other.
        details: redactDetail(details),
      };
}

function redactDetail(detail: RejectionDetail): RejectionDetail {
  if (typeof detail === "string") return redactUrls(detail);
  if (Array.isArray(detail)) return detail.map(redactUrls);
  return { message: redactUrls(detail.message) };
}

export function ambiguous(reason: string, probe?: ReconcileProbe): WriteAmbiguous {
  return probe === undefined
    ? { status: "ambiguous", reason: redactUrls(reason) }
    : { status: "ambiguous", reason: redactUrls(reason), probe };
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

/**
 * True when this outcome may be cached against an idempotency key.
 *
 * `ok` and `ambiguous` both must be cached; only `failed` is replayable from
 * scratch. See the idempotency note in this file's header — getting this
 * backwards reopens the duplicate-write hole.
 */
export function isCacheable<T>(o: WriteOutcome<T>): boolean {
  return o.status !== "failed";
}

// ---------------------------------------------------------------------------
// Egress sanitisation
// ---------------------------------------------------------------------------

/**
 * Strip query strings from any URL appearing in a human-readable reason.
 *
 * Reasons are built partly from upstream error messages, and BuildTools'
 * network errors embed the request URL verbatim (`BuildToolsAPI.ts:566`,
 * `:1219`). The download path follows BuildTools' 302s to short-lived presigned
 * S3 URLs (`BuildToolsAPI.ts:1164`) whose query strings carry
 * `X-Amz-Signature` / `X-Amz-Credential`. Outcomes are destined for MCP output
 * and the HTTP gateway, so this is the last place that can sanitise before the
 * value crosses a trust boundary.
 *
 * The path is kept — that is the part with diagnostic value; only the query is
 * dropped.
 */
export function redactUrls(text: string): string {
  return text.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]");
}
