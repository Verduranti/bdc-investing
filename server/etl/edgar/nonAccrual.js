/**
 * Non-Accrual Extractor
 *
 * Pulls non-accrual exposure (as % of portfolio, at amortized cost and at
 * fair value) out of a 10-Q/10-K. There is no XBRL concept for this — no
 * filer in the universe tags one — so it has to come from the document.
 *
 * This replaces a single permissive regex:
 *
 *   /non.accrual[^.]*?(\d+\.?\d*)\s*%.../i
 *
 * whose trailing qualifiers were all optional, so it reduced to "the first
 * percentage appearing anywhere after the first 'non-accrual' in the
 * document". Verified against real filings, that produced: BCSF 96.8%
 * (the PERFORMING row of the performing/non-accrual table), MSDL 97.1%
 * (same), CGBD 100.0% ("percentage of loans at floating interest rates"),
 * PSEC 85.2% ("First Lien Debt ... 85.2% of Portfolio") and BBDC 25%
 * ("owns more than 25% of the portfolio company's outstanding voting
 * securities"). Real non-accrual figures are low single digits, so every
 * one of those was not merely wrong but wrong in the dangerous direction —
 * a healthy BDC rendered as catastrophically impaired.
 *
 * Two disclosure shapes cover the universe:
 *
 *   PROSE  "investments on non-accrual status represented 1.2% and 0.6%
 *           of our portfolio based on cost and fair value, respectively"
 *   TABLE  "Performing $2,300,320 96.8% $2,312,753 97.8%
 *           Non-accrual 74,925 3.2 50,823 2.2  Total ... 100.0%"
 *
 * The hard part is that "X% and Y%" is genuinely ambiguous across filers:
 *
 *   CGBD/GSBD  "5.0% and 2.9% ... at amortized cost and at fair value"
 *              → the pair is (cost, fair value) for ONE date
 *   CION/PSEC  "1.4% and 1.8%, respectively, ... on a fair value basis"
 *              → the pair is (current, prior) for ONE basis
 *
 * Reading the second number as fair value in the CION case would silently
 * store the PRIOR quarter's figure as this quarter's fair-value exposure.
 * The disambiguator is the trailing qualifier: only when it names BOTH
 * bases do the two numbers mean (cost, fair value).
 */

// Non-accruals are a small share of a portfolio by construction — a BDC
// carrying a quarter of its book on non-accrual would be in liquidation,
// not filing a routine 10-Q. Anything above this is a parse artifact
// (almost always the "Performing" row or an unrelated percentage), and
// reporting nothing beats reporting a number that would dominate the
// score. Highest real reading in the current universe is ~5%.
const MAX_PLAUSIBLE_NON_ACCRUAL_PCT = 25;

const COST_RE = /amortized\s+cost|\bat\s+cost\b|\bon\s+cost\b|\bcost\s+basis\b|\btotal\s+cost\b|\bbased\s+on\s+cost\b/i;
const FV_RE   = /fair\s+value/i;

const inRange = n => Number.isFinite(n) && n >= 0 && n <= MAX_PLAUSIBLE_NON_ACCRUAL_PCT;

// Bounded gaps must NOT be written as [^.]{0,N}. Filing text is dense with
// decimals ("97.1 %", "$3,570,188"), so a period-excluding gap cannot cross
// its own numbers and silently fails on every table. That was the flaw in
// the regex this module replaces, and it is easy to reintroduce. Use a
// lazy [\s\S] gap with a tight bound instead.
const GAP = n => `[\\s\\S]{0,${n}}?`;

/**
 * Every window of text around a "non-accrual" mention, longest-lived first.
 *
 * Anchoring on the FIRST occurrence is wrong: in real filings the first
 * mention is almost always an SOI footnote legend ("(e) Non-accrual
 * investment" in BBDC, "(8) Loan was on non-accrual status" in BCSF), far
 * from the actual disclosure. Every occurrence gets a look instead, and the
 * first one that yields a plausible reading wins.
 */
function* windows(text, size = 900) {
  const re = /non-?accruals?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    yield { at: m.index, text: text.slice(m.index, m.index + size) };
  }
}

/**
 * ARCC's shape — one basis inline, the other parenthesised:
 *   "represented 2.4% of the total investments at amortized cost
 *    (or 1.4% at fair value)"
 */
function fromParenthetical(win) {
  const m = win.match(new RegExp(
    `(\\d{1,2}(?:\\.\\d+)?)\\s*%${GAP(60)}(amortized\\s+cost|fair\\s+value)${GAP(20)}\\(\\s*or\\s+(\\d{1,2}(?:\\.\\d+)?)\\s*%\\s*at\\s+(amortized\\s+cost|fair\\s+value)`, 'i'));
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[3]);
  if (!inRange(a) || !inRange(b)) return null;
  const firstIsCost = /cost/i.test(m[2]);
  return { costPct: firstIsCost ? a : b, fvPct: firstIsCost ? b : a, evidence: m[0].trim().slice(0, 200) };
}

