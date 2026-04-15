/**
 * ETL Constants
 *
 * Single source of truth for the BDC universe, CIK map, and
 * EDGAR API configuration. Add new BDCs here only — the ETL
 * and scoring engine pick them up automatically.
 */

// Your email address — EDGAR requires this in the User-Agent header.
// Set via EDGAR_EMAIL env var in production; fallback for local dev.
export const EDGAR_USER_AGENT = `BDCStressRadar/1.0 ${process.env.EDGAR_EMAIL ?? 'your@email.com'}`;

export const EDGAR_BASE        = 'https://data.sec.gov';
export const EDGAR_ARCHIVES    = 'https://www.sec.gov/Archives/edgar/data';
export const EDGAR_RATE_LIMIT_MS = 110;  // 10 req/sec max; 110ms gives headroom

// BDC universe. CIKs are zero-padded to 10 digits as EDGAR expects.
export const BDC_UNIVERSE = [
  { ticker: 'ARCC', cik: '0001278752', name: 'Ares Capital Corporation',        fiscalYearEnd: 'December'  },
  { ticker: 'BXSL', cik: '0001655888', name: 'Blackstone Secured Lending Fund', fiscalYearEnd: 'December'  },
  { ticker: 'TSLX', cik: '0001559846', name: 'Sixth Street Specialty Lending',  fiscalYearEnd: 'December'  },
  { ticker: 'GBDC', cik: '0001476765', name: 'Golub Capital BDC',               fiscalYearEnd: 'September' },
  { ticker: 'FSK',  cik: '0001514281', name: 'FS KKR Capital Corp',             fiscalYearEnd: 'December'  },
];

// XBRL concept names we pull from companyfacts.
// BDCs use standard us-gaap investment company concepts.
// Some BDCs use different tags — we try each in order and take the first hit.
export const XBRL_CONCEPTS = {
  navPerShare: [
    'NetAssetValuePerShare',
  ],
  niiPerShare: [
    'InvestmentIncomeNetPerShare',
    'NetInvestmentIncomeLossPerShare',
    'EarningsPerShareBasic',           // fallback
  ],
  dividendPerShare: [
    'CommonStockDividendsPerShareDeclared',
    'CommonStockDividendsPerShareCashPaid',
  ],
  totalAssets: [
    'Assets',
  ],
  totalDebt: [
    'LongTermDebt',
    'DebtAndCapitalLeaseObligations',
  ],
  // Non-accrual and PIK are NOT standard XBRL — parsed from document text
};

// Alert thresholds (mirrors src/utils/scoring.js — keep in sync)
export const ALERT_THRESHOLDS = {
  discountWidening30d:  -5,    // % — alert if discount widens more than this
  pikSpikeBps:          100,   // bps QoQ
  dividendCoverage:     1.0,   // below this = uncovered
  softwareConcentration: 30,   // % threshold
  markdownMaterial:     -1.0,  // % QoQ
  insiderBuyBelowNav:   true,  // always alert
};
