/**
 * Filing Document Parser
 *
 * Extracts, from the HTML of a 10-Q/10-K, the metrics that are NOT available
 * as XBRL facts:
 *
 *   non-accrual %      → delegated to nonAccrual.js
 *   sector exposure    → aggregated from the Schedule of Investments
 *   realized losses /
 *   unrealized markdown → matched from the Statement of Operations
 *   NII per share      → fallback only, when XBRL doesn't tag it
 *
 * PIK income is deliberately NOT handled here. It is tagged in XBRL as a
 * pair of dollar figures (see computePikIncome in xbrl.js), and the text
 * regex that used to produce it was matching Schedule-of-Investments coupon
 * rates — "SOFR + 5.00%, 2.50% PIK" — rather than any income share. It was
 * wrong for all 45 BDCs in the universe.
 *
 * The hard reality: every BDC formats their filings differently. Where a
 * pattern can't be resolved unambiguously the extractor returns nothing
 * rather than a guess — a wrong number here feeds both the NAV Trust Score
 * and a column the UI presents as fact, so silence is the safer failure.
 */

import * as cheerio from 'cheerio';
import { extractNonAccrual } from './nonAccrual.js';

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

  // ── Sector aggregation ───────────────────────────────────────
  // Aggregates fair value by the SOI's own Industry column.
  //
  // The previous implementation classified on "row has <=2 cells and the
  // first is ALL CAPS", which never fires on real filings — industry
  // labels are Title Case cells inside wide rows ("Diversified Financial
  // Services", "Energy: Oil & Gas"). So `currentSector` stayed 'Other' for
  // every row and the value it summed was the row's last numeric cell,
  // which is the "% of Net Assets" column, not fair value. The result was
  // 51 sector_exposure rows in production that were 100% "other" or empty
  // — rows that look like data and contain none.
  //
  // Known limitation: the SOI is split across dozens of separate HTML
  // tables (57 for ARCC), and not every filer even has an Industry column
  // — ARCC uses a free-text "Business Description" instead. So this is
  // partial by construction, which is exactly why the validation below
  // exists: a partial classification is discarded rather than stored.
  const SECTOR_MAP = {
    software:    /software|technology|tech\b|saas|internet|cloud|it services/i,
    healthcare:  /health|pharma|medical|biotech|life science/i,
    consumer:    /consumer|retail|food|restaurant|beverage|apparel|leisure/i,
    industrial:  /industrial|manufactur|logistics|transport|aerospace|defense|capital goods|chemicals|energy|utilities/i,
    assetBacked: /asset.backed|structured|\babs\b|\bclo\b|real estate/i,
    financial:   /financial|insurance|bank|lending|credit|diversified financial/i,
  };

  const classifySector = label => {
    for (const [key, re] of Object.entries(SECTOR_MAP)) if (re.test(label)) return key;
    return 'other';
  };

  const HEADER_INDUSTRY = /^(industry|sector)$/i;
  const HEADER_FAIR_VALUE = /fair\s*value/i;

  const sectorTotals = {};
  const companyTotals = {};
  let totalFairValue = 0;

  $('table').each((_, table) => {
    // Built with an explicit loop: cheerio's .map().get() FLATTENS nested
    // results, so the idiomatic nested form yields one long array of cells
    // instead of an array of rows.
    const rows = [];
    for (const tr of $(table).find('tr').toArray()) {
      rows.push($(tr).find('td,th').toArray().map(td => $(td).text().trim().replace(/\s+/g, ' ')));
    }
    if (rows.length < 3) return;

    // Locate the header row and the two columns we need. Both must exist:
    // without an explicit Fair Value column there is no way to know that
    // the number being summed isn't a coupon, a par amount, or a
    // percentage-of-net-assets figure.
    let industryCol = -1, fvCol = -1;
    for (const row of rows.slice(0, 4)) {
      const iIdx = row.findIndex(c => HEADER_INDUSTRY.test(c));
      const fIdx = row.findIndex(c => HEADER_FAIR_VALUE.test(c));
      if (iIdx >= 0 && fIdx >= 0) { industryCol = iIdx; fvCol = fIdx; break; }
    }
    if (industryCol < 0 || fvCol < 0) return;

    for (const row of rows) {
      const label = row[industryCol];
      const cell  = row[fvCol];
      if (!label || !cell || HEADER_INDUSTRY.test(label)) continue;
      if (!/^\$?\s*[\d,]+(\.\d+)?$/.test(cell.replace(/\s/g, ''))) continue;
      const fv = parseFloat(cell.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(fv) || fv <= 0) continue;
      const key = classifySector(label);
      sectorTotals[key] = (sectorTotals[key] ?? 0) + fv;
      totalFairValue += fv;

      // Top-10 concentration is per PORTFOLIO COMPANY, not per row: a single
      // borrower routinely appears on several rows (first lien, second lien,
      // revolver, equity), and counting rows would understate concentration
      // by splitting one name across several entries.
      const company = (row[0] ?? '').replace(/\(\d+\)|\(\w\)/g, '').trim();
      if (company && !/^\$?[\d,.]+$/.test(company)) {
        companyTotals[company] = (companyTotals[company] ?? 0) + fv;
      }
    }
  });

  // ── Validation ───────────────────────────────────────────────
  // Sector data is only written when the parsed Schedule of Investments
  // RECONCILES against the portfolio fair value that XBRL reports
  // independently. Without that check there is no way to tell a complete
  // parse from a partial or double-counted one, and both produce a
  // confident-looking breakdown.
  //
  // Measured against real filings, the current table-scraping approach does
  // NOT reconcile: after correcting for the thousands scale that most SOI
  // tables use, coverage came out at 18% for CGBD (most of the SOI lives in
  // tables without both header columns) and 227%, 361% and 183% for OCSL,
  // PFLT and PSEC (subtotal rows summed alongside the detail rows they
  // total). FSK reconciles to 44%. None of those is a portfolio breakdown,
  // even though each yields plausible-looking percentages that add to 100.
  //
  // So this currently writes nothing for every filer — which is the point.
  // The previous version wrote 51 sector_exposure rows that were empty or
  // 100% "other". Emitting no row is strictly more honest, and the check is
  // self-correcting: improve the SOI table selection so the parse actually
  // reconciles, and the data starts flowing without touching this gate.
  const MAX_OTHER_SHARE_PCT = 60;
  const RECONCILE_MIN = 0.8;
  const RECONCILE_MAX = 1.25;

  const sectorExposure = {};
  if (totalFairValue <= 0) {
    notes.push('Sector exposure unavailable — no SOI table with both Industry and Fair Value columns');
  } else if (!totalInvestmentsFairValueUSD) {
    notes.push('Sector exposure skipped — no XBRL portfolio fair value to reconcile the parsed SOI against');
  } else {
    // SOI tables are usually captioned "(in thousands)" while the XBRL fact
    // is absolute dollars. Try both scales and keep whichever lands closer
    // to a full portfolio rather than assuming either.
    const scaled = [1, 1_000]
      .map(scale => ({ scale, coverage: (totalFairValue * scale) / totalInvestmentsFairValueUSD }))
      .sort((a, b) => Math.abs(Math.log(a.coverage)) - Math.abs(Math.log(b.coverage)))[0];

    const pct = fv => parseFloat(((fv / totalFairValue) * 100).toFixed(3));
    const otherShare = pct(sectorTotals.other ?? 0);
    const named = Object.keys(sectorTotals).filter(k => k !== 'other');
    const reconciles = scaled.coverage >= RECONCILE_MIN && scaled.coverage <= RECONCILE_MAX;

    if (reconciles && named.length >= 2 && otherShare <= MAX_OTHER_SHARE_PCT) {
      for (const [sector, fv] of Object.entries(sectorTotals)) {
        const col = sector === 'assetBacked' ? 'asset_backed_pct' : `${sector}_pct`;
        sectorExposure[col] = pct(fv);
      }
      // Per portfolio COMPANY, not per row — one borrower routinely appears
      // on several rows (first lien, second lien, revolver, equity), and
      // counting rows would understate concentration.
      const companies = Object.values(companyTotals).sort((a, b) => b - a);
      if (companies.length >= 10) {
        sectorExposure.top_10_holdings_pct = pct(companies.slice(0, 10).reduce((a, b) => a + b, 0));
      }
      notes.push(`Sector exposure: ${named.length} sectors, other=${otherShare}%, top10=${sectorExposure.top_10_holdings_pct ?? '—'}% (SOI reconciles to ${(scaled.coverage * 100).toFixed(0)}% of XBRL portfolio FV at ${scaled.scale}x)`);
    } else if (!reconciles) {
      notes.push(`Sector exposure discarded — parsed SOI totals ${(scaled.coverage * 100).toFixed(0)}% of XBRL portfolio FV (need ${RECONCILE_MIN * 100}-${RECONCILE_MAX * 100}%); the parse is partial or double-counted, so the breakdown is not trustworthy`);
    } else {
      notes.push(`Sector exposure discarded — ${named.length} named sector(s), other=${otherShare}% (needs >=2 named and other<=${MAX_OTHER_SHARE_PCT}%)`);
    }
  }

  // Whitespace-normalized document text. Collapsing runs of whitespace
  // matters for every pattern below: filing HTML puts cell boundaries and
  // line wraps in the middle of phrases, so "Amortized\n   Cost" only reads
  // as "Amortized Cost" after normalization.
  const bodyText = $('body').text().replace(/\s+/g, ' ');

  // ── Non-accrual ──────────────────────────────────────────────
  // Delegated to nonAccrual.js — see that module for why a single regex
  // cannot do this job. It returns cost and fair-value percentages
  // separately; the previous code filed whatever it found into the fair
  // value column regardless of which basis the filing actually stated,
  // so ARCC's 2.4%-at-amortized-cost was stored as a fair-value figure
  // (its real fair-value number is 1.4%).
  let nonAccrualCostPct = null;
  let nonAccrualFVPct   = null;

  const na = extractNonAccrual(bodyText);
  if (na) {
    nonAccrualCostPct = na.costPct;
    nonAccrualFVPct   = na.fvPct;
    notes.push(`Non-accrual via ${na.method}: cost=${na.costPct ?? '—'}% fv=${na.fvPct ?? '—'}% — "${na.evidence.slice(0, 90)}"`);
  } else {
    notes.push('No non-accrual disclosure found (filer may not state a portfolio percentage)');
  }

  // ── PIK income ───────────────────────────────────────────────
  // Deliberately NOT parsed here any more. PIK income as a share of total
  // investment income comes from XBRL (see computePikIncome in xbrl.js),
  // where it is a pair of tagged dollar figures rather than a number
  // scraped out of prose. The text regex this replaced was matching coupon
  // rates off the Schedule of Investments — every "SOFR + 5.00%, 2.50%
  // PIK" row is a candidate — and produced a wrong value for all 45 BDCs
  // in the universe. Nothing to fall back to here: a wrong PIK number is
  // worse than no PIK number, because it feeds a 20%-weight score
  // component and a "PIK %" column that reads as fact.

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

  // Sanity bound: a diversified BDC portfolio essentially never swings
  // more than ~20% in realized losses or markdown in a single quarter —
  // even a severe credit event quarter is typically low-to-mid single
  // digits. Confirmed in production that when this bound is exceeded
  // it's a parsing artifact, not a real number: LIEN's real markdown was
  // -$1,426,900 against a real portfolio FV of ~$364M (a sane -0.39%),
  // but the extractor's assumed "thousands" default scale (see
  // detectDocumentScale) doesn't hold for every filer — some report in
  // literal dollars, no "(in thousands)" caption at all — which turned
  // that same $1,426,900 into a reported -392% by multiplying by 1000
  // when it shouldn't have. Rather than try to perfectly solve unit
  // detection for every filer's format (an open-ended problem), treat an
  // implausible result as a parsing failure and drop it — reporting no
  // data is safer than reporting a number nobody can act on.
  const MAX_PLAUSIBLE_SWING_PCT = 20;

  if (realizedMatch && totalInvestmentsFairValueUSD && !collision) {
    const raw = realizedMatch[1];
    const isNegative = raw.includes('(') || raw.trim().startsWith('-');
    const absDollars = toAbsoluteDollars(raw, realizedMatch[2]);
    if (absDollars != null) {
      // Positive magnitude only — a net realized GAIN (positive figure)
      // means zero losses, not a negative "loss" number.
      const magnitude = isNegative ? Math.abs(absDollars) : 0;
      const pct = parseFloat(((magnitude / totalInvestmentsFairValueUSD) * 100).toFixed(3));
      if (Math.abs(pct) <= MAX_PLAUSIBLE_SWING_PCT) {
        trailingRealizedLossesPct = pct;
        notes.push(`Realized ${isNegative ? 'loss' : 'gain'} extracted from text: $${absDollars.toLocaleString()} → ${pct}% of portfolio FV`);
      } else {
        notes.push(`Realized-loss figure ($${absDollars.toLocaleString()}) implies an implausible ${pct}% of portfolio FV ($${totalInvestmentsFairValueUSD.toLocaleString()}) — likely a scale/parsing artifact, not written`);
      }
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
      const pct = parseFloat(((signedDollars / totalInvestmentsFairValueUSD) * 100).toFixed(3));
      if (Math.abs(pct) <= MAX_PLAUSIBLE_SWING_PCT) {
        qoqMarkdownPct = pct;
        notes.push(`Unrealized ${isNegative ? 'depreciation' : 'appreciation'} extracted from text: $${absDollars.toLocaleString()} → ${pct}% of portfolio FV`);
      } else {
        notes.push(`Markdown figure ($${absDollars.toLocaleString()}) implies an implausible ${pct}% of portfolio FV ($${totalInvestmentsFairValueUSD.toLocaleString()}) — likely a scale/parsing artifact, not written`);
      }
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
  //
  // A Statement of Operations routinely carries SEVERAL "...net investment
  // income per share..." rows, and filers commonly print a non-GAAP variant
  // (pre-tax, adjusted, core, distributable) immediately ABOVE the GAAP one
  // — so first-match-wins silently returns the wrong figure. Real example,
  // CSWC's quarter ended 2026-06-30: "Pre-tax net investment income per
  // share - basic $0.57 / Net investment income per share – basic $0.58".
  // The old single .match() took $0.57 and understated dividend coverage by
  // ~2 points. Walk every match instead and take the first unqualified one.
  const NII_RE = /net\s+investment\s+income(?:\s*\(loss\))?[^0-9$()]{0,80}per\s+(?:common\s+)?share[^0-9$()]{0,40}([\(\$]{0,2}-?[\d,]+\.\d+\)?)/gi;

  // The qualifier sits immediately before the label ("Pre-tax net investment
  // income per share"), so this is tested against the text ENDING at the
  // match start, anchored with $ — that anchor is what keeps an incidental
  // "...core portfolio. Net investment income per share $0.30" from being
  // thrown out. Trailing punctuation is allowed so "Adjusted (non-GAAP)"
  // still trips it. Keep this list to non-GAAP *measure* names: words like
  // "total" or "consolidated" still describe the GAAP figure and must not
  // disqualify it.
  const NII_QUALIFIER_RE = /(pre[-\s]?tax|after[-\s]?tax|adjusted|core|supplemental|distributable|non[-\s]?gaap)[\s)\-–—]*$/i;

  let niiPerShare = null;
  let niiMatch = null;
  for (const candidate of bodyText.matchAll(NII_RE)) {
    const preceding = bodyText.slice(Math.max(0, candidate.index - 40), candidate.index);
    if (NII_QUALIFIER_RE.test(preceding)) {
      notes.push(`Skipped non-GAAP NII/share variant: "…${preceding.trim().split(/\s+/).slice(-2).join(' ')} net investment income per share" = ${candidate[1]}`);
      continue;
    }
    niiMatch = candidate;
    break;
  }

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
