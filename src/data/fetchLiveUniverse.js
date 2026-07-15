/**
 * Live BDC Universe Fetcher
 *
 * Pulls data from Supabase and reshapes it into the exact same record
 * shape as the mock BDC_UNIVERSE (src/data/bdcData.js) — see that file's
 * header comment for the canonical schema. This lets scoring.js and every
 * UI component stay 100% unchanged; only the data source swaps out.
 *
 * Falls back to the mock record for any ticker that doesn't have a
 * processed filing yet (e.g. a BDC just added to the universe that the
 * ETL hasn't run against). That fallback is flagged via
 * `meta.dataSource === 'mock_seed_v1'` so the UI can indicate it.
 */
import { supabase } from '../lib/supabaseClient';
import { BDC_UNIVERSE as MOCK_UNIVERSE } from './bdcData';

const seriesFromSnapshots = (rows, key) =>
  rows.map(r => ({ date: r.snapshot_date, value: r[key] })).filter(p => p.value != null);

/**
 * Fetch and reshape the live BDC universe from Supabase.
 * @returns {Promise<{ universe: object[], liveTickers: string[], error: Error|null }>}
 */
export async function fetchLiveUniverse() {
  try {
    const [{ data: bdcs, error: bdcsErr }, { data: filingPeriods, error: fpErr }] =
      await Promise.all([
        supabase.from('bdcs').select('*').eq('is_active', true),
        supabase.from('filing_periods').select('*').order('period_end', { ascending: false }),
      ]);
    if (bdcsErr) throw bdcsErr;
    if (fpErr) throw fpErr;
    if (!bdcs || bdcs.length === 0) {
      return { universe: MOCK_UNIVERSE, liveTickers: [], error: null };
    }

    // Latest filing period per bdc_id (rows are already ordered desc by period_end)
    const latestFilingByBdc = {};
    for (const fp of filingPeriods ?? []) {
      if (!(fp.bdc_id in latestFilingByBdc)) latestFilingByBdc[fp.bdc_id] = fp;
    }
    const latestFilingPeriodIds = Object.values(latestFilingByBdc).map(fp => fp.id);

    const [
      { data: portfolioMetrics, error: pmErr },
      { data: sectorExposure, error: seErr },
      { data: snapshots, error: vsErr },
      { data: insiderActivity, error: iaErr },
    ] = await Promise.all([
      latestFilingPeriodIds.length
        ? supabase.from('portfolio_metrics').select('*').in('filing_period_id', latestFilingPeriodIds)
        : Promise.resolve({ data: [], error: null }),
      latestFilingPeriodIds.length
        ? supabase.from('sector_exposure').select('*').in('filing_period_id', latestFilingPeriodIds)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from('valuation_snapshots')
        .select('bdc_id, snapshot_date, price, nav')
        .order('snapshot_date', { ascending: true }),
      supabase
        .from('insider_activity')
        .select('*')
        .order('transaction_date', { ascending: false })
        .limit(500),
    ]);
    if (pmErr) throw pmErr;
    if (seErr) throw seErr;
    if (vsErr) throw vsErr;
    if (iaErr) throw iaErr;

    const pmByFilingId = Object.fromEntries((portfolioMetrics ?? []).map(r => [r.filing_period_id, r]));
    const seByFilingId = Object.fromEntries((sectorExposure ?? []).map(r => [r.filing_period_id, r]));

    const snapshotsByBdc = {};
    for (const s of snapshots ?? []) {
      (snapshotsByBdc[s.bdc_id] ??= []).push(s);
    }

    const insiderByBdc = {};
    for (const t of insiderActivity ?? []) {
      (insiderByBdc[t.bdc_id] ??= []).push(t);
    }

    const mockByTicker = Object.fromEntries(MOCK_UNIVERSE.map(b => [b.ticker, b]));
    const liveTickers = [];

    const universe = bdcs.map(bdc => {
      const filing = latestFilingByBdc[bdc.id];
      const pm = filing ? pmByFilingId[filing.id] : null;
      const se = filing ? seByFilingId[filing.id] : null;
      const bdcSnapshots = snapshotsByBdc[bdc.id] ?? [];
      const latestSnapshot = bdcSnapshots[bdcSnapshots.length - 1];

      // Not enough live data yet (ETL hasn't processed this BDC) — use mock.
      if (!filing || !pm || !latestSnapshot?.price || !latestSnapshot?.nav) {
        return mockByTicker[bdc.ticker] ?? null;
      }

      liveTickers.push(bdc.ticker);

      const trades = (insiderByBdc[bdc.id] ?? []).map(t => ({
        date: t.transaction_date,
        type: t.trade_type,
        shares: t.shares,
        price: t.price_per_share,
        insider: t.insider_name,
        title: t.insider_title,
      }));

      return {
        ticker: bdc.ticker,
        name: bdc.name,
        manager: bdc.manager ?? '—',
        fiscalYearEnd: bdc.fiscal_year_end ?? '—',
        meta: {
          lastUpdated: filing.filed_at ?? filing.period_end,
          filingPeriod: `${filing.form_type} ${filing.period_end}`,
          dataSource: pm.data_source ?? 'etl',
        },
        valuation: {
          price: latestSnapshot.price,
          nav: latestSnapshot.nav,
          navHistory: seriesFromSnapshots(bdcSnapshots, 'nav'),
          priceHistory: seriesFromSnapshots(bdcSnapshots, 'price'),
          dividendAnnual: pm.dividend_per_share != null ? parseFloat((pm.dividend_per_share * 4).toFixed(2)) : 0,
          dividendFrequency: 'quarterly',
        },
        // IMPORTANT: pass through real nulls here — do NOT default missing
        // fields to 0. Scoring six components that are all artificially
        // "0" produces the exact same composite NAV Trust Score (85) for
        // every BDC with incomplete data, which looks like a real
        // assessment but isn't. scoring.js now skips null components and
        // renormalizes over what's actually available.
        assetQuality: {
          nonAccrualCostPct: pm.non_accrual_cost_pct,
          nonAccrualFVPct: pm.non_accrual_fv_pct,
          pikIncomePct: pm.pik_income_pct,
          pikIncomePriorQuarterPct: pm.pik_income_prior_pct,
          qoqMarkdownPct: pm.qoq_markdown_pct,
          trailingRealizedLossesPct: pm.trailing_realized_losses_pct,
          niiPerShare: pm.nii_per_share,
          dividendPerShare: pm.dividend_per_share,
          dividendCoverage: pm.dividend_coverage,
        },
        sectorExposure: {
          software: se?.software_pct ?? null,
          healthcare: se?.healthcare_pct ?? null,
          consumer: se?.consumer_pct ?? null,
          industrial: se?.industrial_pct ?? null,
          assetBacked: se?.asset_backed_pct ?? null,
          financial: se?.financial_pct ?? null,
          other: se?.other_pct ?? null,
          top10HoldingsPct: se?.top_10_holdings_pct ?? null,
        },
        insiderActivity: trades,
        alerts: [],
      };
    }).filter(Boolean);

    // Include any mock-only tickers not yet present in the live bdcs table at all
      // (shouldn't normally happen once constants.js/seed.sql are in sync, but
      // keeps the UI from silently dropping a BDC during rollout).
    const liveTickerSet = new Set(bdcs.map(b => b.ticker));
    for (const mockBdc of MOCK_UNIVERSE) {
      if (!liveTickerSet.has(mockBdc.ticker)) universe.push(mockBdc);
    }

    return { universe, liveTickers, error: null };
  } catch (error) {
    console.error('[fetchLiveUniverse] falling back to mock data:', error);
    return { universe: MOCK_UNIVERSE, liveTickers: [], error };
  }
}