/**
 * Pair percentages with basis labels inside one clause.
 *
 * Filers use three different orderings for the same disclosure, and any
 * single pairing rule gets two of them wrong:
 *
 *   pcts-first   "1.2% and 0.6% ... based on cost and fair value"       CGBD
 *   bases-first  "as a percentage of total investments at cost and fair
 *                 value were 2.9% and 1.9%"                             GBDC
 *   interleaved  "8.5% ... at cost and 5.4% at fair value"              SCM
 *
 * The first two pair by index; the third pairs each percentage with the
 * next basis after it. Which one applies is read off the token positions
 * rather than assumed.
 */
function pairPctsToBases(clause) {
  const pcts = [...clause.matchAll(/(\d{1,2}(?:\.\d+)?)\s*%/g)]
    .map(x => ({ at: x.index, v: parseFloat(x[1]) }))
    .filter(x => inRange(x.v));
  // Longer labels first so "amortized cost" isn't also counted as "cost".
  const bases = [...clause.matchAll(/amortized\s+cost|fair\s+value|\bcost\b/gi)]
    .map(x => ({ at: x.index, isFV: /fair/i.test(x[0]) }));
  if (!pcts.length || !bases.length) return null;

  let costPct = null, fvPct = null;
  const allPctsFirst  = pcts[pcts.length - 1].at < bases[0].at;
  const allBasesFirst = bases[bases.length - 1].at < pcts[0].at;

  if (allPctsFirst || allBasesFirst) {
    for (let i = 0; i < Math.min(pcts.length, bases.length); i++) {
      if (bases[i].isFV) fvPct ??= pcts[i].v; else costPct ??= pcts[i].v;
    }
  } else {
    for (const pct of pcts) {
      const b = bases.find(x => x.at > pct.at);
      if (!b) continue;
      if (b.isFV) fvPct ??= pct.v; else costPct ??= pct.v;
    }
  }
  return (costPct == null && fvPct == null) ? null : { costPct, fvPct };
}

/**
 * Subject-last disclosures, which every forward-reading strategy misses
 * because the percentages come BEFORE the word "non-accrual".
 *
 * Deliberately two narrow patterns rather than one "any sentence that
 * mentions non-accrual and contains a percentage" scan. That broader
 * version was tried and produced exactly the failure this module exists to
 * prevent: it read FSK's "59.4% of our portfolio investments (based on
 * fair value) were debt investments paying variable interest rates and
 * 9.1%..." as a 9.1% non-accrual rate, and invented readings for HTGC,
 * NMFC and OBDC. Requiring non-accrual to be the grammatical subject of
 * the percentage is what makes the match trustworthy.
 */
function fromSubjectLast(fullText, at) {
  const region = fullText.slice(Math.max(0, at - 340), at + 320);

  // "non-accrual investments as a percentage of total investments at cost
  //  and fair value were 2.9% and 1.9%, respectively."          (GBDC)
  const asPct = region.match(
    /non-?accruals?[\s\S]{0,60}?as\s+a\s+percentage\s+of\s+([\s\S]{0,200}?)(?:\.\s|$)/i
  );
  if (asPct) {
    const hit = pairPctsToBases(asPct[1]);
    if (hit) return { ...hit, evidence: asPct[0].trim().slice(0, 200) };
  }

  // "4.6% of total investments at amortized cost, or 2.8% of total
  //  investments at fair value, were on non-accrual status."     (MFIC)
  const subjLast = region.match(
    /((?:\d{1,2}(?:\.\d+)?\s*%[\s\S]{0,90}?){1,2})(?:were|was)\s+(?:placed\s+)?on\s+non-?accrual/i
  );
  if (subjLast) {
    const hit = pairPctsToBases(subjLast[1]);
    if (hit) return { ...hit, evidence: subjLast[0].trim().slice(0, 200) };
  }
  return null;
}

/**
 * Prose form. Requiring a disclosure verb ("represented", "comprised",
 * "accounted for") is what keeps this off the yield tables and footnotes
 * that mention non-accruals without stating a portfolio share.
 *
 * Percentages and basis words are paired POSITIONALLY, because filers use
 * two different orderings and picking one breaks the other:
 *
 *   interleaved  "8.5% of total investments at cost and 5.4% at fair value"
 *                → each percentage is followed by its own basis   (SCM)
 *   grouped      "1.2% and 0.6% ... based on cost and fair value"
 *                → percentages first, then bases, paired by index (CGBD)
 *
 * Nearest-following-basis alone mis-reads the grouped form (both numbers
 * precede "cost", so both would be filed as cost); index pairing alone
 * mis-reads the interleaved form. The shape is detected from the actual
 * ordering of the tokens.
 */
