/**
 * Supabase client factory (MOS-328 Phase 2).
 *
 * Server-side only. We use the SERVICE_ROLE key, which bypasses RLS —
 * the auth tables have RLS enabled with no policies precisely so that
 * the only way to read/write them is via this client. There is no
 * user-facing PostgREST surface for `mcp_*` tables.
 *
 * The client is constructed once at server boot via `createDb()` and
 * passed through the auth helpers. Tests inject a stub instead of
 * touching the network.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

export type Db = SupabaseClient;

export interface CreateDbOptions {
  /** Source for env vars. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a Supabase client from env. Fails loud if either of the two
 * required vars is missing — we'd rather crash at boot than 500 on
 * the first enrollment attempt.
 */
export function createDb(opts: CreateDbOptions = {}): Db {
  const env = opts.env ?? process.env;
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL env var is required");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var is required");

  return createClient(url, key, {
    auth: {
      // No browser session, no auto-refresh. Server is the trust boundary.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: {
      schema: "public",
    },
    // Supabase's realtime client eagerly instantiates in the constructor
    // and requires a global WebSocket. Node 20 (what's on Lightsail)
    // doesn't ship one natively, so we hand it the `ws` polyfill.
    // We don't use realtime anywhere, but supabase-js fails-loud if no
    // transport is wired.
    realtime: {
      transport: WebSocket as unknown as never,
    },
  });
}
