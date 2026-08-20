/**
 * EDGAR XBRL Fetcher
 *
 * Pulls structured financial facts from the EDGAR companyfacts endpoint.
 * Returns NAV per share, NII per share, and dividend per share history
 * by quarter — these are the fields that ARE available in XBRL for BDCs.
 *
 * PIK income IS available in XBRL (as tagged dollar amounts) and is computed
 * here — see computePikIncome. Non-accruals and sector exposure are not
 * tagged by any filer in the universe and require document parsing (see
 * nonAccrual.js and scheduleParser.js).
 *
 * API: https://data.sec.gov/api/xbrl/companyfacts/CIK{padded}.json
 */

import { EDGAR_BASE, EDGAR_USER_AGENT, XBRL_CONCEPTS } from '../constants.js';
import { rateLimited } from './rateLimit.js';

/**
 * Fetch the full companyfacts blob for a CIK.
 * This is a large JSON (~1-5MB) — cache locally if running frequently.
 */
async function fetchCompanyFacts(cik) {
  const padded = cik.replace(/^0+/, '').padStart(10, '0');
  return rateLimited(async () => {
    const res = await fetch(`${EDGAR_BASE}/api/xbrl/companyfacts/CIK${padded}.json`, {
      headers: { 'User-Agent': EDGAR_USER_AGENT },
    });
    if (!res.ok) throw new Error(`XBRL fetch failed ${res.status} for CIK ${cik}`);
    return res.json();
  });
}

/**
 * Extract quarterly 10-Q / 10-K values for a concept.
 * Returns an array of { period, value, filed } sorted by period desc.
 *
 * EDGAR companyfacts structure:
 *   facts['us-gaap'][concept].units['USD' | 'shares' | 'USD/shares'][...values]
 * Each value: { end, val, accn, fy, fp, form, filed }
 *   fp = 'Q1','Q2','Q3','FY'
 *   form = '10-Q' | '10-K'
 */
function extractQuarterly(facts, namespace, conceptNames) {
  for (const name of conceptNames) {
    const concept = facts?.[namespace]?.[name];
    if (!concept) continue;

    // Find the right unit (USD/shares for per-share metrics, USD for totals)
    const unitKeys = Object.keys(concept.units ?? {});
    for (const unit of unitKeys) {
      const entries = concept.units[unit];
      if (!Array.isArray(entries) || entries.length === 0) continue;

      // Filter to 10-Q and 10-K filings only; deduplicate by period end date.
      //
      // IMPORTANT: a single 10-Q frequently reports the SAME flow concept
      // (NII, dividends per share, EPS, etc.) twice for the same `end`
      // date — once as the single quarter (~3 months) and once as the
      // fiscal-year-to-date cumulative (6mo, 9mo). Both share `end` and
      // are usually filed in the same accession (identical `filed`
      // timestamp), so a naive "keep latest filed" dedup can silently
      // pick the multi-quarter cumulative value instead of the quarterly
      // one. That corrupted GBDC's Q2 FY2026 NII and dividend-per-share
      // (stored the 6-month YTD figures instead of the single quarter's).
      // Prefer entries whose duration is closest to one quarter (~90
      // days); instant facts (no `start`, e.g. NAV per share) have
      // duration 0 and are unaffected by this at all.
      const seen = new Map();
      for (const e of entries) {
        if (!['10-Q', '10-K'].includes(e.form)) continue;

        const durationDays = e.start
          ? (new Date(e.end) - new Date(e.start)) / 86400000
          : 0;
        const candidate = { period: e.end, value: e.val, filed: e.filed, firstFiled: e.filed, form: e.form, durationDays };

        const prior = seen.get(e.end);
        if (!prior) {
          seen.set(e.end, candidate);
          continue;
        }

        // `filed` on the winning fact is the LAST filing to mention this
        // period, because every 10-Q re-reports prior periods as
        // comparatives — ARCC's 2025-03-31 NAV carries filed=2026-04-28
        // from the following year's Q1. That's the right value (a restated
        // figure supersedes the original) but the wrong date for asking
        // "when did the market learn this?". Track the earliest filing that
        // carried the period separately; valuation snapshots need it to
        // avoid backdating NAV that nobody had seen yet.
        const firstFiled = prior.firstFiled < e.filed ? prior.firstFiled : e.filed;

        const priorIsQuarterly = prior.durationDays <= 100;
        const candidateIsQuarterly = durationDays <= 100;
        if (candidateIsQuarterly && !priorIsQuarterly) {
          seen.set(e.end, { ...candidate, firstFiled });
        } else if (candidateIsQuarterly === priorIsQuarterly && e.filed > prior.filed) {
          seen.set(e.end, { ...candidate, firstFiled });
        } else {
          prior.firstFiled = firstFiled;
        }
      }

      const result = [...seen.values()]
        .map(({ period, value, filed, firstFiled, form }) => ({ period, value, filed, firstFiled, form }))
        .sort((a, b) => b.period.localeCompare(a.period));
      if (result.length > 0) return { conceptName: name, unit, data: result };
    }
  }
  return null;
}

