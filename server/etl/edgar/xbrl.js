/**
 * EDGAR XBRL Fetcher
 *
 * Pulls structured financial facts from the EDGAR companyfacts endpoint.
 * Returns NAV per share, NII per share, and dividend per share history
 * by quarter — these are the fields that ARE available in XBRL for BDCs.
 *
 * Non-accruals, PIK %, and sector exposure are NOT in XBRL and require
 * document parsing (see scheduleParser.js).
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
        const candidate = { period: e.end, value: e.val, filed: e.filed, form: e.form, durationDays };

        const prior = seen.get(e.end);
        if (!prior) {
          seen.set(e.end, candidate);
          continue;
        }

        const priorIsQuarterly = prior.durationDays <= 100;
        const candidateIsQuarterly = durationDays <= 100;
        if (candidateIsQuarterly && !priorIsQuarterly) {
          seen.set(e.end, candidate);
        } else if (candidateIsQuarterly === priorIsQuarterly && e.filed > prior.filed) {
          seen.set(e.end, candidate);
        }
      }

      const result = [...seen.values()]
        .map(({ period, value, filed, form }) => ({ period, value, filed, form }))
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
 * @returns {Promise<{nav, navPeriod, nii, dividend, totalInvestmentsFairValue,
 *                    periodEnd, outOfPeriod: Record<string,string>}>}
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
    nii:       nii?.value  ?? null,
    dividend:  div?.value  ?? null,
    totalInvestmentsFairValue: fv?.value ?? null,
    periodEnd: periodEnd ?? nav?.period ?? null,
    outOfPeriod,
  };
}
