-- 003: subscriptions. Run in the Supabase SQL editor (project "MyFinance")
-- BEFORE deploying the backend that reads these columns: lib/auth.js selects
-- them for every request, so deploying first would fail every sign-in check.
--
-- What Apple last confirmed about each person's subscription. Written only by
-- POST /api/account { op: 'subscription' } after the transaction's signature
-- checks out against Apple's root certificate (lib/entitlement.js).

alter table users add column if not exists sub_expires_at   timestamptz;
alter table users add column if not exists sub_product      text;
alter table users add column if not exists sub_environment  text;
-- One App Store subscription unlocks one MyFinance account, so a purchase
-- cannot be passed around between accounts.
alter table users add column if not exists sub_original_txn text unique;

select count(*) as users, count(sub_expires_at) as subscribed from users;