function fromProse(win) {
  const VERB = `(?:represent(?:ed|s|ing)?|comprised?|compris(?:e|ing)|account(?:ed)?\\s+for|totall?ed)`;
  const RE = new RegExp(`${VERB}\\s+(?:approximately\\s+)?(\\d{1,2}(?:\\.\\d+)?)\\s*%`, 'gi');

  for (const m of win.matchAll(RE)) {
    if (!inRange(parseFloat(m[1]))) continue;
    // The clause this disclosure lives in. Bounded so a following
    // sentence's figures can't be pulled in, but long enough to reach a
    // trailing "..., respectively" qualifier.
    const clause = m[0] + win.slice(m.index + m[0].length, m.index + m[0].length + 150);
    const hit = pairPctsToBases(clause);
    if (hit) return { ...hit, evidence: clause.trim().slice(0, 200) };
  }
  return null;
}

/**
 * TRIN's shape — dollars, then the share as a trailing appositive:
 *   "a total fair value of approximately $18.7 million, or 0.8%, of the
 *    fair value of the Company's debt investment portfolio"
 */
function fromAppositive(win) {
  const m = win.match(new RegExp(
    `(?:total\\s+)?(fair\\s+value|cost)\\s+of\\s+(?:approximately\\s+)?\\$[\\d,.]+\\s*(?:million|billion|thousand)?\\s*,?\\s*or\\s+(?:approximately\\s+)?(\\d{1,2}(?:\\.\\d+)?)\\s*%\\s*,?\\s*of\\s+the\\s+(fair\\s+value|cost|amortized\\s+cost)`, 'i'));
  if (!m) return null;
  const v = parseFloat(m[2]);
  if (!inRange(v)) return null;
  const isFV = FV_RE.test(m[3]);
  return { costPct: isFV ? null : v, fvPct: isFV ? v : null, evidence: m[0].trim().slice(0, 200) };
}

/**
 * BBDC's shape — one clause per basis, separated by a sentence boundary:
 *   "...fair value of which was $13.7 million, which comprised 0.6% of the
 *    total fair value of our portfolio, and the aggregate cost of which was
 *    $38.3 million, which comprised 1.5% of the total cost..."
 */
function fromDollarClauses(win) {
  const grab = basisRe => {
    const m = win.match(new RegExp(
      `(?:comprised?|represent(?:ed|s)?|account(?:ed)?\\s+for)\\s+(?:approximately\\s+)?(\\d{1,2}(?:\\.\\d+)?)\\s*%\\s+of\\s+(?:the\\s+)?total\\s+${basisRe}`, 'i'));
    const v = m ? parseFloat(m[1]) : NaN;
    return inRange(v) ? v : null;
  };
  const costPct = grab('cost');
  const fvPct   = grab('fair\\s+value');
  if (costPct == null && fvPct == null) return null;
  return { costPct, fvPct, evidence: win.slice(0, 200).trim() };
}

/**
 * Table form: a "Performing / Non-accrual / Total" summary block.
 *
 * Which percentage is cost and which is fair value comes from the header
 * above the block. MSDL's table is amortized cost ONLY, its two columns
 * being two DATES ("Amortized Cost % of Total | Amortized Cost % of Total"
 * for Jun 30 and Dec 31) — so reading its second number as fair value
 * would file last quarter's cost figure as this quarter's fair value.
 * Only treat the pair as (cost, FV) when the header names both bases.
 *
 * Runs on the text BEFORE the anchor as well as after, because the anchor
 * ("Non-accrual") sits in the middle of the block while the header that
 * disambiguates it sits above.
 */
