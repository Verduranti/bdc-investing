/**
 * One-off backfill for valuation_snapshots.
 *
 * The nightly ETL rewrites the trailing PRICE_LOOKBACK_DAYS window on every
 * run, so it repairs recent history by itself. Two things it can't do:
 *
 *   1. Rows older than that window are never revisited. Everything written
 *      before the price/NAV fix is wrong there permanently — adjusted closes
 *      standing in for traded prices, and today's NAV stamped on every row.
 *   2. A normal run won't reach back past its own lookback to fix them.
 *
 * This script does the same work over a WIDER window so those frozen rows
 * get corrected once. After it has run, the nightly ETL keeps things right
 * on its own: raw closes and NAV-as-known-then are both stable, so rows
 * stop drifting as soon as they're written correctly.
 *
 * Usage:
 *   node server/etl/backfill-valuations.js                 # all BDCs, 4yr
 *   node server/etl/backfill-valuations.js ARCC CION       # specific tickers
 *   node server/etl/backfill-valuations.js --days=1825     # custom lookback
 *
 * Needs the same SUPABASE_URL / SUPABASE_SERVICE_KEY as the main ETL.
 */

import { BDC_UNIVERSE } from './constants.js';
import { getLatestXBRLMetrics } from './edgar/xbrl.js';
import { fetchPriceHistory } from './market/prices.js';
import { upsertValuationSnapshots } from './db/upsert.js';

// Wider than the ETL's 3-year window so it covers rows the nightly run has
// already stopped touching. Cheap: Yahoo returns the whole range in one call.
const DEFAULT_DAYS = 365 * 4;

async function run() {
  const args    = process.argv.slice(2);
  const daysArg = args.find(a => a.startsWith('--days='));
  const days    = daysArg ? parseInt(daysArg.split('=')[1], 10) : DEFAULT_DAYS;
  const tickers = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());

  const universe = tickers.length > 0
    ? BDC_UNIVERSE.filter(b => tickers.includes(b.ticker))
    : BDC_UNIVERSE;

  if (universe.length === 0) {
    console.error('No matching BDCs found. Check ticker names.');
    process.exit(1);
  }

  console.log(`Backfilling valuation snapshots: ${universe.length} BDC(s), ${days}-day lookback\n`);

  let ok = 0, failed = 0, rows = 0;
  for (const bdc of universe) {
    try {
      // periodEnd null: we want the whole NAV series here, not one period's
      // facts, and the snapshot join does its own as-of-date selection.
      const { navHistory } = await getLatestXBRLMetrics(bdc.cik, null);
      const prices = await fetchPriceHistory(bdc.ticker, days);

      if (!prices.length || !navHistory?.length) {
        console.warn(`[${bdc.ticker}] skipped: prices=${prices.length} navQuarters=${navHistory?.length ?? 0}`);
        failed++;
        continue;
      }

      await upsertValuationSnapshots(bdc.ticker, navHistory, prices);
      rows += prices.length;
      ok++;
      console.log(`[${bdc.ticker}] ${prices.length} rows (${navHistory.length} NAV quarters, ${prices[0].date} → ${prices[prices.length - 1].date})`);
    } catch (err) {
      console.error(`[${bdc.ticker}] FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${ok} succeeded, ${failed} skipped/failed, ${rows} rows written.`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Backfill crashed:', err);
  process.exit(1);
});
