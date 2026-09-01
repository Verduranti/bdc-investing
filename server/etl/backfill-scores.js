/**
 * One-off backfill for nav_trust_scores.
 *
 * scoreSectorConcentration() used to return raw=100 ("Well-diversified")
 * whenever sector_exposure had no data for a BDC — every other component
 * scorer (non-accrual, PIK, markdown, realized losses, dividend coverage)
 * returns a neutral raw=50 "Data not yet available" instead. Since
 * sector_exposure has never had a single populated row for any BDC (the
 * SOI-table reconciliation gate in scheduleParser.js has never passed),
 * every score ever written carried a silent +7.5 point inflation
 * (0.15 weight * (100-50)) from a component with zero real data behind it.
 *
 * The scorer is now fixed (see scoring.js). This recomputes every existing
 * nav_trust_scores row from its underlying portfolio_metrics/sector_exposure
 * so history reflects the corrected component instead of waiting for each
 * BDC's next filing to cycle through the nightly ETL.
 *
 * Usage:
 *   node server/etl/backfill-scores.js
 *
 * Needs the same SUPABASE_URL / SUPABASE_SERVICE_KEY as the main ETL.
 */

import { supabase } from './db/client.js';
import { upsertNavTrustScore } from './db/upsert.js';
import { computeNavTrustScore } from './scoring.js';

async function run() {
  const { data: rows, error } = await supabase
    .from('nav_trust_scores')
    .select('bdc_id, filing_period_id, score, bdcs(ticker)');
  if (error) throw error;

  console.log(`Recomputing ${rows.length} nav_trust_scores rows...`);

  let changed = 0;
  for (const row of rows) {
    const ticker = row.bdcs.ticker;

    const [{ data: pm }, { data: sx }] = await Promise.all([
      supabase.from('portfolio_metrics').select('*').eq('filing_period_id', row.filing_period_id).maybeSingle(),
      supabase.from('sector_exposure').select('*').eq('filing_period_id', row.filing_period_id).maybeSingle(),
    ]);

    const result = computeNavTrustScore(pm ?? {}, sx ?? {});
    if (result.score !== row.score) {
      changed++;
      console.log(`[${ticker}] filing_period ${row.filing_period_id}: ${row.score} -> ${result.score}`);
    }
    await upsertNavTrustScore(ticker, row.filing_period_id, result);
  }

  console.log(`Done. ${changed}/${rows.length} scores changed.`);
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