/**
 * Pull all XBRL-available metrics for a BDC.
 *
 * @param {string} cik
 * @returns {Promise<{
 *   navPerShare:    Array<{period, value, filed}> | null,
 *   niiPerShare:    Array<{period, value, filed}> | null,
 *   dividendPerShare: Array<{period, value, filed}> | null,
 *   totalAssets:    Array<{period, value, filed}> | null,
 *   conceptsUsed:   Record<string, string>   // which concept name was matched
 * }>}
 */
export async function fetchXBRLMetrics(cik) {
  const data = await fetchCompanyFacts(cik);
  const facts = data?.facts ?? {};

  const navResult       = extractQuarterly(facts, 'us-gaap', XBRL_CONCEPTS.navPerShare);
  const niiResult       = extractQuarterly(facts, 'us-gaap', XBRL_CONCEPTS.niiPerShare);
  const divResult       = extractQuarterly(facts, 'us-gaap', XBRL_CONCEPTS.dividendPerShare);
  const assetsResult    = extractQuarterly(facts, 'us-gaap', XBRL_CONCEPTS.totalAssets);
  const totalInvFVResult = extractQuarterly(facts, 'us-gaap', XBRL_CONCEPTS.totalInvestmentsFairValue);

  return {
    navPerShare:     navResult?.data     ?? null,
    niiPerShare:     niiResult?.data     ?? null,
    dividendPerShare: divResult?.data    ?? null,
    totalAssets:     assetsResult?.data  ?? null,
    totalInvestmentsFairValue: totalInvFVResult?.data ?? null,
    conceptsUsed: {
      navPerShare:     navResult?.conceptName     ?? null,
      niiPerShare:     niiResult?.conceptName     ?? null,
      dividendPerShare: divResult?.conceptName    ?? null,
      totalAssets:     assetsResult?.conceptName  ?? null,
      totalInvestmentsFairValue: totalInvFVResult?.conceptName ?? null,
    },
  };
}

/** Pick the fact tagged for `periodEnd`, or null. Unscoped = newest fact. */
function factForPeriod(series, periodEnd) {
  if (!series?.length) return null;
  if (periodEnd == null) return series[0];
  return series.find(f => f.period === periodEnd) ?? null;
}

/**
 * Get the XBRL facts belonging to ONE specific filing period.
 *
 * `periodEnd` is the report date of the filing being processed (e.g.
 * '2026-06-30'). Scoping to it matters because companyfacts is a
 * per-concept archive, not a per-filing snapshot: each concept's history
 * ends whenever that filer last tagged it, and those end dates differ
 * wildly between concepts for the same company. Taking `[0]` from each
 * series independently therefore silently mixes periods.
 *
 * Confirmed in production: CGBD's newest CommonStockDividendsPerShareDeclared
 * fact is Q1 2024 ($0.40) while its NAV is current, so the Q2 2026 row was
 * assembled from a two-year-old dividend and a current-quarter NII and
 * reported 88% dividend coverage — against an actual $0.35 dividend that
 * NII covered exactly. OCSL failed the same way through a single
 * instant-dated fact (2025-11-10, $0.40) carried into a quarter where it
 * actually paid $0.30 + $0.04 supplemental. Only 19 of the 46 BDCs in the
 * universe tag a dividend for their own latest period at all; the rest are
 * stale by 1-4 years or absent entirely. A flow fact that isn't tagged for
 * THIS period is not evidence about this period — return null and let the
 * metric stay empty, same principle as the NII/EPS note in constants.js.
 *
 * NAV is the deliberate exception. valuation_snapshots carries the last
 * reported NAV forward between filings by design (see schema.sql), and
 * EDGAR's companyfacts can lag a freshly filed 10-Q: ARCC's Q2 2026 10-Q
 * (report date 2026-06-30, filed 2026-07-29) still had no Q2 facts of any
 * kind, so period-scoping NAV would drop the largest BDC in the universe
 * out of the price/discount pipeline over a transient upstream lag. NAV
 * comes back with its own `navPeriod` so callers can see how stale it is.
 *
 * @param {string} cik
 * @param {string|null} periodEnd - filing report date, 'YYYY-MM-DD'
 * @returns {Promise<{nav, navPeriod, navHistory, nii, dividend,
 *                    totalInvestmentsFairValue, periodEnd,
 *                    outOfPeriod: Record<string,string>}>}
 */
