-- 001: one backend, many people.
--
-- Run once in the Supabase SQL editor (project "MyFinance") BEFORE deploying
-- the multi-user backend. Safe for the backend that is live now: every new
-- user_id column DEFAULTS to the owner's id, so the current code, which knows
-- nothing about users, keeps writing rows that land on the owner. Migration
-- 002 removes those defaults once the new backend is live.
--
-- Everything is in one transaction: it applies completely or not at all.

begin;

create table if not exists users (
  id                    uuid primary key default gen_random_uuid(),
  apple_sub             text unique,
  email                 text,
  -- The one row that existed before accounts: Shine. APP_TOKEN maps here.
  legacy                boolean not null default false,
  -- Plaid's client_user_id. The owner keeps 'shine'; null means use id.
  plaid_client_user_id  text,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz
);
create unique index if not exists users_one_owner on users (legacy) where legacy;

insert into users (id, legacy, plaid_client_user_id)
values ('00000000-0000-4000-8000-000000000001', true, 'shine')
on conflict (id) do nothing;

-- Only the SHA-256 of each session token is kept.
create table if not exists sessions (
  token_hash    text primary key,
  user_id       uuid not null references users (id) on delete cascade,
  device        text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists sessions_user_idx on sessions (user_id);

-- user_id on every table, existing rows given to the owner by the default.
alter table plaid_items        add column if not exists user_id uuid not null
  default '00000000-0000-4000-8000-000000000001' references users (id) on delete cascade;
alter table plaid_transactions add column if not exists user_id uuid not null
  default '00000000-0000-4000-8000-000000000001' references users (id) on delete cascade;
alter table balance_snapshots  add column if not exists user_id uuid not null
  default '00000000-0000-4000-8000-000000000001' references users (id) on delete cascade;
alter table user_prefs         add column if not exists user_id uuid not null
  default '00000000-0000-4000-8000-000000000001' references users (id) on delete cascade;

create index if not exists plaid_items_user_idx        on plaid_items (user_id);
create index if not exists plaid_transactions_user_date_idx on plaid_transactions (user_id, date desc);
create index if not exists balance_snapshots_user_date_idx  on balance_snapshots (user_id, as_of desc);

-- A setting's name is unique per person, not across everyone.
alter table user_prefs drop constraint if exists user_prefs_pkey;
alter table user_prefs add primary key (user_id, key);

-- Same rule as every other table: RLS on with no policies, so only the
-- backend's service key reaches them.
alter table users    enable row level security;
alter table sessions enable row level security;
grant all on public.users    to service_role;
grant all on public.sessions to service_role;

commit;

-- What you should see afterwards: one owner row, and every existing row his.
select
  (select count(*) from users)                                         as users,
  (select count(*) from plaid_items        where user_id is null)      as items_without_user,
  (select count(*) from plaid_transactions where user_id is null)      as txns_without_user,
  (select count(*) from balance_snapshots  where user_id is null)      as snapshots_without_user,
  (select count(*) from user_prefs         where user_id is null)      as prefs_without_user;
