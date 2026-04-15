/**
 * BDC Stress Radar — Canonical Data Model (Seed / Mock Data)
 *
 * Schema Version: 1.0
 *
 * Each BDC record covers:
 *   - identity:        ticker, name, manager, fiscalYearEnd
 *   - valuation:       price, nav, history of navHistory / priceHistory
 *   - assetQuality:    nonAccrualCost%, nonAccrualFV%, pikIncome%,
 *                      qoqMarkdown%, trailingRealizedLosses%, dividendNIICoverage
 *   - sectorExposure:  software%, healthcare%, consumer%, industrial%,
 *                      assetBacked%, other%, top10Holdings%
 *   - insiderActivity: recent Form 4 buy/sell events
 *   - alerts:          pre-computed triggered events
 *   - meta:            lastUpdated, filingPeriod, dataSource
 *
 * When real SEC ingestion is wired in, these fields map 1-to-1 to the
 * normalized ETL output. Do not rename top-level keys without migrating
 * the scoring engine and UI selectors.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a simple time-series of (date, value) pairs going back N quarters */
function quarterSeries(latestValue, quarters, volatility = 0.02) {
  const series = [];
  let v = latestValue;
  const now = new Date(2024, 11, 31); // Dec 31 2024
  for (let i = quarters - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i * 3);
    series.push({
      date: d.toISOString().slice(0, 10),
      value: parseFloat(v.toFixed(4)),
    });
    // walk backwards with some noise (add noise for next iteration going forward)
    v = v * (1 + (Math.random() - 0.48) * volatility);
  }
  // Force last point to match exactly
  series[series.length - 1].value = latestValue;
  return series;
}

/** Discount % = (Price - NAV) / NAV * 100  (negative means trading below NAV) */
function discountPct(price, nav) {
  return parseFloat(((price - nav) / nav * 100).toFixed(2));
}

// ─── Seed BDCs ────────────────────────────────────────────────────────────────

