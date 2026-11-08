-- 004: the Sign in with Apple refresh token, so deleting an account can revoke
-- it (lib/apple.js). Sealed with TOKEN_KEY like the Plaid tokens; never sent
-- to the app, never selected with the user on ordinary requests.
--
-- Run in the Supabase SQL editor (project "MyFinance"). Safe before or after
-- the deploy: until it exists, sign-in logs that the token was not kept.

alter table users add column if not exists apple_refresh_token text;

select count(*) as users, count(apple_refresh_token) as with_apple_grant from users;
