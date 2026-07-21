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
 * @param {number|null} totalInvestmentsFairValueUSD - total portfolio FV in
 *   absolute dollars, sourced from XBRL (see xbrl.js). Used as the
 *   denominator for markdown %/realized-loss %. Passing this in from a
 *   structured XBRL fact — rather than deriving it by summing SOI table
 *   cells here — matters: the SOI table's rows commonly end with a "% of
 *   Net Assets" column, and a naive "last numeric cell" scrape silently
 *   sums THAT column instead of fair value, producing a denominator of
 *   ~100 instead of the true multi-billion-dollar total (confirmed via a
 *   real BBDC filing, where this previously produced qoq_markdown_pct of
 *   -659%). Do not reintroduce that pattern here.
 * @returns {{ portfolioMetrics: object, sectorExposure: object, notes: string[] }}
 */
export function parseScheduleOfInvestments(html, ticker, totalInvestmentsFairValueUSD = null) {
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

  // ── Document dollar scale ───────────────────────────────────
  // BDCs almost universally caption their financial statements
  // "(Dollar amounts in thousands)" or "...in millions" near the top of
  // the document. Individual MD&A sentences ("net realized losses of
  // $12.3 million") frequently state their own unit explicitly, which
  // overrides this document-level default when present.
  function detectDocumentScale(text) {
    if (/dollars?\s*(?:and\s+shares?\s*)?(?:amounts?\s*)?in\s+thousands/i.test(text)) return 1_000;
    if (/dollars?\s*(?:and\s+shares?\s*)?(?:amounts?\s*)?in\s+millions/i.test(text)) return 1_000_000;
    return 1_000;
  }
  const documentScale = detectDocumentScale(bodyText.slice(0, 5000));

  // Converts a matched dollar token (may include leading "$" and/or
  // wrapping parens, e.g. "(8,150)" or "$12.3") + optional inline unit
  // qualifier ("million"/"thousand") into absolute dollars, always as a
  // positive magnitude — callers apply sign separately based on the
  // paren check, so stripping parens here (rather than leaving them to
  // confuse parseFloat, which returns NaN on a string like "(8150)")
  // must not also flip the sign a second time.
  function toAbsoluteDollars(rawToken, unitStr) {
    const raw = parseFloat(rawToken.replace(/[$,()]/g, ''));
    if (isNaN(raw)) return null;
    const magnitude = Math.abs(raw);
    if (/million/i.test(unitStr ?? '')) return magnitude * 1_000_000;
    if (/thousand/i.test(unitStr ?? '')) return magnitude * 1_000;
    return magnitude * documentScale;
  }

  // ── Realized losses / unrealized markdown (text) ────────────
  // Real filings present these as Statement-of-Operations table rows
  // (e.g. "Net realized gains (losses) on investments  (8,150)  (17,731)"
  // for a two-column comparative period, no "of" connector, sign carried
  // by parens) at least as often as narrative MD&A prose ("...losses of
  // $12.3 million..."). The regex below has to match both: it doesn't
  // require "of", allows a bounded run of non-numeric filler between the
  // label and the number, and determines sign purely from whether the
  // matched number itself is parenthesized — not from the label words
  // ("gains (losses)" / "appreciation (depreciation)" are combined
  // headers in tabular form and don't reliably indicate the actual sign).
  // In a standard SEC comparative table the current period is the first
  // (leftmost) column, so the first number encountered after the label
  // is taken as the current-period figure.
  let qoqMarkdownPct = null;
  let trailingRealizedLossesPct = null;

  // Group 1 captures the FULL token including any wrapping paren, so
  // callers can detect sign from the token itself (`token.includes('(')`)
  // rather than losing that information to the regex's own non-capturing
  // paren markers. The leading symbol class allows "$" and "(" in EITHER
  // order — real filings render negatives as both "$(8,150)" and
  // "($8,150)" depending on the filer's table template, and assuming one
  // fixed order silently fails to match the other (caught this against a
  // synthetic "$(0.10)" NII figure, which the paren-first assumption in
  // an earlier draft of this regex missed entirely).
  const DOLLAR_RE = '([\\(\\$]{0,2}-?[\\d,]+\\.?\\d*\\)?)\\s*(million|thousand)?';

  // Filler between the label and the number excludes "(" and ")" as well
  // as digits/"$" — otherwise a greedy [^0-9$]{0,120} would consume the
  // number's OWN leading paren (since "(" is neither a digit nor "$"),
  // leaving DOLLAR_RE to match only the trailing ")" and silently losing
  // the sign. Caught this by testing against a real parenthesized figure
  // ("(8,150)" was read as a positive gain instead of a loss) — worth
  // flagging because it's the same class of bug (silently-wrong sign)
  // this whole investigation started over.
  const realizedMatch = bodyText.match(
    new RegExp(`net\\s+realized\\s+(?:gains?|losses?)(?:\\s*\\(losses?\\)|\\s*\\(gains?\\))?[^0-9$()]{0,120}${DOLLAR_RE}`, 'i')
  );
  const markdownMatch = bodyText.match(
    new RegExp(`net\\s+(?:change\\s+in\\s+)?unrealized\\s+(?:appreciation|depreciation)(?:\\s*\\(depreciation\\)|\\s*\\(appreciation\\))?[^0-9$()]{0,120}${DOLLAR_RE}`, 'i')
  );

  // Two independent labels that happen to resolve to the exact same
  // number strongly suggest the two regexes latched onto the same
  // sentence/figure (seen on NMFC in production: both matched a combined
  // "net realized and unrealized losses" line, writing the identical
  // magnitude into both fields). Treat that as a collision, not two real
  // data points — better to report one field missing than fabricate a
  // second copy of the same figure under the wrong label.
  const collision = realizedMatch && markdownMatch &&
    realizedMatch[1].replace(/[,()]/g, '') === markdownMatch[1].replace(/[,()]/g, '');

  if (realizedMatch && totalInvestmentsFairValueUSD && !collision) {
    const raw = realizedMatch[1];
    const isNegative = raw.includes('(') || raw.trim().startsWith('-');
    const absDollars = toAbsoluteDollars(raw, realizedMatch[2]);
    if (absDollars != null) {
      // Positive magnitude only — a net realized GAIN (positive figure)
      // means zero losses, not a negative "loss" number.
      const magnitude = isNegative ? Math.abs(absDollars) : 0;
      trailingRealizedLossesPct = parseFloat(((magnitude / totalInvestmentsFairValueUSD) * 100).toFixed(3));
      notes.push(`Realized ${isNegative ? 'loss' : 'gain'} extracted from text: $${absDollars.toLocaleString()} → ${trailingRealizedLossesPct}% of portfolio FV`);
    }
  }

  if (markdownMatch && totalInvestmentsFairValueUSD && !collision) {
    const raw = markdownMatch[1];
    const isNegative = raw.includes('(') || raw.trim().startsWith('-');
    const absDollars = toAbsoluteDollars(raw, markdownMatch[2]);
    if (absDollars != null) {
      // Signed: negative = net markdown, positive = net markup — matches
      // ALERT_THRESHOLDS.markdownMaterial (-1.0) convention in constants.js.
      const signedDollars = isNegative ? -Math.abs(absDollars) : Math.abs(absDollars);
      qoqMarkdownPct = parseFloat(((signedDollars / totalInvestmentsFairValueUSD) * 100).toFixed(3));
      notes.push(`Unrealized ${isNegative ? 'depreciation' : 'appreciation'} extracted from text: $${absDollars.toLocaleString()} → ${qoqMarkdownPct}% of portfolio FV`);
    }
  }

  if (collision) {
    notes.push(`Realized-loss and markdown regexes both matched the same figure ($${realizedMatch[1]}) — likely a combined "realized and unrealized" line; skipped both rather than duplicate the number under two labels`);
  }
  if ((realizedMatch || markdownMatch) && !totalInvestmentsFairValueUSD && !collision) {
    notes.push('Realized-loss/markdown dollar figures found in text but no XBRL total investments FV available to compute a percentage — skipped');
  }

  // ── NII per share (text) ─────────────────────────────────────
  // XBRL tagging of net investment income per share is inconsistent
  // across filers (see xbrl.js — many BDCs don't tag a standard concept
  // at all, or repurpose EarningsPerShareBasic/Diluted with a custom
  // "net investment income per share" label, which is indistinguishable
  // via the companyconcept API from filers where that same concept means
  // full GAAP EPS including gains/losses — that ambiguity is exactly why
  // EPS was deliberately excluded as an NII fallback in constants.js).
  // Real Statement-of-Operations rows render as e.g. "Net investment
  // income per share, basic and diluted  $ 0.25  $ 0.25" — no "of"
  // connector — so, like the realized/markdown matches above, this can't
  // require "of" between the label and the figure.
  let niiPerShare = null;
  const niiMatch = bodyText.match(
    /net\s+investment\s+income(?:\s*\(loss\))?[^0-9$()]{0,80}per\s+(?:common\s+)?share[^0-9$()]{0,40}([\(\$]{0,2}-?[\d,]+\.\d+\)?)/i
  );
  if (niiMatch) {
    const token = niiMatch[1].trim();
    niiPerShare = parseFloat(token.replace(/[$,()]/g, ''));
    // Sign is determined only by whether THIS specific numeric token is
    // parenthesized — not by whether the word "(loss)" appears anywhere
    // in the surrounding label text (e.g. "net investment income (loss)
    // per share" is boilerplate present regardless of the actual sign).
    // "(" can appear before or after "$" depending on the filer's table
    // template ("$(0.10)" vs "($0.10)") — check for it anywhere in the
    // token, not just at the start.
    if (token.includes('(') && niiPerShare > 0) niiPerShare = -niiPerShare;
    notes.push(`NII/share extracted from text: $${niiPerShare}`);
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
      qoq_markdown_pct:    qoqMarkdownPct,
      trailing_realized_losses_pct: trailingRealizedLossesPct,
      nii_per_share_text:  niiPerShare,
      data_source:         'parsed',
    },
    sectorExposure: Object.keys(sectorExposure).length > 0
      ? { ...sectorExposure, data_source: 'parsed' }
      : {},
    notes,
  };
}
