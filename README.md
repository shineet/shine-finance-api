# shine-finance-api

Plaid backend for the **MyFinance** iOS/macOS app (`~/Documents/Projects/MyFinance`).

Deliberately a separate deployment from `shine-booking`: financial credentials
should not share a project with anything client-facing.

## Why a backend exists

Plaid's secret can mint link tokens and read accounts. Anything shipped inside
an app binary is extractable, so the secret and the per-institution access
tokens live here and never reach the client. The app authenticates to this
backend with a single shared `APP_TOKEN`.

## Endpoints

All require `Authorization: Bearer $APP_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/link-token` | Start a Link session, returns `hosted_link_url` to open in a browser |
| POST | `/api/exchange` | Finish linking: `{ link_token }` -> stores the access token |
| GET | `/api/accounts` | Live balances across all linked institutions |
| POST | `/api/sync` | Pull transaction deltas from Plaid into Supabase |
| GET | `/api/transactions?days=90&limit=500` | Stored transactions, newest first |

`/api/sync` and `/api/transactions` are split on purpose: `/transactions/sync`
is a delta feed, so the durable copy lives in Supabase and the read path stays
fast and keeps working when an institution is down.

## Setup

1. **Database** — run `schema.sql` in the Supabase SQL editor. RLS is on with no
   policies, so only the service key can reach these tables.
2. **Environment variables** — in Vercel, Settings -> Environment Variables:

   | Name | Value |
   |---|---|
   | `PLAID_CLIENT_ID` | from the Plaid dashboard |
   | `PLAID_SECRET` | Sandbox secret to start; swap for Production later |
   | `PLAID_ENV` | `sandbox`, later `production` |
   | `APP_TOKEN` | any long random string; the app sends it as a Bearer token |
   | `SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SECRET_KEY` | Supabase **service role** key |
   | `COMPLETION_REDIRECT_URI` | `myfinance://link-complete` |

3. **Deploy** — push to `main`; Vercel builds automatically.

## Sandbox

With `PLAID_ENV=sandbox`, Link accepts `user_good` / `pass_good` against any
institution and returns fake accounts and transactions. The whole app can be
built and tested before Production access is granted; going live is a
`PLAID_ENV` and `PLAID_SECRET` change, no code change.

## Coverage note

PayPal Credit is a Synchrony product and may link as a separate institution
from PayPal itself, or not be supported. Chase, Amex, BofA and PayPal proper
are well covered.
