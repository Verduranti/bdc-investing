/**
 * BDC Stress Radar — ETL Runner
 *
 * Orchestrates the full data pipeline for each BDC:
 *   1. Fetch filing history from EDGAR submissions API
 *   2. Upsert new filing period records
 *   3. Fetch XBRL structured metrics (NAV, NII, dividends)
 *   4. Parse Schedule of Investments HTML (non-accruals, PIK, sectors)
 *   5. Fetch Form 4 insider trades
 *   6. Fetch daily price history from Yahoo Finance
 *   7. Compute NAV Trust Scores and alerts
 *   8. Write everything to Supabase
 *   9. Log the run
 *
 * Designed to be idempotent — safe to re-run without creating duplicates.
 *
 * Usage:
 *   node server/etl/index.js              # run all BDCs
 *   node server/etl/index.js ARCC FSK    # run specific tickers
 */

import { BDC_UNIVERSE } from './constants.js';
import { getRecentFilings, fetchFilingDocument } from './edgar/submissions.js';
import { fetchXBRLMetrics, getLatestXBRLMetrics } from './edgar/xbrl.js';
import { fetchInsiderTrades } from './edgar/form4.js';
import { parseScheduleOfInvestments } from './edgar/scheduleParser.js';
import { fetchAllPrices } from './market/prices.js';
import {
  ensureBdcsSeeded, getBdcId, upsertFilingPeriod, upsertPortfolioMetrics,
  upsertSectorExposure, upsertValuationSnapshots,
  upsertInsiderTrades, upsertNavTrustScore, syncAlerts, logEtlRun,
} from './db/upsert.js';
import { computeNavTrustScore, generateAlerts } from './scoring.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_FILINGS_PER_BDC  = 4;   // how many recent 10-Q/10-K to check per run
const MAX_FORM4_PER_BDC    = 20;  // how many Form 4s to fetch per run
const PRICE_LOOKBACK_DAYS  = 365 * 3; // 3-year history for z-score

// ─── Per-BDC pipeline ────────────────────────────────────────────────────────