export const BDC_UNIVERSE = [
  // ── ARCC ──────────────────────────────────────────────────────────────────
  {
    ticker: 'ARCC',
    name: 'Ares Capital Corporation',
    manager: 'Ares Management',
    fiscalYearEnd: 'December',
    meta: {
      lastUpdated: '2024-11-12',
      filingPeriod: 'Q3 2024',
      dataSource: 'mock_seed_v1',
    },
    valuation: {
      price: 19.82,
      nav: 19.27,
      navHistory: quarterSeries(19.27, 12, 0.015),
      priceHistory: quarterSeries(19.82, 12, 0.04),
      dividendAnnual: 1.92,
      dividendFrequency: 'quarterly',
    },
    assetQuality: {
      nonAccrualCostPct: 1.2,       // % of portfolio at cost on non-accrual
      nonAccrualFVPct: 0.7,         // % at fair value
      pikIncomePct: 8.4,            // PIK as % of total investment income
      pikIncomePriorQuarterPct: 7.6,
      qoqMarkdownPct: -0.3,         // negative = net markdown, positive = markup
      trailingRealizedLossesPct: 0.4,
      niiPerShare: 0.55,
      dividendPerShare: 0.48,
      dividendCoverage: 1.15,       // NII / Dividend
    },
    sectorExposure: {
      software: 22.1,
      healthcare: 14.3,
      consumer: 9.8,
      industrial: 11.2,
      assetBacked: 8.5,
      financial: 7.4,
      other: 26.7,
      top10HoldingsPct: 18.3,
    },
    insiderActivity: [
      { date: '2024-10-15', type: 'buy', shares: 50000, price: 19.45, insider: 'Rosenthal, Kipp', title: 'Director' },
    ],
    alerts: [],
  },

  // ── BXSL ──────────────────────────────────────────────────────────────────
  {
    ticker: 'BXSL',
    name: 'Blackstone Secured Lending Fund',
    manager: 'Blackstone Credit',
    fiscalYearEnd: 'December',
    meta: {
      lastUpdated: '2024-11-08',
      filingPeriod: 'Q3 2024',
      dataSource: 'mock_seed_v1',
    },
    valuation: {
      price: 26.11,
      nav: 27.45,
      navHistory: quarterSeries(27.45, 12, 0.012),
      priceHistory: quarterSeries(26.11, 12, 0.035),
      dividendAnnual: 2.56,
      dividendFrequency: 'quarterly',
    },
    assetQuality: {
      nonAccrualCostPct: 0.3,
      nonAccrualFVPct: 0.1,
      pikIncomePct: 4.2,
      pikIncomePriorQuarterPct: 3.9,
      qoqMarkdownPct: 0.1,
      trailingRealizedLossesPct: 0.1,
      niiPerShare: 0.68,
      dividendPerShare: 0.64,
      dividendCoverage: 1.06,
    },
    sectorExposure: {
      software: 31.4,
      healthcare: 16.2,
      consumer: 7.3,
      industrial: 13.1,
      assetBacked: 3.2,
      financial: 4.8,
      other: 24.0,
      top10HoldingsPct: 22.1,
    },
    insiderActivity: [],
    alerts: [],
  },

  // ── TSLX ──────────────────────────────────────────────────────────────────
  {
    ticker: 'TSLX',
    name: 'Sixth Street Specialty Lending',
    manager: 'Sixth Street Partners',
    fiscalYearEnd: 'December',
    meta: {
      lastUpdated: '2024-11-06',
      filingPeriod: 'Q3 2024',
      dataSource: 'mock_seed_v1',
    },
    valuation: {
      price: 20.95,
      nav: 21.82,
      navHistory: quarterSeries(21.82, 12, 0.01),
      priceHistory: quarterSeries(20.95, 12, 0.03),
      dividendAnnual: 1.84,
      dividendFrequency: 'quarterly',
    },
    assetQuality: {
      nonAccrualCostPct: 0.8,
      nonAccrualFVPct: 0.4,
      pikIncomePct: 6.1,
      pikIncomePriorQuarterPct: 5.8,
      qoqMarkdownPct: 0.0,
      trailingRealizedLossesPct: 0.2,
      niiPerShare: 0.52,
      dividendPerShare: 0.46,
      dividendCoverage: 1.13,
    },
    sectorExposure: {
      software: 18.6,
      healthcare: 19.1,
      consumer: 12.4,
      industrial: 15.3,
      assetBacked: 11.2,
      financial: 5.1,
      other: 18.3,
      top10HoldingsPct: 29.4,
    },
    insiderActivity: [
      { date: '2024-11-01', type: 'buy', shares: 25000, price: 20.72, insider: 'Lipson, Joshua', title: 'CEO' },
    ],
    alerts: [],
  },

  // ── GBDC ──────────────────────────────────────────────────────────────────
  {
    ticker: 'GBDC',
    name: 'Golub Capital BDC',
    manager: 'Golub Capital',
    fiscalYearEnd: 'September',
    meta: {
      lastUpdated: '2024-11-14',
      filingPeriod: 'Q4 FY2024',
      dataSource: 'mock_seed_v1',
    },
    valuation: {
      price: 13.87,
      nav: 15.24,
      navHistory: quarterSeries(15.24, 12, 0.018),
      priceHistory: quarterSeries(13.87, 12, 0.05),
      dividendAnnual: 1.32,
      dividendFrequency: 'quarterly',
    },
    assetQuality: {
      nonAccrualCostPct: 2.8,
      nonAccrualFVPct: 1.6,
      pikIncomePct: 11.3,
      pikIncomePriorQuarterPct: 9.1,         // PIK SPIKED — trigger alert
      qoqMarkdownPct: -1.1,                   // meaningful markdown
      trailingRealizedLossesPct: 1.8,
      niiPerShare: 0.31,
      dividendPerShare: 0.33,
      dividendCoverage: 0.94,                 // UNCOVERED — trigger alert
    },
    sectorExposure: {
      software: 28.7,
      healthcare: 11.8,
      consumer: 14.2,
      industrial: 9.6,
      assetBacked: 5.3,
      financial: 6.1,
      other: 24.3,
      top10HoldingsPct: 31.2,
    },
    insiderActivity: [],
    alerts: [],
  },

  // ── FSK ───────────────────────────────────────────────────────────────────
  {
    ticker: 'FSK',
    name: 'FS KKR Capital Corp',
    manager: 'FS/KKR Advisor',
    fiscalYearEnd: 'December',
    meta: {
      lastUpdated: '2024-11-07',
      filingPeriod: 'Q3 2024',
      dataSource: 'mock_seed_v1',
    },
    valuation: {
      price: 18.44,
      nav: 23.91,
      navHistory: quarterSeries(23.91, 12, 0.022),
      priceHistory: quarterSeries(18.44, 12, 0.06),
      dividendAnnual: 2.80,
      dividendFrequency: 'quarterly',
    },
    assetQuality: {
      nonAccrualCostPct: 4.1,
      nonAccrualFVPct: 2.3,
      pikIncomePct: 13.8,
      pikIncomePriorQuarterPct: 12.1,
      qoqMarkdownPct: -1.8,
      trailingRealizedLossesPct: 3.2,
      niiPerShare: 0.74,
      dividendPerShare: 0.70,
      dividendCoverage: 1.06,
    },
    sectorExposure: {
      software: 15.3,
      healthcare: 18.7,
      consumer: 16.1,
      industrial: 12.4,
      assetBacked: 14.8,
      financial: 8.2,
      other: 14.5,
      top10HoldingsPct: 16.8,
    },
    insiderActivity: [
      { date: '2024-10-28', type: 'buy', shares: 100000, price: 18.20, insider: 'Forman, Michael', title: 'Executive Chairman' },
    ],
    alerts: [],
  },
];

export default BDC_UNIVERSE;
