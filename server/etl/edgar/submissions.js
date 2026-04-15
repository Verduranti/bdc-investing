/**
 * EDGAR Submissions Fetcher
 *
 * Uses the EDGAR Data API to fetch a company's full filing history.
 * Returns the N most recent filings of a given form type (10-Q, 10-K, 4).
 *
 * API docs: https://www.sec.gov/developers
 * Rate limit: 10 req/sec — enforced by the shared rateLimited() wrapper.
 */

import { EDGAR_BASE, EDGAR_USER_AGENT, EDGAR_RATE_LIMIT_MS } from '../constants.js';

// Simple rate-limiter: ensures at least EDGAR_RATE_LIMIT_MS between calls.
let _lastCall = 0;
async function rateLimited(fn) {
  const now = Date.now();
  const wait = EDGAR_RATE_LIMIT_MS - (now - _lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCall = Date.now();
  return fn();
}

async function edgarGet(url) {
  return rateLimited(async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': EDGAR_USER_AGENT },
    });
    if (!res.ok) throw new Error(`EDGAR ${res.status}: ${url}`);
    return res.json();
  });
}

/**
 * Fetch the submissions JSON for a CIK.
 * Handles pagination via the 'files' array for companies with > 1000 filings.
 */
export async function fetchSubmissions(cik) {
  const padded = cik.replace(/^0+/, '').padStart(10, '0');
  const data = await edgarGet(`${EDGAR_BASE}/submissions/CIK${padded}.json`);

  let allFilings = {
    accessionNumber: [...(data.filings?.recent?.accessionNumber ?? [])],
    filingDate:      [...(data.filings?.recent?.filingDate ?? [])],
    form:            [...(data.filings?.recent?.form ?? [])],
    primaryDocument: [...(data.filings?.recent?.primaryDocument ?? [])],
    reportDate:      [...(data.filings?.recent?.reportDate ?? [])],
  };

  // Paginate if there are more filings
  for (const file of (data.filings?.files ?? [])) {
    const page = await edgarGet(`${EDGAR_BASE}/submissions/${file.name}`);
    const r = page.filings?.recent ?? page;
    allFilings.accessionNumber.push(...(r.accessionNumber ?? []));
    allFilings.filingDate.push(...(r.filingDate ?? []));
    allFilings.form.push(...(r.form ?? []));
    allFilings.primaryDocument.push(...(r.primaryDocument ?? []));
    allFilings.reportDate.push(...(r.reportDate ?? []));
  }

  return { cik: padded, name: data.name, filings: allFilings };
}

/**
 * Return the N most recent filings of the given form types.
 *
 * @param {string} cik
 * @param {string[]} formTypes - e.g. ['10-Q', '10-K']
 * @param {number} limit
 * @returns {Promise<Array<{accessionNumber, filingDate, form, primaryDocument, reportDate, docUrl}>>}
 */
export async function getRecentFilings(cik, formTypes = ['10-Q', '10-K'], limit = 8) {
  const { cik: padded, filings } = await fetchSubmissions(cik);
  const numericCik = padded.replace(/^0+/, '');

  const results = [];
  for (let i = 0; i < filings.accessionNumber.length; i++) {
    if (!formTypes.includes(filings.form[i])) continue;

    const accNo = filings.accessionNumber[i];
    const accNoDashes = accNo.replace(/-/g, '');
    const primaryDoc  = filings.primaryDocument[i];
    const docUrl = `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accNoDashes}/${primaryDoc}`;

    results.push({
      accessionNumber: accNo,
      filingDate:      filings.filingDate[i],
      form:            filings.form[i],
      primaryDocument: primaryDoc,
      reportDate:      filings.reportDate[i],
      docUrl,
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Fetch the raw HTML of a filing document.
 * Used by the schedule-of-investments parser.
 */
export async function fetchFilingDocument(url) {
  return rateLimited(async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': EDGAR_USER_AGENT },
    });
    if (!res.ok) throw new Error(`Failed to fetch document: ${res.status} ${url}`);
    return res.text();
  });
}
