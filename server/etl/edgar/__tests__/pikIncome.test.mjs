/**
 * PIK income regression tests.
 *
 * Operates on synthetic companyfacts blobs shaped exactly like EDGAR's,
 * so the concept-selection rules can be tested without network access.
 *
 * Run: node server/etl/edgar/__tests__/pikIncome.test.mjs
 */
import assert from 'node:assert/strict';
import { computePikIncome } from '../xbrl.js';

const Q = (end, start, val) => ({ end, start, val, form: '10-Q', filed: '2026-07-29' });

/** Build a facts blob from { conceptName: [entries] }. */
const facts = spec => ({
  'us-gaap': Object.fromEntries(
    Object.entries(spec).map(([name, entries]) => [name, { units: { USD: entries } }])
  ),
});

const CASES = [
  {
    name: 'interest PIK over gross investment income',
    facts: facts({
      InterestIncomeOperatingPaidInKind: [Q('2026-06-30', '2026-04-01', 6_850_000)],
      GrossInvestmentIncomeOperating:    [Q('2026-06-30', '2026-04-01', 62_085_000)],
    }),
    period: '2026-06-30',
    check: r => assert.equal(r.pct, 11.033),
  },
  {
    name: 'combined tag is used alone — not added to the separate concepts',
    // InterestAndDividendIncomeOperatingPaidInKind already includes dividend
    // PIK; summing all three would double-count.
    facts: facts({
      InterestAndDividendIncomeOperatingPaidInKind: [Q('2026-06-30', '2026-04-01', 13_057_000)],
      InterestIncomeOperatingPaidInKind:            [Q('2026-06-30', '2026-04-01', 11_000_000)],
      DividendIncomeOperatingPaidInKind:            [Q('2026-06-30', '2026-04-01', 2_057_000)],
      GrossInvestmentIncomeOperating:               [Q('2026-06-30', '2026-04-01', 49_793_000)],
    }),
    period: '2026-06-30',
    check: r => { assert.equal(r.source, 'combined'); assert.equal(r.pct, 26.223); },
  },
  {
    name: 'dividend PIK ALONE is refused rather than reported as a 10x undercount',
    // BCSF 2026-06-30: only the $0.7M dividend component is tagged; the
    // interest component (~$7.4M the prior quarter) is absent. Summing what
    // is present yields 1.1% against a real figure near 12%.
    facts: facts({
      DividendIncomeOperatingPaidInKind: [Q('2026-06-30', '2026-04-01', 700_000)],
      GrossInvestmentIncomeOperating:    [Q('2026-06-30', '2026-04-01', 62_348_000)],
    }),
    period: '2026-06-30',
    check: r => { assert.equal(r.pct, null); assert.equal(r.source, 'dividend-only'); assert.ok(r.note); },
  },
  {
    name: 'year-to-date numerator is ignored in favour of the single quarter',
    // A 10-Q reports both; a 6-month PIK figure over a 3-month income figure
    // would roughly double the result.
    facts: facts({
      InterestIncomeOperatingPaidInKind: [
        Q('2026-06-30', '2026-01-01', 13_000_000),  // YTD — must be ignored
        Q('2026-06-30', '2026-04-01', 6_850_000),   // the quarter
      ],
      GrossInvestmentIncomeOperating: [Q('2026-06-30', '2026-04-01', 62_085_000)],
    }),
    period: '2026-06-30',
    check: r => assert.equal(r.pct, 11.033),
  },
  {
    name: 'a rate concept is never used as a numerator',
    // InvestmentInterestRatePaidInKind is a RATE (2.50), not an amount.
    facts: facts({
      InvestmentInterestRatePaidInKind: [Q('2026-06-30', '2026-04-01', 2.5)],
      GrossInvestmentIncomeOperating:   [Q('2026-06-30', '2026-04-01', 62_085_000)],
    }),
    period: '2026-06-30',
    check: r => { assert.equal(r.pct, null); assert.equal(r.source, 'none'); },
  },
  {
    name: 'prior quarter is returned alongside the current one',
    // scorePIK needs both; pik_income_prior_pct was never populated before.
    facts: facts({
      InterestIncomeOperatingPaidInKind: [
        Q('2026-06-30', '2026-04-01', 6_850_000),
        Q('2026-03-31', '2026-01-01', 6_481_000),
      ],
      GrossInvestmentIncomeOperating: [
        Q('2026-06-30', '2026-04-01', 62_085_000),
        Q('2026-03-31', '2026-01-01', 64_079_000),
      ],
    }),
    period: '2026-06-30',
    check: r => { assert.equal(r.pct, 11.033); assert.equal(r.priorPct, 10.114); assert.equal(r.priorPeriod, '2026-03-31'); },
  },
  {
    name: 'a period with no denominator returns null, not a figure from another quarter',
    facts: facts({
      InterestIncomeOperatingPaidInKind: [Q('2026-06-30', '2026-04-01', 6_850_000)],
      GrossInvestmentIncomeOperating:    [Q('2026-03-31', '2026-01-01', 64_079_000)],
    }),
    period: '2026-06-30',
    check: r => assert.equal(r.pct, null),
  },
  {
    name: 'InvestmentIncomeNet fallback is only trusted when it exceeds NetInvestmentIncome',
    facts: facts({
      InterestIncomeOperatingPaidInKind: [Q('2026-06-30', '2026-04-01', 8_000_000)],
      InvestmentIncomeNet:               [Q('2026-06-30', '2026-04-01', 83_724_000)],
      NetInvestmentIncome:               [Q('2026-06-30', '2026-04-01', 43_058_000)],
    }),
    period: '2026-06-30',
    check: r => assert.equal(r.pct, 9.555),
  },
  {
    name: 'fallback is refused when NetInvestmentIncome is absent (basis unproven)',
    facts: facts({
      InterestIncomeOperatingPaidInKind: [Q('2026-06-30', '2026-04-01', 8_000_000)],
      InvestmentIncomeNet:               [Q('2026-06-30', '2026-04-01', 83_724_000)],
    }),
    period: '2026-06-30',
    check: r => assert.equal(r.pct, null),
  },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  try {
    c.check(computePikIncome(c.facts, c.period));
    pass++;
    console.log(`  ok   ${c.name}`);
  } catch (err) {
    fail++;
    console.error(`  FAIL ${c.name}\n       ${err.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