async function processBDC(bdc, priceData) {
  const { ticker, cik } = bdc;
  const stepResults = {};
  console.log(`\n[${ticker}] Starting pipeline...`);

  // ── Step 1: Filing history ────────────────────────────────────────
  console.log(`[${ticker}] Fetching recent filings...`);
  const filings = await getRecentFilings(cik, ['10-Q', '10-K'], MAX_FILINGS_PER_BDC);
  stepResults.filings = filings.length;

  if (filings.length === 0) {
    console.warn(`[${ticker}] No filings found — skipping`);
    return { ticker, status: 'skipped', steps: stepResults };
  }

  const latestFiling = filings[0];
  const filingPeriodId = await upsertFilingPeriod(ticker, latestFiling);
  stepResults.filingPeriodId = filingPeriodId;
  console.log(`[${ticker}] Latest filing: ${latestFiling.form} ${latestFiling.reportDate} (period id ${filingPeriodId})`);

  // ── Step 2: XBRL structured metrics ──────────────────────────────
  console.log(`[${ticker}] Fetching XBRL metrics...`);
  let xbrlMetrics = {};
  try {
    const raw = await getLatestXBRLMetrics(cik);

    // Sanity bound on per-share dollar figures. Found in production that
    // TPVG's OWN filed XBRL tags a per-share dividend as "360" for some
    // comparative periods (should be $3.60 or $0.36 — the filer's own
    // scale/decimals attribute is inconsistent across their historical
    // filings, confirmed directly against the SEC companyconcept API, so
    // this isn't a bug in our parsing). No real BDC pays anywhere near
    // $20/share in a single quarter, so treat anything past that as a
    // filer-side tagging error rather than compute a coverage ratio from
    // a distorted number — a wrong number here is worse than no number.
    const MAX_PLAUSIBLE_PER_SHARE = 20;
    const safeNii = (raw.nii != null && Math.abs(raw.nii) <= MAX_PLAUSIBLE_PER_SHARE) ? raw.nii : null;
    const safeDividend = (raw.dividend != null && Math.abs(raw.dividend) <= MAX_PLAUSIBLE_PER_SHARE) ? raw.dividend : null;
    if (raw.nii != null && safeNii == null) console.warn(`[${ticker}] XBRL NII per share ($${raw.nii}) exceeds plausible bound — treating as filer tagging error, dropped`);
    if (raw.dividend != null && safeDividend == null) console.warn(`[${ticker}] XBRL dividend per share ($${raw.dividend}) exceeds plausible bound — treating as filer tagging error, dropped`);

    xbrlMetrics = {
      niiPerShare:     safeNii,
      dividendPerShare: safeDividend,
      // Compute coverage if both available
      dividendCoverage: (safeNii != null && safeDividend != null && safeDividend > 0)
        ? parseFloat((safeNii / safeDividend).toFixed(4))
        : null,
      // Reliable, unambiguous total portfolio FV — confirmed via direct
      // companyconcept API check to return one clean value per period
      // (no dimensional segment pollution). Used as the denominator for
      // markdown/realized-loss % in Step 3, replacing the old SOI-table
      // column-sum approach which was silently summing the wrong column
      // on real filings (see notes in constants.js).
      totalInvestmentsFairValue: raw.totalInvestmentsFairValue,
      dataSource: 'xbrl',
      rawXbrl: raw,
    };
    stepResults.xbrl = { nav: raw.nav, nii: raw.nii, dividend: raw.dividend };

    // Use XBRL NAV if available — this is the primary NAV source
    if (raw.nav != null) xbrlMetrics.latestNav = raw.nav;

    console.log(`[${ticker}] XBRL: NAV=${raw.nav} NII=${raw.nii} Div=${raw.dividend}`);
  } catch (err) {
    console.warn(`[${ticker}] XBRL fetch failed: ${err.message}`);
    stepResults.xbrlError = err.message;
  }

  // Upsert what we have from XBRL
  await upsertPortfolioMetrics(ticker, filingPeriodId, xbrlMetrics);

  // ── Step 3: Schedule of Investments parsing ───────────────────────
  // Only parse if the filing hasn't been processed yet.
  // This is the slow/fragile step — skip it if XBRL covered the gaps.
  console.log(`[${ticker}] Parsing Schedule of Investments...`);
  try {
    const html = await fetchFilingDocument(latestFiling.docUrl);
    const { portfolioMetrics: parsed, sectorExposure, notes } = parseScheduleOfInvestments(
      html, ticker, xbrlMetrics.totalInvestmentsFairValue,
    );

    if (Object.keys(parsed).length > 0) {
      // parseScheduleOfInvestments returns snake_case keys matching the DB
      // columns directly (non_accrual_fv_pct, etc.), but upsertPortfolioMetrics
      // expects camelCase (nonAccrualFVPct, etc. — matching the XBRL step's
      // convention). Without this remapping every field here silently
      // evaluated to `undefined ?? null` inside the upsert, discarding real
      // extracted non-accrual/PIK values even when parsing succeeded. The
      // sectorExposure branch just below already does the equivalent
      // remapping correctly — this mirrors that.
      //
      // niiPerShare/dividendCoverage are a special case: this text-based
      // extraction is a *fallback* for filers whose XBRL doesn't tag NII
      // (see xbrl.js). If Step 2 already got a real value from XBRL, we
      // must NOT let a less-reliable text-regex match overwrite it on a
      // later run — upsertPortfolioMetrics writes whatever non-null fields
      // it's given, it doesn't know which source "wins", so that has to be
      // decided here before the call.
      const xbrlHasNii = xbrlMetrics.niiPerShare != null;
      const textNii = parsed.nii_per_share_text;
      const niiToWrite = (!xbrlHasNii && textNii != null) ? textNii : null;
      const dividendCoverageToWrite = (niiToWrite != null && xbrlMetrics.dividendPerShare != null && xbrlMetrics.dividendPerShare > 0)
        ? parseFloat((niiToWrite / xbrlMetrics.dividendPerShare).toFixed(4))
        : null;

      await upsertPortfolioMetrics(ticker, filingPeriodId, {
        nonAccrualCostPct:         parsed.non_accrual_cost_pct,
        nonAccrualFVPct:           parsed.non_accrual_fv_pct,
        pikIncomePct:              parsed.pik_income_pct,
        qoqMarkdownPct:            parsed.qoq_markdown_pct,
        trailingRealizedLossesPct: parsed.trailing_realized_losses_pct,
        niiPerShare:               niiToWrite,
        dividendCoverage:          dividendCoverageToWrite,
        dataSource:                parsed.data_source,
      });
      stepResults.scheduleParser = { fields: Object.keys(parsed), notes, niiFromText: niiToWrite != null };
    }
    if (Object.keys(sectorExposure).length > 0) {
      await upsertSectorExposure(ticker, filingPeriodId, {
        softwarePct:    sectorExposure.software_pct,
        healthcarePct:  sectorExposure.healthcare_pct,
        consumerPct:    sectorExposure.consumer_pct,
        industrialPct:  sectorExposure.industrial_pct,
        assetBackedPct: sectorExposure.asset_backed_pct,
        financialPct:   sectorExposure.financial_pct,
        otherPct:       sectorExposure.other_pct,
        dataSource:     'parsed',
      });
    }

    if (notes.length) console.log(`[${ticker}] Parser notes:`, notes.join('; '));
  } catch (err) {
    console.warn(`[${ticker}] Schedule parse failed: ${err.message}`);
    stepResults.scheduleParserError = err.message;
  }

  // ── Step 4: Form 4 insider trades ────────────────────────────────
  console.log(`[${ticker}] Fetching Form 4 insider trades...`);
  let insiderTrades = [];
  try {
    insiderTrades = await fetchInsiderTrades(cik, MAX_FORM4_PER_BDC);
    await upsertInsiderTrades(ticker, insiderTrades);
    stepResults.insiderTrades = insiderTrades.length;
    console.log(`[${ticker}] Insider trades: ${insiderTrades.length}`);
  } catch (err) {
    console.warn(`[${ticker}] Form 4 fetch failed: ${err.message}`);
    stepResults.form4Error = err.message;
  }

  // ── Step 5: Price history ─────────────────────────────────────────
  const prices = priceData[ticker] ?? [];
  const latestNav = xbrlMetrics.latestNav ?? null;

  if (prices.length > 0 && latestNav != null) {
    await upsertValuationSnapshots(ticker, latestNav, prices);
    stepResults.priceSnapshots = prices.length;
    console.log(`[${ticker}] Price snapshots: ${prices.length} (latest NAV: ${latestNav})`);
  } else {
    console.warn(`[${ticker}] Skipping snapshots: prices=${prices.length} nav=${latestNav}`);
  }

  // ── Step 6: Scoring ───────────────────────────────────────────────
  // Re-read from DB to score against the most complete data we have.
  // (This ensures parsed + XBRL data are both included in the score.)
  const { data: pm } = await import('./db/client.js').then(m =>
    m.supabase
      .from('portfolio_metrics')
      .select('*')
      .eq('filing_period_id', filingPeriodId)
      .single()
  );

  const { data: sx } = await import('./db/client.js').then(m =>
    m.supabase
      .from('sector_exposure')
      .select('*')
      .eq('filing_period_id', filingPeriodId)
      .single()
  );

  const scoreResult = computeNavTrustScore(pm ?? {}, sx ?? {});
  await upsertNavTrustScore(ticker, filingPeriodId, scoreResult);
  stepResults.score = scoreResult.score;
  console.log(`[${ticker}] NAV Trust Score: ${scoreResult.score} (${scoreResult.grade})`);

  // ── Step 7: Alerts ────────────────────────────────────────────────
  const latestPrice = prices[prices.length - 1]?.close ?? null;
  const price30dAgo = prices.length >= 22 ? prices[prices.length - 22]?.close : null;
  const discount30dAgo = (price30dAgo != null && latestNav != null)
    ? ((price30dAgo - latestNav) / latestNav) * 100
    : null;

  const recentBuys = insiderTrades.filter(t => t.trade_type === 'buy').slice(0, 5);
  const alerts = generateAlerts(
    { ticker, latestNav, latestPrice, discount30dAgo },
    pm ?? {},
    sx ?? {},
    recentBuys,
  );

  await syncAlerts(ticker, alerts);
  stepResults.alerts = alerts.length;
  if (alerts.length) console.log(`[${ticker}] Alerts: ${alerts.map(a => a.label).join(', ')}`);

  return { ticker, status: 'success', steps: stepResults };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const startMs = Date.now();

  // Allow running specific tickers: node server/etl/index.js ARCC FSK
  const targetTickers = process.argv.slice(2).map(s => s.toUpperCase());
  const universe = targetTickers.length > 0
    ? BDC_UNIVERSE.filter(b => targetTickers.includes(b.ticker))
    : BDC_UNIVERSE;

  if (universe.length === 0) {
    console.error('No matching BDCs found. Check ticker names.');
    process.exit(1);
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`BDC Stress Radar ETL — ${new Date().toISOString()}`);
  console.log(`Processing: ${universe.map(b => b.ticker).join(', ')}`);
  console.log(`═══════════════════════════════════════`);

  // Seed the bdcs table if it's empty (idempotent upsert)
  await ensureBdcsSeeded(universe);

  // Fetch all prices upfront (sequential, polite to Yahoo)
  console.log('\n[prices] Fetching price history...');
  const priceData = await fetchAllPrices(universe.map(b => b.ticker), PRICE_LOOKBACK_DAYS);

  const results = [];
  for (const bdc of universe) {
    try {
      const result = await processBDC(bdc, priceData);
      results.push(result);
    } catch (err) {
      console.error(`\n[${bdc.ticker}] FATAL: ${err.message}`);
      results.push({ ticker: bdc.ticker, status: 'failed', error: err.message });
    }
  }

  const durationMs = Date.now() - startMs;
  const succeeded  = results.filter(r => r.status === 'success').length;
  const failed     = results.filter(r => r.status === 'failed').length;
  const status     = failed === 0 ? 'success' : succeeded > 0 ? 'partial' : 'failed';

  // Log the run
  await logEtlRun(
    status,
    results.map(r => r.ticker),
    results,
    failed > 0 ? results.filter(r => r.status === 'failed').map(r => `${r.ticker}: ${r.error}`).join('; ') : null,
    durationMs,
  );

  console.log(`\n═══════════════════════════════════════`);
  console.log(`ETL complete in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Results: ${succeeded} succeeded, ${failed} failed`);
  console.log(`═══════════════════════════════════════\n`);

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('ETL crashed:', err);
  process.exit(1);
});
