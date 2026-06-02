-- MCP multi-user OAuth schema (MOS-328 Phase 1)
--
-- Tables for human + service users, role-based permissions, encrypted
-- downstream-SaaS credentials, OAuth 2.1 dynamic-client + code/token store,
-- long-lived service tokens, audit log, and sliding-window rate buckets.
--
-- Multi-MCP capable: the `service` column on credentials and
-- `mcp_server` column on audit_log let one moss-mcp Supabase project
-- back multiple Claude-facing MCP servers (BuildTools today, others later).
--
-- RLS is enabled on every table; only the service role bypasses it.
-- Application code uses the service role key — there is no direct
-- user-facing PostgREST surface for these tables.

-- ============================================================
-- Users
-- ============================================================

create table public.mcp_users (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('human','service')),
  -- Azure AD `sub` claim — required for humans, NULL for services.
  azure_sub text unique,
  email text not null,
  display_name text,
  status text not null default 'active' check (status in ('active','revoked')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  constraint mcp_users_kind_azure_sub_consistency check (
    (kind = 'human' and azure_sub is not null) or
    (kind = 'service' and azure_sub is null)
  )
);
create index mcp_users_email_idx on public.mcp_users (lower(email));
create index mcp_users_kind_idx on public.mcp_users (kind);

-- ============================================================
-- Roles + role assignments
-- ============================================================

create table public.mcp_roles (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  -- Permission tags: 'read', 'write:<domain>', 'delete', '*' for all.
  permissions text[] not null default '{}'::text[],
  created_at timestamptz not null default now()
);

insert into public.mcp_roles (name, permissions) values
  ('viewer',  array['read']),
  ('editor',  array['read','write:financial','write:selections','write:budget','write:tasks','write:operations']),
  ('admin',   array['*']),
  ('harness', array['read','write:financial','write:selections','write:tasks']);

create table public.mcp_user_roles (
  user_id uuid not null references public.mcp_users(id) on delete cascade,
  role_id uuid not null references public.mcp_roles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.mcp_users(id) on delete set null,
  primary key (user_id, role_id)
);

-- ============================================================
-- Downstream-SaaS credentials (encrypted)
-- ============================================================
-- One row per (user, service). For BuildTools today; future MCPs use
-- a different `service` value.

create table public.mcp_service_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.mcp_users(id) on delete cascade,
  service text not null,
  -- Format: version(1 byte) || iv(12 bytes) || authTag(16 bytes) || ciphertext
  credentials_encrypted bytea not null,
  encryption_version smallint not null default 1,
  encrypted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, service)
);
create index mcp_service_credentials_user_idx on public.mcp_service_credentials (user_id);

-- ============================================================
-- OAuth 2.1: dynamic clients (RFC 7591)
-- ============================================================

create table public.mcp_oauth_clients (
  client_id text primary key,
  client_name text,
  redirect_uris text[] not null,
  grant_types text[] not null default array['authorization_code','refresh_token'],
  token_endpoint_auth_method text not null default 'none',
  scope text,
  created_at timestamptz not null default now(),
  -- Optional: tie a client to a specific user/host fingerprint for audit
  registered_by_user_id uuid references public.mcp_users(id) on delete set null
);

-- ============================================================
-- OAuth 2.1: authorization codes (short-lived, ~60s)
-- ============================================================

create table public.mcp_oauth_codes (
  -- Store only the SHA-256 hash, never the plaintext code.
  code_hash text primary key,
  user_id uuid not null references public.mcp_users(id) on delete cascade,
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  scope text,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null check (code_challenge_method in ('S256')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index mcp_oauth_codes_expires_idx on public.mcp_oauth_codes (expires_at);

-- ============================================================
-- OAuth 2.1: access + refresh tokens
-- ============================================================

create table public.mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 hash of the bearer string; plaintext never stored.
  token_hash text unique not null,
  kind text not null check (kind in ('access','refresh')),
  user_id uuid not null references public.mcp_users(id) on delete cascade,
  client_id text references public.mcp_oauth_clients(client_id) on delete set null,
  scope text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  -- For refresh tokens: which refresh token was used to mint this one
  -- (for rotation chains). Null on root tokens.
  parent_token_id uuid references public.mcp_oauth_tokens(id) on delete set null
);
create index mcp_oauth_tokens_user_idx on public.mcp_oauth_tokens (user_id);
create index mcp_oauth_tokens_expires_idx on public.mcp_oauth_tokens (expires_at)
  where revoked_at is null;
create index mcp_oauth_tokens_kind_idx on public.mcp_oauth_tokens (kind);

-- ============================================================
-- Service tokens (harness etc.) — long-lived, no expiry by default
-- ============================================================

create table public.mcp_service_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text unique not null,
  user_id uuid not null references public.mcp_users(id) on delete cascade,
  display_name text not null,
  expires_at timestamptz,  -- NULL = never expires (revoke explicitly)
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.mcp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references public.mcp_users(id) on delete set null
);
create index mcp_service_tokens_user_idx on public.mcp_service_tokens (user_id);

-- ============================================================
-- Audit log
-- ============================================================

create table public.mcp_audit_log (
  id bigserial primary key,
  user_id uuid references public.mcp_users(id) on delete set null,
  mcp_server text not null default 'buildtools',
  tool text not null,
  -- Optional: BuildTools project ID for tools that take one
  project_id integer,
  result text not null check (result in ('ok','error','denied','rate_limited')),
  error_message text,
  -- For correlation: which token did this call
  token_id uuid,
  token_kind text check (token_kind in ('oauth-access','service')),
  -- Free-form metadata (e.g., args summary, request id)
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index mcp_audit_log_user_time_idx on public.mcp_audit_log (user_id, created_at desc);
create index mcp_audit_log_time_idx on public.mcp_audit_log (created_at desc);
create index mcp_audit_log_tool_idx on public.mcp_audit_log (tool, created_at desc);

-- ============================================================
-- Rate limit buckets (sliding window, per (user, permission_bucket))
-- ============================================================
-- Bucket names mirror permission categories: 'read', 'write', 'delete'.
-- One row per (user, bucket, window_start). Cleaned up on a sweep.

create table public.mcp_rate_buckets (
  user_id uuid not null references public.mcp_users(id) on delete cascade,
  permission_bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, permission_bucket, window_start)
);
create index mcp_rate_buckets_window_idx on public.mcp_rate_buckets (window_start);

-- ============================================================
-- Row Level Security
-- ============================================================
-- All tables: RLS enabled, NO policies — meaning only the service_role
-- (which bypasses RLS) can access them. We never expose these tables to
-- PostgREST callers using the anon or authenticated roles.

alter table public.mcp_users enable row level security;
alter table public.mcp_roles enable row level security;
alter table public.mcp_user_roles enable row level security;
alter table public.mcp_service_credentials enable row level security;
alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_codes enable row level security;
alter table public.mcp_oauth_tokens enable row level security;
alter table public.mcp_service_tokens enable row level security;
alter table public.mcp_audit_log enable row level security;
alter table public.mcp_rate_buckets enable row level security;

-- ============================================================
-- Helpers
-- ============================================================

-- Touch updated_at on credentials changes.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger mcp_service_credentials_touch
  before update on public.mcp_service_credentials
  for each row
  execute function public.touch_updated_at();