export async function getLatestXBRLMetrics(cik, periodEnd = null) {
  const metrics = await fetchXBRLMetrics(cik);

  const nii = factForPeriod(metrics.niiPerShare, periodEnd);
  const div = factForPeriod(metrics.dividendPerShare, periodEnd);
  const fv  = factForPeriod(metrics.totalInvestmentsFairValue, periodEnd);
  const nav = metrics.navPerShare?.[0] ?? null;

  // Concepts the filer HAS tagged, but only for some other period. Reported
  // rather than silently dropped so a run log says why a metric came back
  // empty — "no dividend tagged for 2026-06-30, newest is 2024-03-31" is
  // actionable; a bare null looks indistinguishable from a fetch failure.
  const outOfPeriod = {};
  for (const [key, series, picked] of [
    ['nii',                       metrics.niiPerShare,               nii],
    ['dividend',                  metrics.dividendPerShare,          div],
    ['totalInvestmentsFairValue', metrics.totalInvestmentsFairValue, fv],
  ]) {
    if (!picked && series?.length) outOfPeriod[key] = series[0].period;
  }

  return {
    nav:       nav?.value  ?? null,
    navPeriod: nav?.period ?? null,
    // Full quarterly NAV series, carried out so valuation snapshots can be
    // stamped with the NAV that actually applied on each historical date
    // rather than today's. Comes free — it's already in the companyfacts
    // blob we just downloaded, so exposing it costs no extra request.
    navHistory: metrics.navPerShare ?? [],
    nii:       nii?.value  ?? null,
    dividend:  div?.value  ?? null,
    totalInvestmentsFairValue: fv?.value ?? null,
    periodEnd: periodEnd ?? nav?.period ?? null,
    outOfPeriod,
  };
}

// ─── PIK income ──────────────────────────────────────────────────────────────

/**
 * PIK income concepts, split by role. Getting this split right is the whole
 * job — the names are close enough that mixing them produces silent errors.
 *
 * NUMERATOR concepts are DOLLARS of payment-in-kind income for the period.
 * Explicitly NOT included:
 *
 *   InvestmentInterestRatePaidInKind  a RATE (e.g. 2.50), not an amount.
 *                                     Averaging or summing it is meaningless.
 *   PaidInKindInterest / DividendsPaidinkind
 *                                     cash-flow-statement non-cash add-backs,
 *                                     not investment-income line items.
 *
 * This replaces a text regex — /(?:pik|payment.in.kind)[^.]*?(\d+\.?\d*)\s*%/ —
 * that took the first percentage after the first "PIK" anywhere in the
 * document. Because "PIK" appears on nearly every row of a Schedule of
 * Investments as part of a coupon ("SOFR + 5.00%, 2.50% PIK"), what it
 * actually captured was an interest rate, not an income share. Verified
 * against real filings it returned: ARCC 5.75 (a SOFR spread), CGBD 9.85
 * (an all-in rate), MSDL 9.92 (an interest rate), GSBD 232.7 ("Debt
 * Investments - 232.7%", a percent-of-net-assets heading), NSLR 90 (the
 * RIC distribution requirement) and PSEC 25.00 ("greater than 25.00%
 * voting control"). Not one value in the universe was a PIK income share.
 */
const PIK_COMBINED = 'InterestAndDividendIncomeOperatingPaidInKind';
const PIK_INTEREST = 'InterestIncomeOperatingPaidInKind';
const PIK_DIVIDEND = 'DividendIncomeOperatingPaidInKind';

// Denominator: total investment income for the period.
const TOTAL_INCOME          = 'GrossInvestmentIncomeOperating';
const TOTAL_INCOME_FALLBACK = 'InvestmentIncomeNet';
const NET_INVESTMENT_INCOME = 'NetInvestmentIncome';

// A single quarter is ~91 days. Anything longer is a fiscal-year-to-date
// cumulative that a 10-Q reports alongside the quarter (see extractQuarterly);
// mixing a YTD numerator with a quarterly denominator would overstate PIK by
// 2-3x. Instants (duration 0) are balance-sheet facts and never income.
const isSingleQuarter = days => days > 60 && days <= 100;

/** USD duration facts for one concept, single-quarter only, newest filing wins. */
function quarterlyUsd(facts, name) {
  const entries = facts?.['us-gaap']?.[name]?.units?.USD;
  if (!Array.isArray(entries)) return new Map();
  const byEnd = new Map();
  for (const e of entries) {
    if (!['10-Q', '10-K'].includes(e.form) || !e.start) continue;
    if (!isSingleQuarter((new Date(e.end) - new Date(e.start)) / 86400000)) continue;
    // Dimensional breakdowns (per-segment members) carry the same end date as
    // the consolidated total; companyfacts omits the member axis, so the only
    // defence is taking the latest-filed fact per period rather than summing.
    const prior = byEnd.get(e.end);
    if (!prior || e.filed > prior.filed) byEnd.set(e.end, { val: e.val, filed: e.filed });
  }
  return byEnd;
}

