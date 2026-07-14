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
  // NOTE: ARCC's CIK was previously misentered as 0001278752 (which is
  // actually MFIC's CIK) — corrected to 0001287750 below.
  { ticker: 'ARCC', cik: '0001287750', name: 'Ares Capital Corporation',              fiscalYearEnd: 'December'  },
  { ticker: 'BBDC', cik: '0001379785', name: 'Barings BDC, Inc.',                     fiscalYearEnd: 'December'  },
  { ticker: 'BCSF', cik: '0001655050', name: 'Bain Capital Specialty Finance, Inc.',  fiscalYearEnd: 'December'  },
  { ticker: 'BXSL', cik: '0001736035', name: 'Blackstone Secured Lending Fund',       fiscalYearEnd: 'December'  },
  { ticker: 'CCAP', cik: '0001633336', name: 'Crescent Capital BDC, Inc.',            fiscalYearEnd: 'December'  },
  { ticker: 'CGBD', cik: '0001544206', name: 'Carlyle Secured Lending, Inc.',         fiscalYearEnd: 'December'  },
  { ticker: 'CION', cik: '0001534254', name: 'CION Investment Corporation',           fiscalYearEnd: 'December'  },
  { ticker: 'CSWC', cik: '0000017313', name: 'Capital Southwest Corporation',         fiscalYearEnd: 'March'     },
  { ticker: 'FDUS', cik: '0001513363', name: 'Fidus Investment Corporation',          fiscalYearEnd: 'December'  },
  { ticker: 'FSK',  cik: '0001514281', name: 'FS KKR Capital Corp',                   fiscalYearEnd: 'December'  },
  { ticker: 'GAIN', cik: '0001321741', name: 'Gladstone Investment Corporation',      fiscalYearEnd: 'March'     },
  { ticker: 'GBDC', cik: '0001476765', name: 'Golub Capital BDC',                     fiscalYearEnd: 'September' },
  { ticker: 'GECC', cik: '0001675033', name: 'Great Elm Capital Corp.',               fiscalYearEnd: 'December'  },
  { ticker: 'GLAD', cik: '0001143513', name: 'Gladstone Capital Corporation',         fiscalYearEnd: 'September' },
  { ticker: 'GSBD', cik: '0001572694', name: 'Goldman Sachs BDC, Inc.',               fiscalYearEnd: 'December'  },
  { ticker: 'HRZN', cik: '0001487428', name: 'Horizon Technology Finance Corporation',fiscalYearEnd: 'December'  },
  { ticker: 'HTGC', cik: '0001280784', name: 'Hercules Capital, Inc.',                fiscalYearEnd: 'December'  },
  { ticker: 'ICMB', cik: '0001578348', name: 'Investcorp Credit Management BDC, Inc.',fiscalYearEnd: 'June'      },
  { ticker: 'LIEN', cik: '0001843162', name: 'Chicago Atlantic BDC, Inc.',            fiscalYearEnd: 'December'  },
  { ticker: 'MAIN', cik: '0001396440', name: 'Main Street Capital Corporation',       fiscalYearEnd: 'December'  },
  { ticker: 'MFIC', cik: '0001278752', name: 'MidCap Financial Investment Corp',      fiscalYearEnd: 'December'  },
  { ticker: 'MRCC', cik: '0001512931', name: 'Monroe Capital Corporation',            fiscalYearEnd: 'December'  },
  { ticker: 'MSDL', cik: '0001782524', name: 'Morgan Stanley Direct Lending Fund',    fiscalYearEnd: 'December'  },
  { ticker: 'MSIF', cik: '0001535778', name: 'MSC Income Fund, Inc.',                 fiscalYearEnd: 'December'  },
  { ticker: 'NCDL', cik: '0001737924', name: 'Nuveen Churchill Direct Lending Corp.', fiscalYearEnd: 'December'  },
  { ticker: 'NMFC', cik: '0001496099', name: 'New Mountain Finance Corporation',      fiscalYearEnd: 'December'  },
  { ticker: 'NSLR', cik: '0001509470', name: 'Neostellar Capital Corp.',              fiscalYearEnd: 'December'  },
  { ticker: 'OBDC', cik: '0001655888', name: 'Blue Owl Capital Corporation',          fiscalYearEnd: 'December'  },
  { ticker: 'OCSL', cik: '0001414932', name: 'Oaktree Specialty Lending Corporation', fiscalYearEnd: 'September' },
  { ticker: 'OFS',  cik: '0001487918', name: 'OFS Capital Corporation',               fiscalYearEnd: 'December'  },
  { ticker: 'OXSQ', cik: '0001259429', name: 'Oxford Square Capital Corp.',           fiscalYearEnd: 'December'  },
  { ticker: 'PFLT', cik: '0001504619', name: 'PennantPark Floating Rate Capital Ltd.',fiscalYearEnd: 'September' },
  { ticker: 'PFX',  cik: '0001490349', name: 'PhenixFIN Corporation',                 fiscalYearEnd: 'September' },
  { ticker: 'PNNT', cik: '0001383414', name: 'PennantPark Investment Corporation',    fiscalYearEnd: 'September' },
  { ticker: 'PSBD', cik: '0001794776', name: 'Palmer Square Capital BDC Inc.',        fiscalYearEnd: 'December'  },
  { ticker: 'PSEC', cik: '0001287032', name: 'Prospect Capital Corporation',          fiscalYearEnd: 'June'      },
  { ticker: 'RAND', cik: '0000081955', name: 'Rand Capital Corporation',              fiscalYearEnd: 'December'  },
  { ticker: 'RWAY', cik: '0001653384', name: 'Runway Growth Finance Corp.',           fiscalYearEnd: 'December'  },
  { ticker: 'SAR',  cik: '0001377936', name: 'Saratoga Investment Corp.',             fiscalYearEnd: 'February'  },
  { ticker: 'SCM',  cik: '0001551901', name: 'Stellus Capital Investment Corporation',fiscalYearEnd: 'December'  },
  { ticker: 'SLRC', cik: '0001418076', name: 'SLR Investment Corp.',                  fiscalYearEnd: 'December'  },
  { ticker: 'TCPC', cik: '0001370755', name: 'BlackRock TCP Capital Corp.',           fiscalYearEnd: 'December'  },
  { ticker: 'TPVG', cik: '0001580345', name: 'TriplePoint Venture Growth BDC Corp.',  fiscalYearEnd: 'December'  },
  { ticker: 'TRIN', cik: '0001786108', name: 'Trinity Capital Inc.',                  fiscalYearEnd: 'December'  },
  { ticker: 'TSLX', cik: '0001559846', name: 'Sixth Street Specialty Lending',        fiscalYearEnd: 'December'  },
  { ticker: 'WHF',  cik: '0001552198', name: 'WhiteHorse Finance, Inc.',              fiscalYearEnd: 'December'  },
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
