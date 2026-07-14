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

import { EDGAR_BASE, EDGAR_USER_AGENT, EDGAR_RATE_LIMIT_MS, XBRL_CONCEPTS } from '../constants.js';

let _lastCall = 0;
async function rateLimited(fn) {
  const now = Date.now();
  const wait = EDGAR_RATE_LIMIT_MS - (now - _lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCall = Date.now();
  return fn();
}

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

  return {
    navPerShare:     navResult?.data     ?? null,
    niiPerShare:     niiResult?.data     ?? null,
    dividendPerShare: divResult?.data    ?? null,
    totalAssets:     assetsResult?.data  ?? null,
    conceptsUsed: {
      navPerShare:     navResult?.conceptName     ?? null,
      niiPerShare:     niiResult?.conceptName     ?? null,
      dividendPerShare: divResult?.conceptName    ?? null,
      totalAssets:     assetsResult?.conceptName  ?? null,
    },
  };
}

/**
 * Get the most recent NAV per share and NII per share for a BDC.
 * Convenience wrapper used by the scoring engine.
 *
 * @param {string} cik
 * @returns {Promise<{nav: number|null, nii: number|null, dividend: number|null, periodEnd: string|null}>}
 */
export async function getLatestXBRLMetrics(cik) {
  const metrics = await fetchXBRLMetrics(cik);
  return {
    nav:       metrics.navPerShare?.[0]?.value      ?? null,
    nii:       metrics.niiPerShare?.[0]?.value      ?? null,
    dividend:  metrics.dividendPerShare?.[0]?.value ?? null,
    periodEnd: metrics.navPerShare?.[0]?.period     ?? null,
  };
}
