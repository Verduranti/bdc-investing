/**
 * Non-accrual extractor regression tests.
 *
 * Cases are transcribed verbatim from real 10-Q text (whitespace-normalized,
 * as the parser sees it). Each one exists because it broke a previous version
 * of the extractor — the comment on each says how.
 *
 * Run: node server/etl/edgar/__tests__/nonAccrual.test.mjs
 */
import assert from 'node:assert/strict';
import { extractNonAccrual } from '../nonAccrual.js';

const CASES = [
  {
    name: 'ARCC — parenthetical second basis',
    // The original regex read 2.4 and filed it as FAIR VALUE; 2.4 is the
    // amortized-cost figure and 1.4 is fair value.
    text: 'As of June 30, 2026 and December 31, 2025, loans on non-accrual status represented 2.4% of the total investments at amortized cost (or 1.4% at fair value) and 1.8% at amortized cost (or 1.2% at fair value), respectively.',
    want: { costPct: 2.4, fvPct: 1.4 },
  },
  {
    name: 'CGBD — grouped pcts, grouped bases',
    // Original regex returned 100.0 from "Percentage of loans at floating
    // interest rates 100.0%" elsewhere in the document.
    text: 'As of June 30, 2026, non-accrual investments represented 1.2% and 0.6% of our portfolio based on cost and fair value, respectively.',
    want: { costPct: 1.2, fvPct: 0.6 },
  },
  {
    name: 'SCM — interleaved pct/basis',
    text: 'the Company had loans to five portfolio companies that were on non-accrual status, which represented approximately 8.5% of the Company’s total investments at cost and 5.4% at fair value.',
    want: { costPct: 8.5, fvPct: 5.4 },
  },
  {
    name: 'MAIN — fair value named FIRST, bare "cost" as second basis',
    text: 'investments on non-accrual status comprised 1.1% and 4.0% of Main Street’s total Investment Portfolio at fair value and cost, respectively.',
    want: { costPct: 4.0, fvPct: 1.1 },
  },
  {
    name: 'CION — single basis; the second number is the PRIOR period',
    // Must NOT read 1.8 as the cost figure — it is December's fair value.
    text: 'As of June 30, 2026 and December 31, 2025, investments on non-accrual status represented 1.4% and 1.8%, respectively, of the Company’s investment portfolio on a fair value basis.',
    want: { costPct: null, fvPct: 1.4 },
  },
  {
    name: 'GBDC — bases stated BEFORE the percentages',
    text: 'As of June 30, 2026, we had loans in fifteen portfolio companies on non-accrual status, and non-accrual investments as a percentage of total investments at cost and fair value were 2.9% and 1.9%, respectively.',
    want: { costPct: 2.9, fvPct: 1.9 },
  },
  {
    name: 'MFIC — subject last, percentages first',
    text: 'Investments on Non-Accrual Status As of June 30, 2026, 4.6% of total investments at amortized cost, or 2.8% of total investments at fair value, were on non-accrual status.',
    want: { costPct: 4.6, fvPct: 2.8 },
  },
  {
    name: 'TRIN — appositive after a dollar amount',
    text: 'two portfolio companies and equipment financings to one portfolio company were on non-accrual status, with a total cost of approximately $41.0 million, and a total fair value of approximately $18.7 million, or 0.8%, of the fair value of the Company’s debt investment portfolio.',
    want: { costPct: null, fvPct: 0.8 },
  },
  {
    name: 'BCSF — Performing/Non-accrual table, both bases in header',
    // Original regex returned 96.8 — the PERFORMING row.
    text: 'The following table shows the amortized cost and fair value of our performing and non-accrual investments as of June 30, 2026 (dollars in thousands): As of June 30, 2026 Amortized Cost Percentage atAmortized Cost Fair Value Percentage atFair Value Performing $ 2,300,320 96.8 % $ 2,312,753 97.8 % Non-accrual 74,925 3.2 50,823 2.2 Total $ 2,375,245 100.0 % $ 2,363,576 100.0 %',
    want: { costPct: 3.2, fvPct: 2.2 },
  },
  {
    name: 'MSDL — cost-only table whose two columns are two DATES',
    // Must NOT read 1.6 (December's cost) as June's fair value.
    text: 'The table below presents the amortized cost of our performing and non-accrual investments as of the following periods: June 30, 2026 December 31, 2025 Amortized Cost % of Total Amortized Cost % of Total Performing $ 3,570,188 97.1 % $ 3,778,647 98.4 % Non-accrual(1) 106,451 2.9 60,392 1.6 Total $ 3,676,639 100.0 % $ 3,839,039 100.0 %',
    want: { costPct: 2.9, fvPct: null },
  },
  {
    name: 'TSLX — millions-scale table; dollar amounts must not read as percentages',
    // Range-filtering picked the prior period's $20.0M as a 20% rate.
    text: 'The following tables show the fair value and amortized cost of our performing and non-accrual investments as of June 30, 2026 and December 31, 2025: June 30, 2026 December 31, 2025 ($ in millions) Fair Value Percentage Fair Value Percentage Performing $ 3,259.4 98.7 % $ 3,327.3 99.4 % Non-accrual (1) 42.7 1.3 20.0 0.6 Total $ 3,302.1 100.0 % $ 3,347.3 100.0 %',
    want: { costPct: null, fvPct: 1.3 },
  },
  // ── Must return NOTHING ──────────────────────────────────────────────
  {
    name: 'BBDC — 1940 Act control footnote (no disclosure)',
    // Original regex returned 25 from "more than 25% of the ... voting".
    text: 'Non-accrual investment (5) As defined in the 1940 Act, the Company is deemed to be both an “affiliated person” and “control” the portfolio company because it owns more than 25% of the portfolio company’s outstanding voting securities.',
    want: null,
  },
  {
    name: 'FSK — unrelated rate breakdown in a sentence mentioning non-accrual',
    // A broader sentence-scan version read 9.1 here as a non-accrual rate.
    text: 'As of June 30, 2026, 59.4% of our portfolio investments (based on fair value) were debt investments paying variable interest rates and 9.1% were debt investments paying fixed interest rates, excluding investments on non-accrual status.',
    want: null,
  },
  {
    name: 'Accounting-policy boilerplate (no figures)',
    text: 'Loans are generally placed on non-accrual status when principal or interest payments are past due 30 days or more or when management has reasonable doubt that the borrower will pay principal or interest in full.',
    want: null,
  },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const got = extractNonAccrual(c.text);
  try {
    if (c.want === null) {
      assert.equal(got, null, `expected no extraction, got ${JSON.stringify(got)}`);
    } else {
      assert.ok(got, 'expected an extraction, got null');
      assert.equal(got.costPct, c.want.costPct, 'costPct');
      assert.equal(got.fvPct, c.want.fvPct, 'fvPct');
    }
    pass++;
    console.log(`  ok   ${c.name}`);
  } catch (err) {
    fail++;
    console.error(`  FAIL ${c.name}\n       ${err.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
