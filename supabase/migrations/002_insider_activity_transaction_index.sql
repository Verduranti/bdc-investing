-- ============================================================
-- Fix: insider_activity was deduped on accession_number alone, but a
-- single Form 4 filing routinely reports several transactions (e.g.
-- multiple open-market buys on different dates) all sharing one
-- accession_number. Every upsertInsiderTrades() batch with more than one
-- transaction per filing failed with:
--   "ON CONFLICT DO UPDATE command cannot affect row a second time"
--
-- This went unnoticed until now because fetchInsiderTrades() had a
-- separate bug (fixed alongside this migration, see server/etl/edgar/
-- form4.js) that made it always return zero transactions, so the upsert
-- path never ran against real data before.
--
-- transaction_index (a transaction's position within its filing) pairs
-- with accession_number to give each row a real uniqueness key.
--
-- Already applied directly to the BDC Investing Supabase project via the
-- Supabase MCP apply_migration tool. Checked in here so schema.sql (fresh
-- installs) and this migration (existing installs) agree, matching the
-- pattern in 001_fix_arcc_bxsl_cik_contamination.sql.
-- ============================================================

alter table insider_activity add column if not exists transaction_index integer not null default 0;

alter table insider_activity drop constraint insider_activity_accession_number_key;
alter table insider_activity add constraint insider_activity_accession_transaction_key unique (accession_number, transaction_index);
