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
 * `clearFields` is the escape hatch from that rule: an explicit list of
 * column names to set to NULL. Needed because null-stripping makes the ETL
 * unable to ever RETRACT a value it previously wrote — so when a run
 * determines a stored number was sourced wrongly (e.g. a dividend that
 * turned out to belong to a different filing period), a corrected re-run
 * would otherwise leave the bad value, and any alert derived from it, in
 * place permanently. Callers must pass column names, not camelCase keys,
 * and should only clear fields they can positively show are unsourceable —
 * never blanket-clear, or manually entered values get wiped.
 *
 * @param {string} ticker
 * @param {number} filingPeriodId
 * @param {object} metrics
 * @param {string[]} clearFields - column names to explicitly NULL out
 */
export async function upsertPortfolioMetrics(ticker, filingPeriodId, metrics, clearFields = []) {
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

  // Applied after the strip, so these survive it deliberately.
  for (const column of clearFields) row[column] = null;

  check(
    await supabase
      .from('portfolio_metrics')
      .upsert(row, { onConflict: 'bdc_id,filing_period_id' }),
    'upsertPortfolioMetrics'
  );
}

// ── Sector Exposure ────────────────────────────────────────────────────────

/**
 * @param {string[]} clearFields - columns to write as NULL even though the
 *   null-strip below would normally protect them. Same retraction mechanism
 *   as upsertPortfolioMetrics: when the parser can no longer substantiate a
 *   value it previously wrote, the value has to be actively withdrawn.
 *   Writing only when a NEW value is found would preserve the old one
 *   forever, which is how a superseded parser's output outlives it.
 */
export async function upsertSectorExposure(ticker, filingPeriodId, exposure, clearFields = []) {
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

  // Applied after the strip, so these survive it deliberately.
  for (const column of clearFields) row[column] = null;

  check(
    await supabase
      .from('sector_exposure')
      .upsert(row, { onConflict: 'bdc_id,filing_period_id' }),
    'upsertSectorExposure'
  );
}

// ── Valuation Snapshots ────────────────────────────────────────────────────

/**
 * Build the "NAV an investor could actually have known" timeline.
 *
 * Two defensible definitions of a historical discount exist, and they are
 * not the same number:
 *
 *   (a) the NAV of the quarter the date falls in — economically tidy, but
 *       nobody knew it at the time; a 10-Q lands 4-8 weeks after quarter
 *       end. Using it backdates information and makes any z-score or
 *       backtest built on this table look better than reality.
 *   (b) the NAV from the most recent filing FILED on or before that date —
 *       what the market could see. Discount to NAV is a market-perception
 *       measure, so this is the honest one, and it matches what
 *       valuation_snapshots already does for TODAY ("latest reported NAV,
 *       carried forward" in schema.sql).
 *
 * We use (b). Entries are walked in filing order carrying the newest
 * period seen so far, because a single 10-Q reports several NAV facts at
 * once (current quarter plus comparatives) and a late-filed amendment can
 * restate an old period without superseding a newer one.
 *
 * @param {Array<{period, value, filed}>} navHistory
 * @returns {Array<{filed: string, period: string, value: number}>} ascending by filed
 */
function buildNavTimeline(navHistory) {
  // firstFiled, not filed — see the note in xbrl.js extractQuarterly. `filed`
  // is the last filing to mention the period (comparatives), which would
  // delay a NAV by up to a year and mis-date the whole series.
  const filings = (navHistory ?? [])
    .map(n => ({ ...n, filed: n.firstFiled ?? n.filed }))
    .filter(n => n.filed && n.period && n.value != null)
    .sort((a, b) => a.filed.localeCompare(b.filed) || a.period.localeCompare(b.period));

  const timeline = [];
  let period = null, value = null;
  for (const n of filings) {
    if (period === null || n.period > period) { period = n.period; value = n.value; }
    timeline.push({ filed: n.filed, period, value });
  }
  return timeline;
}

/**
 * Write daily price/NAV/discount snapshots for one BDC.
 *
 * `navHistory` is the full quarterly NAV series (from getLatestXBRLMetrics),
 * NOT a single current value. It used to be the latter: the current NAV was
 * stamped onto every row across the whole 3-year window and discount_pct
 * derived from it, so ARCC carried exactly one distinct NAV value across 776
 * trading days and every historical discount answered "what would this have
 * been if NAV had always been today's?". Each run then rewrote the entire
 * window with the newest NAV, so the answer changed every quarter.
 *
 * Rewriting the full window is still fine — and is why there's no
 * skip-existing logic here. Both inputs are now stable: raw closes don't get
 * restated, and NAV-as-known-then can't change retroactively. Re-running
 * converges on the same rows instead of drifting.
 *
 * @param {string} ticker
 * @param {Array<{period, value, filed}>} navHistory
 * @param {Array<{date, close, adjClose, volume}>} priceHistory
 */
export async function upsertValuationSnapshots(ticker, navHistory, priceHistory) {
  const bdc_id = await getBdcId(ticker);

  const timeline = buildNavTimeline(navHistory);
  // Pointer walk needs both sides ascending; don't assume the caller's order.
  const prices = [...priceHistory].sort((a, b) => a.date.localeCompare(b.date));

  let idx = -1;
  let unpriced = 0;
  const rows = prices.map(p => {
    while (idx + 1 < timeline.length && timeline[idx + 1].filed <= p.date) idx++;
    const known = idx >= 0 ? timeline[idx] : null;
    const nav = known?.value ?? null;
    // Dates before this BDC's first available filing get a null NAV rather
    // than a borrowed one — no NAV had been published yet, so no discount
    // existed to report.
    if (nav == null) unpriced++;
    return {
      bdc_id,
      snapshot_date: p.date,
      price:         p.close,
      price_adj:     p.adjClose ?? null,
      nav,
      nav_as_of:     known?.period ?? null,
      discount_pct:  nav ? parseFloat(((p.close - nav) / nav * 100).toFixed(4)) : null,
      volume:        p.volume,
      price_source:  'yahoo',
    };
  });

  if (unpriced > 0) {
    console.warn(`[${ticker}] ${unpriced} snapshot(s) predate the first published NAV — discount left null`);
  }

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
