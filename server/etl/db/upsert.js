/**
 * Supabase Upsert Layer
 *
 * All writes to the database go through here. Uses upsert (insert or update
 * on conflict) so the ETL is idempotent — safe to re-run without duplicating.
 *
 * Each function takes enriched data from the ETL pipeline and maps it to
 * the canonical schema. Keep transformation logic out of this file — it
 * should just be a thin mapping + upsert wrapper.
 */

import { supabase } from './client.js';

/** Throw if Supabase returned an error. */
function check(result, context) {
  if (result.error) throw new Error(`Supabase error [${context}]: ${result.error.message}`);
  return result.data;
}

// ── BDC seed + lookup ──────────────────────────────────────────────────────

/**
 * Upsert all known BDCs into the bdcs table.
 * Called once at ETL startup so the pipeline is self-seeding — no manual
 * SQL seed step required. Safe to call on every run (conflict = do nothing).
 *
 * @param {Array<{ticker, cik, name, fiscalYearEnd}>} bdcUniverse
 */
export async function ensureBdcsSeeded(bdcUniverse) {
  const rows = bdcUniverse.map(b => ({
    ticker:          b.ticker,
    name:            b.name,
    cik:             b.cik,
    fiscal_year_end: b.fiscalYearEnd ?? null,
    is_active:       true,
  }));

  const result = await supabase
    .from('bdcs')
    .upsert(rows, { onConflict: 'ticker', ignoreDuplicates: true });

  check(result, 'ensureBdcsSeeded');
  console.log(`[db] BDCs seeded/verified: ${rows.map(r => r.ticker).join(', ')}`);
}

/** Get internal BDC id by ticker. Cached in process memory. */
const _bdcIdCache = {};
export async function getBdcId(ticker) {
  if (_bdcIdCache[ticker]) return _bdcIdCache[ticker];
  const { data, error } = await supabase
    .from('bdcs')
    .select('id')
    .eq('ticker', ticker)
    .single();
  if (error || !data) throw new Error(`BDC not found in DB: ${ticker}`);
  _bdcIdCache[ticker] = data.id;
  return data.id;
}

// ── Filing Periods ─────────────────────────────────────────────────────────

/**
 * Upsert a filing period record. Returns the filing period id.
 *
 * @param {string} ticker
 * @param {{ accessionNumber, filingDate, form, reportDate, docUrl }} filing
 * @returns {Promise<number>} filing_period id
 */
export async function upsertFilingPeriod(ticker, filing) {
  const bdc_id = await getBdcId(ticker);

  const row = {
    bdc_id,
    period_end:       filing.reportDate ?? filing.filingDate,
    form_type:        filing.form,
    accession_number: filing.accessionNumber,
    filed_at:         filing.filingDate,
    document_url:     filing.docUrl ?? null,
  };

  const result = await supabase
    .from('filing_periods')
    .upsert(row, { onConflict: 'accession_number' })
    .select('id')
    .single();

  check(result, 'upsertFilingPeriod');
  return result.data.id;
}

// ── Portfolio Metrics ──────────────────────────────────────────────────────

/**
 * Upsert portfolio metrics for a BDC + filing period.
 * Only writes fields that are non-null — preserves manually entered values.
 *
 * @param {string} ticker
 * @param {number} filingPeriodId
 * @param {object} metrics
 */
export async function upsertPortfolioMetrics(ticker, filingPeriodId, metrics) {
  const bdc_id = await getBdcId(ticker);

  // Strip null/undefined fields so we don't overwrite good data with nulls
  const row = Object.fromEntries(
    Object.entries({
      bdc_id,
      filing_period_id:             filingPeriodId,
      non_accrual_cost_pct:         metrics.nonAccrualCostPct         ?? null,
      non_accrual_fv_pct:           metrics.nonAccrualFVPct           ?? null,
      pik_income_pct:               metrics.pikIncomePct              ?? null,
      pik_income_prior_pct:         metrics.pikIncomePriorPct         ?? null,
      qoq_markdown_pct:             metrics.qoqMarkdownPct            ?? null,
      trailing_realized_losses_pct: metrics.trailingRealizedLossesPct ?? null,
      nii_per_share:                metrics.niiPerShare               ?? null,
      dividend_per_share:           metrics.dividendPerShare          ?? null,
      dividend_coverage:            metrics.dividendCoverage          ?? null,
      data_source:                  metrics.dataSource                ?? 'etl',
      raw_xbrl:                     metrics.rawXbrl                   ?? null,
    }).filter(([, v]) => v !== null)
  );

  check(
    await supabase
      .from('portfolio_metrics')
      .upsert(row, { onConflict: 'bdc_id,filing_period_id' }),
    'upsertPortfolioMetrics'
  );
}

// ── Sector Exposure ────────────────────────────────────────────────────────

