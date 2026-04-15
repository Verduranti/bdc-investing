# BDC Stress Radar — Setup Guide

## 1. Supabase

1. Create a free project at https://supabase.com
2. In the SQL Editor, run `supabase/schema.sql` then `supabase/seed.sql`
3. Copy your credentials from **Project Settings → API**:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** secret key → `SUPABASE_SERVICE_KEY` (ETL only, never in frontend)
   - **anon** public key → `VITE_SUPABASE_ANON_KEY` (safe for the browser)

## 2. Local .env files

Create two files (both git-ignored):

**`.env.local`** — for Vite frontend dev:
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

**`.env.etl`** — for running ETL locally:
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
EDGAR_EMAIL=your@email.com
```

Run ETL locally: `source .env.etl && npm run etl`

## 3. GitHub Secrets

In your repo: **Settings → Secrets and variables → Actions → New secret**

| Secret name            | Value                          |
|------------------------|--------------------------------|
| `SUPABASE_URL`         | Your Supabase project URL      |
| `SUPABASE_SERVICE_KEY` | service_role key               |
| `EDGAR_EMAIL`          | Your email (EDGAR User-Agent)  |

## 4. GitHub Actions

The workflow runs automatically **weekdays at 6:30 PM ET**.

To run manually: **Actions → BDC Stress Radar ETL → Run workflow**
- Leave tickers blank to run all 5 BDCs
- Enter e.g. `ARCC,FSK` to run specific tickers

## 5. Deploy the frontend

**Vercel (recommended):**
```bash
npx vercel --prod
```
Set environment variables in the Vercel dashboard:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

**Cloudflare Pages:** same process via Pages dashboard.

## 6. Wire the frontend to Supabase

Once you have real data in Supabase, swap the mock data in the React app:

In `src/App.jsx`, replace the static `ENRICHED` constant with a
`useEffect` that fetches from Supabase using `@supabase/supabase-js`
and the anon key. The table joins you'll need:

```sql
select
  b.*,
  pm.*,
  sx.*,
  nts.score, nts.grade, nts.component_scores,
  vs.price, vs.discount_pct
from bdcs b
left join portfolio_metrics pm on pm.bdc_id = b.id
  and pm.filing_period_id = (
    select id from filing_periods
    where bdc_id = b.id order by period_end desc limit 1
  )
left join sector_exposure sx on sx.bdc_id = b.id
  and sx.filing_period_id = pm.filing_period_id
left join nav_trust_scores nts on nts.bdc_id = b.id
  and nts.filing_period_id = pm.filing_period_id
left join valuation_snapshots vs on vs.bdc_id = b.id
  and vs.snapshot_date = (
    select max(snapshot_date) from valuation_snapshots where bdc_id = b.id
  )
where b.is_active = true;
```

## What the ETL can and can't do right now

| Field               | Source      | Status                    |
|---------------------|-------------|---------------------------|
| NAV per share       | XBRL        | ✅ Live from EDGAR         |
| NII per share       | XBRL        | ✅ Live from EDGAR         |
| Dividends           | XBRL        | ✅ Live from EDGAR         |
| Stock price/volume  | Yahoo       | ✅ Live (3yr history)      |
| Insider trades      | Form 4 XML  | ✅ Live from EDGAR         |
| Non-accrual %       | SOI parse   | ⚠ Partial — needs tuning  |
| PIK income %        | SOI parse   | ⚠ Partial — needs tuning  |
| Sector exposure     | SOI parse   | ⚠ Partial — needs tuning  |
| QoQ markdown        | SOI parse   | ⚠ Partial — needs tuning  |

The schedule-of-investments parser in `server/etl/edgar/scheduleParser.js`
is a generic first pass. Expect to add per-BDC logic as you review the
actual filing HTML for each ticker.
