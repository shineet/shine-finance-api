-- Run once in the Supabase SQL editor.
--
-- Both tables are written and read ONLY by this backend's serverless functions
-- using the service key. RLS is enabled with no policies, so the anon/public
-- key cannot read them even if it leaked -- unlike the booking app, nothing
-- here is ever touched from a browser.

create table if not exists plaid_items (
  item_id           text primary key,
  access_token      text not null,
  institution_name  text,
  cursor            text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists plaid_transactions (
  transaction_id  text primary key,
  account_id      text not null,
  institution     text,
  date            date not null,
  name            text,
  raw_name        text,
  amount          numeric(14,2),
  currency        text default 'USD',
  pending         boolean default false,
  category        text,
  category_label  text,
  channel         text,
  updated_at      timestamptz not null default now()
);

create index if not exists plaid_transactions_date_idx on plaid_transactions (date desc);
create index if not exists plaid_transactions_account_idx on plaid_transactions (account_id);

alter table plaid_items enable row level security;
alter table plaid_transactions enable row level security;

-- The project was created with "Automatically expose new tables" disabled, so
-- new tables get no privileges granted to the Data API roles. RLS still blocks
-- anon/authenticated; service_role bypasses RLS but still needs the grant.
grant all on public.plaid_items to service_role;
grant all on public.plaid_transactions to service_role;

-- Daily balance snapshots. Plaid only ever reports "now", so progress over
-- time has to be recorded as it happens -- there is no way to backfill it
-- later. One row per account per day; re-running on the same day overwrites.
create table if not exists balance_snapshots (
  account_id   text not null,
  as_of        date not null,
  institution  text,
  name         text,
  type         text,
  subtype      text,
  current      numeric(14,2),
  available    numeric(14,2),
  "limit"      numeric(14,2),
  created_at   timestamptz not null default now(),
  primary key (account_id, as_of)
);

create index if not exists balance_snapshots_date_idx on balance_snapshots (as_of desc);

alter table balance_snapshots enable row level security;
grant all on public.balance_snapshots to service_role;
