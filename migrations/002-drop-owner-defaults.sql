-- 002: run AFTER the multi-user backend is deployed and verified.
--
-- 001 defaulted user_id to the owner so the old backend kept working during
-- the switch. Left in place, that default would quietly file any row written
-- without a user_id under the owner: another person's transactions in Shine's
-- dashboard. Without it, such a write fails loudly instead.

alter table plaid_items        alter column user_id drop default;
alter table plaid_transactions alter column user_id drop default;
alter table balance_snapshots  alter column user_id drop default;
alter table user_prefs         alter column user_id drop default;