function fromTable(win, fullText, at) {
  const m = win.match(new RegExp(
    `^non-?accruals?\\b(?:\\s*\\(\\d+\\))?\\s*((?:[\\s$]*[\\d,]+(?:\\.\\d+)?\\s*%?){2,6})`, 'i'));
  if (!m) return null;

  // Header context: the column-label zone, which is the run of text between
  // the table caption and the "Performing" row. Scoping matters — a plain
  // "400 chars before the anchor" window reaches back into whatever prose
  // precedes the table, and on BCSF that prose ends "...measured on a fair
  // value basis." which put "fair value" BEFORE "amortized cost" in the
  // window and flipped the two columns (cost 2.2 / FV 3.2 instead of
  // 3.2 / 2.2). Anchor on the LAST "Performing" before the row — that's the
  // row label itself — and read only the labels immediately above it.
  const preAnchor = fullText.slice(Math.max(0, at - 500), at);
  const perfIdx = preAnchor.toLowerCase().lastIndexOf('performing');
  if (perfIdx < 0) return null;   // must be the performing/non-accrual table
  let header = preAnchor.slice(Math.max(0, perfIdx - 260), perfIdx);
  // Drop the caption sentence and keep only the column labels. Captions
  // routinely name BOTH bases even when the table shows one — TSLX's reads
  // "The following tables show the fair value and amortized cost of our
  // performing and non-accrual investments as of June 30, 2026 and
  // December 31, 2025:" above a table whose columns are "Fair Value
  // Percentage | Fair Value Percentage" for two DATES. Including the
  // caption made that look like a cost/FV pair and filed the prior-period
  // dollar amount (20.0) as a cost percentage. Captions end at a colon.
  // Also cut at the previous table's "Total ... 100.0 %" row: when a filer
  // stacks a fair-value table directly above an amortized-cost one (TSLX
  // does), there is no colon between them, so the window would still reach
  // back into the first table's "Fair Value Percentage" labels and make the
  // cost-only table look like a cost/FV pair.
  const cuts = [header.lastIndexOf(':')];
  const totalRow = [...header.matchAll(/100(?:\.0+)?\s*%/g)].pop();
  if (totalRow) cuts.push(totalRow.index + totalRow[0].length - 1);
  const cut = Math.max(...cuts);
  if (cut >= 0) header = header.slice(cut + 1);

  // Row cells alternate dollar-amount, percentage, dollar-amount,
  // percentage. Take them by POSITION, not by magnitude: filers reporting
  // in millions have dollar amounts small enough to pass a plausibility
  // filter, so range-filtering picked TSLX's prior-period $20.0M as if it
  // were a 20% non-accrual rate. Odd indices are the percentages.
  const nums = (m[1].match(/[\d,]+(?:\.\d+)?/g) ?? []).map(x => parseFloat(x.replace(/,/g, '')));
  if (nums.length < 2 || nums.length % 2 !== 0) return null;
  const pcts = nums.filter((_, i) => i % 2 === 1);
  if (!pcts.every(inRange)) return null;

  const namesCost = COST_RE.test(header);
  const namesFV   = FV_RE.test(header);
  const evidence = m[0].replace(/\s+/g, ' ').trim().slice(0, 200);

  if (namesCost && namesFV && pcts.length >= 2) {
    const costFirst = header.search(COST_RE) < header.search(FV_RE);
    return { costPct: costFirst ? pcts[0] : pcts[1], fvPct: costFirst ? pcts[1] : pcts[0], evidence };
  }
  if (namesCost && !namesFV) return { costPct: pcts[0], fvPct: null, evidence };
  if (namesFV && !namesCost) return { costPct: null, fvPct: pcts[0], evidence };
  return null;
}

/**
 * Extract non-accrual percentages from filing body text.
 *
 * @param {string} bodyText - whitespace-normalized document text
 * @returns {{costPct: number|null, fvPct: number|null, method: string, evidence: string}|null}
 */
export function extractNonAccrual(bodyText) {
  // Ordered by how unambiguous each shape is. A window that yields BOTH
  // bases beats one that yields a single basis, so a full reading isn't
  // lost to an earlier partial one.
  const strategies = [
    ['parenthetical', (w) => fromParenthetical(w.text)],
    ['table',         (w) => fromTable(w.text, bodyText, w.at)],
    ['prose',         (w) => fromProse(w.text)],
    ['subjectLast',   (w) => fromSubjectLast(bodyText, w.at)],
    ['appositive',    (w) => fromAppositive(w.text)],
    ['dollarClauses', (w) => fromDollarClauses(w.text)],
  ];

  // A single window yielding BOTH bases is the strongest reading — take it
  // and stop. Otherwise accumulate: filers routinely split the two bases
  // across separate disclosures (TSLX stacks a fair-value summary table
  // directly above an amortized-cost one), and keeping only the first
  // partial would discard the other basis entirely.
  const merged = { costPct: null, fvPct: null, method: null, evidence: null };
  for (const w of windows(bodyText)) {
    for (const [method, fn] of strategies) {
      const hit = fn(w);
      if (!hit || (hit.costPct == null && hit.fvPct == null)) continue;
      if (hit.costPct != null && hit.fvPct != null) return { ...hit, method };
      for (const key of ['costPct', 'fvPct']) {
        if (merged[key] == null && hit[key] != null) {
          merged[key] = hit[key];
          merged.method = merged.method ? `${merged.method}+${method}` : method;
          merged.evidence ??= hit.evidence;
        }
      }
      if (merged.costPct != null && merged.fvPct != null) return merged;
    }
  }
  return (merged.costPct != null || merged.fvPct != null) ? merged : null;
}

export const __testing = { fromProse, fromParenthetical, fromTable, fromAppositive, fromDollarClauses, fromSubjectLast, pairPctsToBases, MAX_PLAUSIBLE_NON_ACCRUAL_PCT };
