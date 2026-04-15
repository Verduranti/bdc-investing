/**
 * Schedule of Investments Parser
 *
 * Extracts non-accrual %, PIK income %, and sector exposure from the
 * Schedule of Investments (SOI) table inside a 10-Q or 10-K HTML filing.
 *
 * The hard reality: every BDC formats their SOI differently. This file
 * contains a generic extractor + per-BDC overrides. Expect to tune these
 * as new filings come in — that's normal for this kind of parsing.
 *
 * Strategy:
 *   1. Try to find the SOI table (look for "Schedule of Investments" heading)
 *   2. Parse the HTML table rows with cheerio
 *   3. Aggregate by industry/sector to compute sector exposure %
 *   4. Look for explicit non-accrual and PIK flagging in the notes
 *
 * For now, most of these fields will come from the mock data / manual entry
 * while you build out the per-BDC parsers. The stub structure here shows
 * how to wire in real parsing without changing the calling code.
 */

import * as cheerio from 'cheerio';

/**
 * Main entry point. Returns a partial portfolio_metrics + sector_exposure
 * object, or null fields where extraction failed.
 *
 * @param {string} html - raw HTML of the filing primary document
 * @param {string} ticker
 * @returns {{ portfolioMetrics: object, sectorExposure: object, notes: string[] }}
 */
export function parseScheduleOfInvestments(html, ticker) {
  const $ = cheerio.load(html);
  const notes = [];

  // ── Find SOI table ───────────────────────────────────────────
  // BDCs label it "Schedule of Investments" or "Consolidated Schedule"
  let soiTable = null;

  $('table').each((_, table) => {
    // Look for a nearby heading or the first row containing SOI keywords
    const tableText = $(table).text();
    if (/schedule\s+of\s+investments/i.test(tableText)) {
      soiTable = table;
      return false; // break
    }
  });

  if (!soiTable) {
    notes.push('SOI table not found — check filing format');
    return { portfolioMetrics: {}, sectorExposure: {}, notes };
  }

  // ── Parse rows ───────────────────────────────────────────────
  const rows = [];
  $(soiTable).find('tr').each((_, tr) => {
    const cells = $(tr).find('td,th').map((_, td) => $(td).text().trim()).get();
    if (cells.length > 0) rows.push(cells);
  });

  // ── Sector aggregation ───────────────────────────────────────
  // BDCs group rows by industry header. We accumulate fair value by sector.
  const sectorTotals = {};
  let totalFairValue = 0;
  let currentSector = 'Other';

  const SECTOR_MAP = {
    software:    /software|technology|tech|saas|internet|cloud/i,
    healthcare:  /health|pharma|medical|biotech|life science/i,
    consumer:    /consumer|retail|food|restaurant|beverage|apparel/i,
    industrial:  /industrial|manufacturing|logistics|transport|aerospace|defense/i,
    assetBacked: /asset.backed|structured|abs|clo|real estate/i,
    financial:   /financial|insurance|bank|lending|credit/i,
  };

  function classifySector(label) {
    for (const [key, re] of Object.entries(SECTOR_MAP)) {
      if (re.test(label)) return key;
    }
    return 'other';
  }

  for (const row of rows) {
    const firstCell = row[0] ?? '';

    // Detect sector header rows (typically all-caps or bold, single cell)
    if (row.length <= 2 && firstCell.length > 3 && firstCell === firstCell.toUpperCase()) {
      currentSector = classifySector(firstCell);
      continue;
    }

    // Try to parse a fair value from the last numeric cell
    const lastNumeric = [...row].reverse().find(c => /^\$?[\d,]+(\.\d+)?$/.test(c.replace(/\s/g, '')));
    if (lastNumeric) {
      const fv = parseFloat(lastNumeric.replace(/[$,]/g, ''));
      if (!isNaN(fv) && fv > 0) {
        sectorTotals[currentSector] = (sectorTotals[currentSector] ?? 0) + fv;
        totalFairValue += fv;
      }
    }
  }

  // Convert to percentages
  const sectorExposure = {};
  if (totalFairValue > 0) {
    for (const [sector, fv] of Object.entries(sectorTotals)) {
      sectorExposure[`${sector}_pct`] = parseFloat(((fv / totalFairValue) * 100).toFixed(3));
    }
  }

  // ── Non-accrual detection ────────────────────────────────────
  // BDCs footnote non-accrual loans. Look for the annotation in text.
  let nonAccrualCostPct  = null;
  let nonAccrualFVPct    = null;

  const bodyText = $('body').text();

  // Pattern: "non-accrual investments... $X... representing Y% of..."
  const naMatch = bodyText.match(
    /non.accrual[^.]*?(\d+\.?\d*)\s*%\s*(?:of\s+)?(?:total\s+)?(?:investments?\s+at\s+)?(?:fair\s+value)?/i
  );
  if (naMatch) {
    nonAccrualFVPct = parseFloat(naMatch[1]);
    notes.push(`Non-accrual FV% extracted from text: ${nonAccrualFVPct}`);
  }

  // ── PIK detection ────────────────────────────────────────────
  // Look for "PIK" or "payment-in-kind" income disclosure
  let pikIncomePct = null;

  const pikMatch = bodyText.match(
    /(?:pik|payment.in.kind)[^.]*?(\d+\.?\d*)\s*%/i
  );
  if (pikMatch) {
    pikIncomePct = parseFloat(pikMatch[1]);
    notes.push(`PIK% extracted from text: ${pikIncomePct}`);
  }

  // ── Per-BDC overrides ────────────────────────────────────────
  // Some BDCs have consistent patterns we can be more precise about.
  // Add ticker-specific logic here as you tune each one.
  // Example: ARCC has a dedicated "Non-Accrual Investments" table.

  if (ticker === 'ARCC') {
    // ARCC publishes a dedicated non-accrual table — look for it
    $('table').each((_, table) => {
      const text = $(table).text();
      if (/non.accrual/i.test(text) && /fair\s+value/i.test(text)) {
        // TODO: extract percentage from ARCC-specific table format
        notes.push('ARCC non-accrual table found — implement specific parser');
        return false;
      }
    });
  }

  return {
    portfolioMetrics: {
      non_accrual_fv_pct:  nonAccrualFVPct,
      non_accrual_cost_pct: nonAccrualCostPct,
      pik_income_pct:      pikIncomePct,
      data_source:         'parsed',
    },
    sectorExposure: Object.keys(sectorExposure).length > 0
      ? { ...sectorExposure, data_source: 'parsed' }
      : {},
    notes,
  };
}
