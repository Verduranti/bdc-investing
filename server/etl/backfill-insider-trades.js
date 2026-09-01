/**
 * One-off backfill for insider_activity.
 *
 * Two bugs, now both fixed, meant this table has been empty for every BDC
 * since go-live:
 *
 *   1. fetchInsiderTrades() was fetching the XSLT human-viewer page for
 *      each Form 4 instead of the raw XML (see form4.js), so it always
 *      parsed zero transactions.
 *   2. Once (1) was fixed and real transactions started flowing,
 *      upsertInsiderTrades() failed on every filing with >1 transaction —
 *      accession_number alone was the unique/conflict key, but a single
 *      Form 4 commonly reports several transactions under one accession
 *      number (see the insider_activity_transaction_index migration).
 *
 * The main ETL run that surfaced bug (2) already fetched and parsed every
 * BDC's recent filings, XBRL metrics, and prices successfully — only the
 * Form 4 write failed. This just re-runs the Form 4 fetch/upsert step so
 * that doesn't have to be repeated.
 *
 * Usage:
 *   node server/etl/backfill-insider-trades.js
 *
 * Needs the same SUPABASE_URL / SUPABASE_SERVICE_KEY as the main ETL.
 */

import { BDC_UNIVERSE } from './constants.js';
import { fetchInsiderTrades } from './edgar/form4.js';
import { upsertInsiderTrades } from './db/upsert.js';

const MAX_FORM4_PER_BDC = 20;

async function run() {
  let totalTrades = 0;
  let failures = 0;

  for (const { ticker, cik } of BDC_UNIVERSE) {
    try {
      const trades = await fetchInsiderTrades(cik, MAX_FORM4_PER_BDC);
      await upsertInsiderTrades(ticker, trades);
      totalTrades += trades.length;
      console.log(`[${ticker}] ${trades.length} trades`);
    } catch (err) {
      failures++;
      console.warn(`[${ticker}] failed: ${err.message}`);
    }
  }

  console.log(`\nDone. ${totalTrades} trades written across ${BDC_UNIVERSE.length} BDCs (${failures} failures).`);
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
