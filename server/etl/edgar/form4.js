/**
 * Form 4 Insider Trade Parser
 *
 * Fetches Form 4 filings from EDGAR for a given CIK and parses the XML
 * into structured insider trade records.
 *
 * Form 4 XML structure:
 *   <ownershipDocument>
 *     <issuer>...</issuer>
 *     <reportingOwner>
 *       <reportingOwnerId><rptOwnerName>, <rptOwnerCik></rptOwnerCik>
 *       <reportingOwnerRelationship><officerTitle>, <isDirector>, <isOfficer>
 *     </reportingOwner>
 *     <nonDerivativeTable>
 *       <nonDerivativeTransaction>
 *         <transactionDate><value>
 *         <transactionAmounts>
 *           <transactionShares><value>
 *           <transactionPricePerShare><value>
 *           <transactionAcquiredDisposedCode><value>  (A=buy, D=sell)
 *         <postTransactionAmounts><sharesOwnedFollowingTransaction>
 *         <ownershipNature><directOrIndirectOwnership><value>  (D=direct, I=indirect)
 *       </nonDerivativeTransaction>
 *     </nonDerivativeTable>
 *   </ownershipDocument>
 */

import { getRecentFilings, fetchFilingDocument } from './submissions.js';
import { EDGAR_USER_AGENT } from '../constants.js';

/** Pull a text node from XML string by tag name. */
function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>\\s*<value>([^<]+)<\\/value>`, 'i'))
    ?? xml.match(new RegExp(`<${tag}[^>]*>([^<]+)<\\/tag>`, 'i'));
  if (m) return m[1].trim();

  // Try simpler direct content
  const m2 = xml.match(new RegExp(`<${tag}>([^<]+)<\\/${tag}>`, 'i'));
  return m2 ? m2[1].trim() : null;
}

/** Extract all occurrences of a block tag. */
function xmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi');
  return [...xml.matchAll(re)].map(m => m[0]);
}

/**
 * Parse a Form 4 XML document into a structured trade record.
 */
function parseForm4XML(xml, accessionNumber, filedAt) {
  const trades = [];

  // Reporting owner info
  const ownerName  = xmlText(xml, 'rptOwnerName') ?? 'Unknown';
  const ownerTitle = xmlText(xml, 'officerTitle') ?? '';

  // Parse non-derivative transactions (direct stock purchases/sales)
  const txBlocks = xmlBlocks(xml, 'nonDerivativeTransaction');

  // A single Form 4 routinely reports several transactions under one
  // accession_number (e.g. multiple open-market buys on different dates) —
  // accession_number alone identifies the FILING, not a transaction within
  // it, so it can't be the row's uniqueness key on its own. transactionIndex
  // pairs with it to give each transaction row a stable identity.
  let transactionIndex = 0;
  for (const block of txBlocks) {
    const dateStr   = xmlText(block, 'transactionDate');
    const sharesStr = xmlText(block, 'transactionShares');
    const priceStr  = xmlText(block, 'transactionPricePerShare');
    const adCode    = xmlText(block, 'transactionAcquiredDisposedCode');
    const direct    = xmlText(block, 'directOrIndirectOwnership');

    const shares = parseFloat(sharesStr ?? '0');
    const price  = parseFloat(priceStr  ?? '0');
    if (!dateStr || shares === 0) continue;

    trades.push({
      accession_number: accessionNumber,
      transaction_index: transactionIndex++,
      transaction_date: dateStr,
      filed_at:         filedAt,
      trade_type:       adCode === 'A' ? 'buy' : 'sell',
      shares:           Math.round(shares),
      price_per_share:  price,
      insider_name:     ownerName,
      insider_title:    ownerTitle,
      is_direct:        direct === 'D',
      raw_xml:          xml,
    });
  }

  return trades;
}

/**
 * Fetch and parse all Form 4 filings for a CIK from the last N days.
 *
 * @param {string} cik
 * @param {number} limit - max filings to process (default 20)
 * @returns {Promise<Array>} parsed trade records
 */
export async function fetchInsiderTrades(cik, limit = 20) {
  const filings = await getRecentFilings(cik, ['4'], limit);
  const allTrades = [];

  for (const filing of filings) {
    try {
      // EDGAR's `primaryDocument` for Form 3/4/5 is the XSLT-rendered
      // human-viewer path — e.g. "xslF345X05/tm265470-5_4seq1.xml" — which
      // despite the .xml extension serves rendered HTML, not the
      // <ownershipDocument> XML. Confirmed against a real ARCC filing: that
      // URL returns an HTML page with no ownershipDocument tag at all, so
      // parseForm4XML silently found zero <nonDerivativeTransaction> blocks
      // for every filing, for every BDC, forever. The old fallback here only
      // swapped a .htm/.html extension for .xml, which no-ops on a URL that
      // already ends in .xml and just refetches the same broken page. The
      // real raw XML lives one directory up, without the xsl*/ viewer
      // subdirectory — stripping it is what actually reaches the data.
      const rawXmlUrl = filing.docUrl.replace(/\/xsl[^/]+\//, '/');
      const xml = await fetchFilingDocument(rawXmlUrl);
      const trades = parseForm4XML(xml, filing.accessionNumber, filing.filingDate);
      allTrades.push(...trades);
    } catch (err) {
      // Non-fatal: log and continue
      console.warn(`  Form 4 parse failed for ${filing.accessionNumber}: ${err.message}`);
    }
  }

  return allTrades;
}