/**
 * PIK income as a percentage of total investment income, for a period and
 * the quarter before it.
 *
 * The prior quarter is the point of this: scorePIK needs BOTH quarters to
 * judge the trend, and `pik_income_prior_pct` was never populated by any
 * code path, so the PIK component — 20% of the model weight — could not
 * score for a single BDC in the universe. It comes free here, since the
 * whole companyfacts blob is already in hand.
 *
 * @param {object} facts - the `facts` object from companyfacts
 * @param {string|null} periodEnd - 'YYYY-MM-DD'; null = newest available
 * @returns {{pct, priorPct, period, priorPeriod, numeratorUsd, totalUsd, source, note}}
 */
export function computePikIncome(facts, periodEnd = null) {
  const combined = quarterlyUsd(facts, PIK_COMBINED);
  const interest = quarterlyUsd(facts, PIK_INTEREST);
  const dividend = quarterlyUsd(facts, PIK_DIVIDEND);
  let total      = quarterlyUsd(facts, TOTAL_INCOME);
  let totalSource = TOTAL_INCOME;

  if (total.size === 0) {
    // Guarded fallback. `InvestmentIncomeNet` is ambiguously named — for some
    // filers it is gross investment income, for others it would be the net
    // figure — so it is only trusted where NetInvestmentIncome also exists
    // for the same period and is SMALLER, which proves the fact really is
    // the gross line. Without that check this silently divides by a
    // post-expense number and roughly doubles every PIK percentage.
    const candidate = quarterlyUsd(facts, TOTAL_INCOME_FALLBACK);
    const net = quarterlyUsd(facts, NET_INVESTMENT_INCOME);
    const verified = new Map();
    for (const [end, fact] of candidate) {
      const n = net.get(end);
      if (n && fact.val > n.val) verified.set(end, fact);
    }
    total = verified;
    totalSource = `${TOTAL_INCOME_FALLBACK} (verified > ${NET_INVESTMENT_INCOME})`;
  }

  const numeratorFor = end => {
    // Combined tag already includes dividend PIK — adding the separate
    // concepts on top would double-count.
    if (combined.has(end)) return { usd: combined.get(end).val, source: 'combined' };
    const i = interest.get(end);
    if (!i) {
      // Dividend PIK alone is not a usable numerator: it is the small
      // component. BCSF's 2026-06-30 tags only DividendIncomeOperatingPaidInKind
      // ($0.7M) while the interest component ($7.4M the prior quarter) is
      // absent, so summing what's present would report 1.1% against a real
      // figure near 12%. Report nothing instead of a 10x undercount.
      return dividend.has(end)
        ? { usd: null, source: 'dividend-only', note: 'interest PIK not tagged for this period — dividend PIK alone would understate' }
        : { usd: null, source: 'none' };
    }
    const d = dividend.get(end);
    return { usd: i.val + (d?.val ?? 0), source: d ? 'interest+dividend' : 'interest' };
  };

  const pctFor = end => {
    if (!end) return { pct: null };
    const t = total.get(end);
    const n = numeratorFor(end);
    if (!t || t.val <= 0 || n.usd == null) return { pct: null, ...n };
    return { pct: parseFloat(((n.usd / t.val) * 100).toFixed(3)), numeratorUsd: n.usd, totalUsd: t.val, ...n };
  };

  // Period ends that have a denominator, newest first.
  const ends = [...total.keys()].sort().reverse();
  const period = periodEnd && total.has(periodEnd) ? periodEnd : (periodEnd ? null : ends[0] ?? null);
  const priorPeriod = period ? ends.find(e => e < period) ?? null : null;

  const current = pctFor(period);
  const prior   = pctFor(priorPeriod);

  return {
    pct:          current.pct ?? null,
    priorPct:     prior.pct ?? null,
    period,
    priorPeriod,
    numeratorUsd: current.numeratorUsd ?? null,
    totalUsd:     current.totalUsd ?? null,
    source:       current.source ?? 'none',
    totalSource,
    note:         current.note ?? null,
  };
}

/** Convenience wrapper: fetch companyfacts and compute PIK for a period. */
export async function getPikIncome(cik, periodEnd = null) {
  const data = await fetchCompanyFacts(cik);
  return computePikIncome(data?.facts ?? {}, periodEnd);
}
