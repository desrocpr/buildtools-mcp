-- MOS-328 hardening: atomic RPCs + nightly sweep.
--
-- Adds three Postgres functions called from the application layer to
-- close races that the read-modify-write pattern in audit.ts and
-- oauth-store.ts left open:
--
--   - public.increment_rate_bucket(...)
--     Single-statement upsert + count returning the new value. Replaces
--     the application-level select-decide-write that allowed two
--     concurrent calls to both pass the limit check.
--
--   - public.rotate_refresh_token(...)
--     Atomically marks the old refresh token revoked and inserts the
--     new (access, refresh) pair in one transaction. Prevents the
--     "crash between revoke and issue" lockout window.
--
--   - public.sweep_oauth_state()
--     Hard-deletes expired auth codes, expired access tokens, revoked
--     tokens, and stale rate buckets. Scheduled via pg_cron nightly.

-- ============================================================
-- 1. increment_rate_bucket — atomic check-and-increment
-- ============================================================

create or replace function public.increment_rate_bucket(
  p_user_id uuid,
  p_bucket text,
  p_window_start timestamptz,
  p_limit integer
)
returns table (allowed boolean, new_count integer)
language plpgsql
as $$
declare
  v_count integer;
begin
  -- Lock the row (or create it) for an atomic compare-and-increment.
  insert into public.mcp_rate_buckets (user_id, permission_bucket, window_start, count)
  values (p_user_id, p_bucket, p_window_start, 0)
  on conflict (user_id, permission_bucket, window_start) do nothing;

  -- Read the current count under row lock.
  select count into v_count
  from public.mcp_rate_buckets
  where user_id = p_user_id
    and permission_bucket = p_bucket
    and window_start = p_window_start
  for update;

  if p_limit is not null and v_count >= p_limit then
    return query select false as allowed, v_count as new_count;
    return;
  end if;

  update public.mcp_rate_buckets
  set count = count + 1
  where user_id = p_user_id
    and permission_bucket = p_bucket
    and window_start = p_window_start;

  return query select true as allowed, (v_count + 1) as new_count;
end;
$$;

comment on function public.increment_rate_bucket(uuid, text, timestamptz, integer) is
  'Atomically check-and-increment a rate bucket. Returns (allowed, new_count). '
  'Pass p_limit=NULL for "count but never block".';

-- ============================================================
-- 2. rotate_refresh_token — atomic revoke + issue pair
-- ============================================================
-- Caller computes the new token hashes + IDs application-side; this
-- function only owns the database transaction. That keeps the
-- crypto in the application (so the new tokens never touch Postgres
-- in plaintext) while gaining atomicity.

create or replace function public.rotate_refresh_token(
  p_old_token_hash text,
  p_new_access_id uuid,
  p_new_access_hash text,
  p_new_access_expires_at timestamptz,
  p_new_refresh_id uuid,
  p_new_refresh_hash text,
  p_new_refresh_expires_at timestamptz
)
returns table (
  user_id uuid,
  client_id text,
  scope text
)
language plpgsql
as $$
declare
  v_old record;
begin
  -- Look up + revoke the old refresh in one statement. If not
  -- found / already revoked / expired, raise NO_DATA_FOUND so the
  -- caller surfaces invalid_grant.
  update public.mcp_oauth_tokens
  set revoked_at = now()
  where token_hash = p_old_token_hash
    and kind = 'refresh'
    and revoked_at is null
    and expires_at > now()
  returning id, mcp_oauth_tokens.user_id, mcp_oauth_tokens.client_id, mcp_oauth_tokens.scope
  into v_old;

  if not found then
    raise exception 'invalid_grant' using errcode = 'P0002';
  end if;

  -- Insert the rotated pair, both chained to the old refresh id.
  insert into public.mcp_oauth_tokens (
    id, token_hash, kind, user_id, client_id, scope, expires_at, parent_token_id
  ) values
    (p_new_access_id, p_new_access_hash, 'access', v_old.user_id, v_old.client_id, v_old.scope, p_new_access_expires_at, v_old.id),
    (p_new_refresh_id, p_new_refresh_hash, 'refresh', v_old.user_id, v_old.client_id, v_old.scope, p_new_refresh_expires_at, v_old.id);

  return query select v_old.user_id, v_old.client_id, v_old.scope;
end;
$$;

comment on function public.rotate_refresh_token is
  'Atomic refresh-token rotation: revokes the old refresh and inserts a new (access, refresh) pair. '
  'Raises invalid_grant when the old token is missing/revoked/expired.';

-- ============================================================
-- 3. sweep_oauth_state — deletable rows past their useful TTL
-- ============================================================

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
  -- Auth codes: 60-second TTL; clean anything > 1 hour old.
  delete from public.mcp_oauth_codes
  where expires_at < now() - interval '1 hour';
  get diagnostics v_codes = row_count;

  -- Access tokens: 1-hour TTL; clean anything > 1 day past expiry.
  delete from public.mcp_oauth_tokens
  where kind = 'access'
    and (revoked_at is not null or expires_at < now() - interval '1 day');
  get diagnostics v_access = row_count;

  -- Refresh tokens: 30-day TTL; clean revoked ones immediately, and
  -- expired ones past a 1-day grace.
  delete from public.mcp_oauth_tokens
  where kind = 'refresh'
    and (revoked_at is not null or expires_at < now() - interval '1 day');
  get diagnostics v_refresh = row_count;

  -- Rate buckets: 1-hour sliding window; clean anything > 2 hours old.
  delete from public.mcp_rate_buckets
  where window_start < now() - interval '2 hours';
  get diagnostics v_buckets = row_count;

  return query select v_codes, v_access, v_refresh, v_buckets;
end;
$$;

comment on function public.sweep_oauth_state is
  'Delete expired OAuth state. Called nightly by pg_cron.';

-- ============================================================
-- 4. Schedule the sweep via pg_cron
-- ============================================================
-- The pg_cron extension is enabled by default on Supabase. The job
-- fires at 03:30 UTC every day. We swallow any error from cron.schedule
-- because re-running this migration shouldn't fail if the schedule
-- already exists.

do $$
begin
  perform cron.schedule(
    'mcp-sweep-oauth-state',
    '30 3 * * *',
    $cron$ select public.sweep_oauth_state(); $cron$
  );
exception when others then
  -- pg_cron not available in local dev / shadow db; that's fine.
  raise notice 'cron.schedule skipped: %', sqlerrm;
end;
$$;

-- ============================================================
-- 5. Drop the redundant index on (kind)
-- ============================================================
-- Per database review (C3): the standalone (kind) index doesn't help
-- the resolveAccessToken query — the unique constraint on token_hash
-- is the leading index. Drop to reduce write amplification.

drop index if exists public.mcp_oauth_tokens_kind_idx;

-- ============================================================
-- 6. Cover (user_id, kind, revoked_at) for the "revoke all for user" sweep
-- ============================================================

create index if not exists mcp_oauth_tokens_user_revoke_idx
  on public.mcp_oauth_tokens (user_id, kind)
  where revoked_at is null;

-- ============================================================
-- 7. Index on mcp_audit_log.token_id
-- ============================================================

create index if not exists mcp_audit_log_token_idx
  on public.mcp_audit_log (token_id)
  where token_id is not null;
