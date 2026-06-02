-- MOS-328 Phase 7.5 hardening v2 — sweep grace fix.
--
-- The sweep_oauth_state function from migration 20260602010000 deleted
-- revoked refresh tokens IMMEDIATELY. That destroyed the
-- parent_token_id rotation chain used for replay-detection audit:
-- a stolen old refresh token replayed after the sweep would 404 the
-- same way an unknown token does, with no record of the original
-- compromise.
--
-- Replace the function with a 7-day retention window on revoked
-- refresh tokens (matches typical security-investigation horizons).
-- Access tokens still get the 1-day grace because they're short-lived
-- and the chain doesn't depend on their persistence.

create or replace function public.sweep_oauth_state()
returns table (
  codes_deleted bigint,
  access_tokens_deleted bigint,
  refresh_tokens_deleted bigint,
  rate_buckets_deleted bigint
)
language plpgsql
as $$
declare
  v_codes bigint;
  v_access bigint;
  v_refresh bigint;
  v_buckets bigint;
begin
  delete from public.mcp_oauth_codes
  where expires_at < now() - interval '1 hour';
  get diagnostics v_codes = row_count;

  delete from public.mcp_oauth_tokens
  where kind = 'access'
    and (revoked_at is not null or expires_at < now() - interval '1 day');
  get diagnostics v_access = row_count;

  -- Refresh tokens: 7-day grace on revoked rows preserves the
  -- parent_token_id chain for replay detection / forensic analysis.
  delete from public.mcp_oauth_tokens
  where kind = 'refresh'
    and (
      (revoked_at is not null and revoked_at < now() - interval '7 days')
      or (revoked_at is null and expires_at < now() - interval '1 day')
    );
  get diagnostics v_refresh = row_count;

  delete from public.mcp_rate_buckets
  where window_start < now() - interval '2 hours';
  get diagnostics v_buckets = row_count;

  return query select v_codes, v_access, v_refresh, v_buckets;
end;
$$;

comment on function public.sweep_oauth_state is
  'Delete expired OAuth state. Revoked refresh tokens keep a 7-day grace '
  'so the rotation chain remains queryable for replay-detection audits.';