export async function upsertSectorExposure(ticker, filingPeriodId, exposure) {
  const bdc_id = await getBdcId(ticker);

  const row = Object.fromEntries(
    Object.entries({
      bdc_id,
      filing_period_id: filingPeriodId,
      software_pct:     exposure.softwarePct     ?? null,
      healthcare_pct:   exposure.healthcarePct   ?? null,
      consumer_pct:     exposure.consumerPct      ?? null,
      industrial_pct:   exposure.industrialPct   ?? null,
      asset_backed_pct: exposure.assetBackedPct  ?? null,
      financial_pct:    exposure.financialPct     ?? null,
      other_pct:        exposure.otherPct         ?? null,
      top_10_holdings_pct: exposure.top10HoldingsPct ?? null,
      data_source:      exposure.dataSource       ?? 'etl',
    }).filter(([, v]) => v !== null)
  );

  check(
    await supabase
      .from('sector_exposure')
      .upsert(row, { onConflict: 'bdc_id,filing_period_id' }),
    'upsertSectorExposure'
  );
}

// ── Valuation Snapshots ────────────────────────────────────────────────────

/**
 * Bulk upsert daily price snapshots.
 * Joins with the latest NAV from portfolio_metrics to compute discount.
 *
 * @param {string} ticker
 * @param {number} latestNav - most recently reported NAV per share
 * @param {Array<{date, close, volume}>} priceHistory
 */
export async function upsertValuationSnapshots(ticker, latestNav, priceHistory) {
  const bdc_id = await getBdcId(ticker);

  const rows = priceHistory.map(p => ({
    bdc_id,
    snapshot_date: p.date,
    price:         p.close,
    nav:           latestNav,
    discount_pct:  latestNav ? parseFloat(((p.close - latestNav) / latestNav * 100).toFixed(4)) : null,
    volume:        p.volume,
    price_source:  'yahoo',
  }));

  // Batch in chunks of 500 to avoid request size limits
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    check(
      await supabase
        .from('valuation_snapshots')
        .upsert(chunk, { onConflict: 'bdc_id,snapshot_date' }),
      `upsertValuationSnapshots chunk ${i}`
    );
  }
}

// ── Insider Activity ───────────────────────────────────────────────────────

export async function upsertInsiderTrades(ticker, trades) {
  if (!trades.length) return;
  const bdc_id = await getBdcId(ticker);

  const rows = trades.map(t => ({
    bdc_id,
    accession_number: t.accession_number,
    transaction_date: t.transaction_date,
    filed_at:         t.filed_at,
    trade_type:       t.trade_type,
    shares:           t.shares,
    price_per_share:  t.price_per_share,
    insider_name:     t.insider_name,
    insider_title:    t.insider_title,
    is_direct:        t.is_direct,
    raw_xml:          t.raw_xml ?? null,
  }));

  check(
    await supabase
      .from('insider_activity')
      .upsert(rows, { onConflict: 'accession_number' }),
    'upsertInsiderTrades'
  );
}

// ── NAV Trust Scores ───────────────────────────────────────────────────────

export async function upsertNavTrustScore(ticker, filingPeriodId, scoreResult) {
  const bdc_id = await getBdcId(ticker);

  check(
    await supabase
      .from('nav_trust_scores')
      .upsert({
        bdc_id,
        filing_period_id: filingPeriodId,
        computed_at:      new Date().toISOString(),
        score:            scoreResult.score,
        grade:            scoreResult.grade,
        component_scores: scoreResult.components,
      }, { onConflict: 'bdc_id,filing_period_id' }),
    'upsertNavTrustScore'
  );
}

// ── Alerts ─────────────────────────────────────────────────────────────────

/**
 * Sync alerts for a BDC:
 *   - Resolve previously active alerts that no longer apply
 *   - Insert newly triggered alerts
 */
export async function syncAlerts(ticker, activeAlerts) {
  const bdc_id = await getBdcId(ticker);

  // Resolve all currently active alerts for this BDC
  await supabase
    .from('alerts')
    .update({ is_active: false, resolved_at: new Date().toISOString() })
    .eq('bdc_id', bdc_id)
    .eq('is_active', true);

  if (!activeAlerts.length) return;

  const rows = activeAlerts.map(a => ({
    bdc_id,
    alert_type:   a.type,
    severity:     a.severity,
    label:        a.label,
    detail:       a.detail ?? null,
    triggered_at: new Date().toISOString(),
    is_active:    true,
  }));

  check(
    await supabase.from('alerts').insert(rows),
    'syncAlerts'
  );
}

// ── ETL Run Log ────────────────────────────────────────────────────────────

export async function logEtlRun(status, tickers, steps, error, durationMs) {
  await supabase.from('etl_runs').insert({
    status,
    tickers,
    steps,
    error:       error ?? null,
    duration_ms: durationMs,
  });
}
