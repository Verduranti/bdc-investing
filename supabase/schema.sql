-- ============================================================
-- BDC Stress Radar — Supabase Schema
-- Run this in the Supabase SQL editor to initialize the DB.
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS + DO blocks.
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── 1. BDC Universe ──────────────────────────────────────────
-- One row per tracked BDC. Stable reference table.
create table if not exists bdcs (
  id            serial primary key,
  ticker        text not null unique,
  name          text not null,
  manager       text,
  cik           text not null unique,   -- SEC CIK, zero-padded to 10 digits
  fiscal_year_end text,                 -- 'December', 'September', etc.
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── 2. Filing Periods ─────────────────────────────────────────
-- One row per 10-Q / 10-K filing discovered on EDGAR.
create table if not exists filing_periods (
  id                serial primary key,
  bdc_id            integer not null references bdcs(id) on delete cascade,
  period_end        date not null,              -- e.g. 2024-09-30
  form_type         text not null,              -- '10-Q' | '10-K'
  accession_number  text not null unique,       -- e.g. 0001278752-24-000041
  filed_at          date,
  document_url      text,                        -- primary doc URL on EDGAR
  is_processed      boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (bdc_id, period_end, form_type)
);

-- ── 3. Portfolio Metrics ──────────────────────────────────────
-- Asset quality metrics extracted per filing period.
-- data_source: 'xbrl' | 'parsed' | 'manual'
-- Coverage here tracks WHERE the data came from so we know
-- what to trust and what needs a manual review pass.
create table if not exists portfolio_metrics (
  id                          serial primary key,
  bdc_id                      integer not null references bdcs(id) on delete cascade,
  filing_period_id            integer not null references filing_periods(id) on delete cascade,

  -- Asset quality
  non_accrual_cost_pct        numeric(6,3),     -- % of portfolio at cost
  non_accrual_fv_pct          numeric(6,3),     -- % at fair value
  pik_income_pct              numeric(6,3),     -- PIK as % of total investment income
  pik_income_prior_pct        numeric(6,3),     -- prior quarter (for delta)
  qoq_markdown_pct            numeric(7,4),     -- negative = net markdown
  trailing_realized_losses_pct numeric(6,3),

  -- Income
  nii_per_share               numeric(8,4),
  dividend_per_share          numeric(8,4),
  dividend_coverage           numeric(6,4),     -- NII / dividend

  -- Provenance
  data_source                 text not null default 'manual',
  raw_xbrl                    jsonb,            -- raw XBRL facts blob for debugging

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (bdc_id, filing_period_id)
);

-- ── 4. Sector Exposure ────────────────────────────────────────
-- Portfolio sector breakdown per filing period.
-- Parsed from Schedule of Investments; may be null if not yet extracted.
create table if not exists sector_exposure (
  id                  serial primary key,
  bdc_id              integer not null references bdcs(id) on delete cascade,
  filing_period_id    integer not null references filing_periods(id) on delete cascade,

  software_pct        numeric(6,3),
  healthcare_pct      numeric(6,3),
  consumer_pct        numeric(6,3),
  industrial_pct      numeric(6,3),
  asset_backed_pct    numeric(6,3),
  financial_pct       numeric(6,3),
  other_pct           numeric(6,3),
  top_10_holdings_pct numeric(6,3),

  data_source         text not null default 'parsed',
  created_at          timestamptz not null default now(),
  unique (bdc_id, filing_period_id)
);

-- ── 5. Valuation Snapshots ────────────────────────────────────
-- Daily price + NAV + derived discount. Price from market data;
-- NAV from most recent filing (held constant between quarters).
create table if not exists valuation_snapshots (
  id              bigserial primary key,
  bdc_id          integer not null references bdcs(id) on delete cascade,
  snapshot_date   date not null,
  price           numeric(10,4),
  nav             numeric(10,4),    -- latest reported NAV, carried forward
  discount_pct    numeric(8,4),     -- (price - nav) / nav * 100
  volume          bigint,
  price_source    text,             -- 'yahoo' | 'polygon' | 'manual'
  created_at      timestamptz not null default now(),
  unique (bdc_id, snapshot_date)
);

-- Index for time-range queries (z-score window, chart history)
create index if not exists idx_valuation_bdc_date
  on valuation_snapshots (bdc_id, snapshot_date desc);

-- ── 6. Insider Activity ───────────────────────────────────────
-- Form 4 trades. Deduped on accession number.
create table if not exists insider_activity (
  id                  serial primary key,
  bdc_id              integer not null references bdcs(id) on delete cascade,
  accession_number    text not null unique,
  transaction_date    date,
  filed_at            date,
  trade_type          text,         -- 'buy' | 'sell'
  shares              integer,
  price_per_share     numeric(10,4),
  insider_name        text,
  insider_title       text,
  is_direct           boolean,      -- direct ownership vs. indirect
  raw_xml             text,         -- original Form 4 XML for reprocessing
  created_at          timestamptz not null default now()
);

create index if not exists idx_insider_bdc_date
  on insider_activity (bdc_id, transaction_date desc);

-- ── 7. NAV Trust Scores ───────────────────────────────────────
-- Computed score per BDC per filing period. Recomputed whenever
-- portfolio_metrics or sector_exposure changes.
create table if not exists nav_trust_scores (
  id                serial primary key,
  bdc_id            integer not null references bdcs(id) on delete cascade,
  filing_period_id  integer not null references filing_periods(id) on delete cascade,
  computed_at       timestamptz not null default now(),
  score             smallint not null check (score between 0 and 100),
  grade             text not null,
  component_scores  jsonb not null,   -- full breakdown: { key, label, weight, raw, display, qualLabel }
  unique (bdc_id, filing_period_id)
);

-- ── 8. Alerts ─────────────────────────────────────────────────
-- Active alerts. Resolved when condition no longer holds.
create table if not exists alerts (
  id            bigserial primary key,
  bdc_id        integer not null references bdcs(id) on delete cascade,
  alert_type    text not null,    -- 'pik_spike' | 'uncovered_dividend' | 'discount_widening' | etc.
  severity      text not null,    -- 'high' | 'medium' | 'info'
  label         text not null,
  detail        text,
  triggered_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  is_active     boolean not null default true
);

create index if not exists idx_alerts_bdc_active
  on alerts (bdc_id, is_active, triggered_at desc);

-- ── 9. ETL Run Log ───────────────────────────────────────────
-- Tracks each ETL run for debugging and audit.
create table if not exists etl_runs (
  id            bigserial primary key,
  run_at        timestamptz not null default now(),
  status        text not null,          -- 'success' | 'partial' | 'failed'
  tickers       text[],                 -- which BDCs were processed
  steps         jsonb,                  -- per-step results
  error         text,
  duration_ms   integer
);

-- ── Row-level security (optional, for future sharing) ─────────
-- Enable RLS on all tables. With service_role key (used by ETL),
-- RLS is bypassed. With anon key (used by frontend), read-only.
alter table bdcs               enable row level security;
alter table filing_periods     enable row level security;
alter table portfolio_metrics  enable row level security;
alter table sector_exposure    enable row level security;
alter table valuation_snapshots enable row level security;
alter table insider_activity   enable row level security;
alter table nav_trust_scores   enable row level security;
alter table alerts             enable row level security;
alter table etl_runs           enable row level security;

-- Allow anonymous read on all tables (personal use — adjust if sharing)
do $$ declare
  t text;
begin
  foreach t in array array[
    'bdcs','filing_periods','portfolio_metrics','sector_exposure',
    'valuation_snapshots','insider_activity','nav_trust_scores',
    'alerts','etl_runs'
  ]
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename   = t
        and policyname  = 'anon_read_' || t
    ) then
      execute format(
        'create policy "anon_read_%s" on %I for select to anon using (true)',
        t, t
      );
    end if;
  end loop;
end $$;
