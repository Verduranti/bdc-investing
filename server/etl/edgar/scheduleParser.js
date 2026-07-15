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
  const SOI_HEADING_RE = /schedule\s+of\s+investments/i;

  $('table').each((_, table) => {
    const $table = $(table);

    // First check the table's own text (catches cases where the heading
    // is literally a header row inside the table).
    if (SOI_HEADING_RE.test($table.text())) {
      soiTable = table;
      return false; // break
    }

    // More common in practice: the heading is its own paragraph/heading
    // element immediately BEFORE the table (e.g. "Golub Capital BDC, Inc.
    // and Subsidiaries / Consolidated Schedule of Investments (unaudited)"
    // as plain text right above the table), not inside the table's own
    // markup at all — so $table.text() alone misses it. Walk back through
    // up to a few preceding siblings looking for that heading text.
    let $prev = $table.prev();
    for (let i = 0; i < 6 && $prev.length; i++) {
      if (SOI_HEADING_RE.test($prev.text())) {
        soiTable = table;
        return false;
      }
      $prev = $prev.prev();
    }
  });

  // NOTE: this used to `return` immediately when no SOI table was found,
  // which also skipped the non-accrual/PIK text extraction below — even
  // though that extraction runs against the whole document body and has
  // nothing to do with whether the SOI table itself was located. That
  // early return silently zeroed out non-accrual/PIK data for every BDC
  // whose SOI table doesn't match the heading heuristic (very common —
  // BDCs typically put "Consolidated Schedule of Investments" in a
  // heading/paragraph immediately BEFORE the table, not inside the
  // table's own cell text, so `$(table).text()` rarely contains it).
  // Sector aggregation genuinely does need the table, so that part still
  // no-ops when soiTable is null — but non-accrual/PIK now always run.
  if (!soiTable) {
    notes.push('SOI table not found — check filing format (sector exposure unavailable, non-accrual/PIK still attempted from document text)');
  }

  // ── Parse rows ───────────────────────────────────────────────
  const rows = [];
  if (soiTable) {
    $(soiTable).find('tr').each((_, tr) => {
      const cells = $(tr).find('td,th').map((_, td) => $(td).text().trim()).get();
      if (cells.length > 0) rows.push(cells);
    });
  }

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
