/**
 * Server-side NAV Trust Score Engine
 *
 * Mirrors src/utils/scoring.js on the frontend. Kept separate so the ETL
 * can run without a bundler. If you change scoring logic, update both files.
 *
 * Input: a row assembled from portfolio_metrics + sector_exposure DB records.
 * Output: { score, grade, components } — written to nav_trust_scores table.
 */

import { ALERT_THRESHOLDS } from './constants.js';

// ─── Component scorers (same logic as frontend) ───────────────────────────

function scoreNonAccrual(nonAccrualFVPct) {
  if (nonAccrualFVPct == null) return { key: 'nonAccrual', label: 'Non-Accrual Exposure', weight: 0.25, raw: 50, display: 'N/A', qualLabel: 'Data not yet available', explanation: 'Awaiting document parse.' };
  let raw, label;
  if      (nonAccrualFVPct < 0.5) { raw = 100; label = 'Minimal'; }
  else if (nonAccrualFVPct < 1.0) { raw = 85;  label = 'Low'; }
  else if (nonAccrualFVPct < 2.0) { raw = 65;  label = 'Moderate'; }
  else if (nonAccrualFVPct < 3.5) { raw = 40;  label = 'Elevated'; }
  else                             { raw = 15;  label = 'High — significant credit concern'; }
  return { key: 'nonAccrual', label: 'Non-Accrual Exposure', weight: 0.25, raw, display: `${nonAccrualFVPct.toFixed(1)}% at FV`, qualLabel: label, explanation: 'Loans no longer paying cash interest; high values erode NAV reliability.' };
}

function scorePIK(pikIncomePct, pikPrior) {
  if (pikIncomePct == null) return { key: 'pik', label: 'PIK Income', weight: 0.20, raw: 50, display: 'N/A', qualLabel: 'Data not yet available', explanation: 'Awaiting document parse.' };
  const deltaBps = pikPrior != null ? (pikIncomePct - pikPrior) * 100 : 0;
  let raw, label;
  if      (pikIncomePct < 5)  { raw = 90; label = 'Low'; }
  else if (pikIncomePct < 8)  { raw = 72; label = 'Moderate'; }
  else if (pikIncomePct < 12) { raw = 50; label = 'Elevated'; }
  else                        { raw = 25; label = 'High'; }
  let trendPenalty = 0, trendNote = '';
  if      (deltaBps > 200) { trendPenalty = 20; trendNote = ` — rising rapidly (+${deltaBps.toFixed(0)}bps QoQ)`; }
  else if (deltaBps > 100) { trendPenalty = 12; trendNote = ` — rising (+${deltaBps.toFixed(0)}bps QoQ)`; }
  else if (deltaBps > 0)   { trendPenalty = 5;  trendNote = ' — ticking up'; }
  raw = Math.max(0, raw - trendPenalty);
  return { key: 'pik', label: 'PIK Income', weight: 0.20, raw, display: `${pikIncomePct.toFixed(1)}% of income`, qualLabel: label + trendNote, explanation: 'PIK income recognized but not received in cash. Rising PIK can mask deteriorating borrower health.' };
}

function scoreMarkdown(qoqMarkdownPct) {
  if (qoqMarkdownPct == null) return { key: 'markdown', label: 'Portfolio Markdown Trend', weight: 0.20, raw: 50, display: 'N/A', qualLabel: 'Data not yet available', explanation: 'Awaiting document parse.' };
  let raw, label;
  if      (qoqMarkdownPct > 0.5)  { raw = 100; label = 'Net markup'; }
  else if (qoqMarkdownPct >= -0.2) { raw = 80;  label = 'Stable'; }
  else if (qoqMarkdownPct >= -0.7) { raw = 60;  label = 'Modest markdowns'; }
  else if (qoqMarkdownPct >= -1.5) { raw = 38;  label = 'Material markdowns'; }
  else                             { raw = 15;  label = 'Significant markdowns'; }
  return { key: 'markdown', label: 'Portfolio Markdown Trend', weight: 0.20, raw, display: `${qoqMarkdownPct >= 0 ? '+' : ''}${qoqMarkdownPct.toFixed(1)}% QoQ`, qualLabel: label, explanation: 'Net fair value change to the portfolio. Persistent markdowns compress NAV.' };
}

function scoreSectorConcentration(softwarePct, top10Pct) {
  let raw = 100, flags = [];
  if      (softwarePct > 30) { raw -= 25; flags.push(`Software ${softwarePct?.toFixed(0)}% (>30%)`); }
  else if (softwarePct > 20) { raw -= 12; flags.push(`Software ${softwarePct?.toFixed(0)}% (elevated)`); }
  if      (top10Pct > 30)    { raw -= 15; flags.push(`Top-10 ${top10Pct?.toFixed(0)}% (concentrated)`); }
  else if (top10Pct > 22)    { raw -= 8;  flags.push(`Top-10 ${top10Pct?.toFixed(0)}%`); }
  raw = Math.max(0, raw);
  const display = softwarePct != null ? `Software ${softwarePct.toFixed(0)}% | Top-10 ${(top10Pct ?? 0).toFixed(0)}%` : 'N/A';
  return { key: 'concentration', label: 'Sector Concentration', weight: 0.15, raw, display, qualLabel: flags.length ? flags.join('; ') : 'Well-diversified', explanation: 'High software/tech and borrower concentration increase NAV volatility.' };
}

function scoreRealizedLosses(trailingLossesPct) {
  if (trailingLossesPct == null) return { key: 'realizedLosses', label: 'Trailing Realized Losses', weight: 0.10, raw: 50, display: 'N/A', qualLabel: 'Data not yet available', explanation: 'Awaiting document parse.' };
  let raw, label;
  if      (trailingLossesPct < 0.2) { raw = 95; label = 'Minimal'; }
  else if (trailingLossesPct < 0.5) { raw = 78; label = 'Low'; }
  else if (trailingLossesPct < 1.5) { raw = 55; label = 'Moderate'; }
  else if (trailingLossesPct < 3.0) { raw = 30; label = 'Elevated'; }
  else                              { raw = 10; label = 'High — realized losses compounding'; }
  return { key: 'realizedLosses', label: 'Trailing Realized Losses', weight: 0.10, raw, display: `${trailingLossesPct.toFixed(1)}% of portfolio`, qualLabel: label, explanation: 'Realized losses are permanent NAV impairments.' };
}

function scoreDividendCoverage(coverage) {
  if (coverage == null) return { key: 'dividendCoverage', label: 'Dividend / NII Coverage', weight: 0.10, raw: 50, display: 'N/A', qualLabel: 'Data not yet available', explanation: 'Awaiting XBRL data.' };
  let raw, label;
  if      (coverage >= 1.15) { raw = 95; label = 'Well-covered'; }
  else if (coverage >= 1.05) { raw = 78; label = 'Adequately covered'; }
  else if (coverage >= 1.00) { raw = 60; label = 'Barely covered'; }
  else if (coverage >= 0.95) { raw = 35; label = 'Uncovered — potential cut risk'; }
  else                       { raw = 15; label = 'Significantly uncovered'; }
  return { key: 'dividendCoverage', label: 'Dividend / NII Coverage', weight: 0.10, raw, display: `${(coverage * 100).toFixed(0)}%`, qualLabel: label, explanation: 'Coverage <100% means BDC is distributing capital, not earnings.' };
}

// ─── Main scorer ──────────────────────────────────────────────────────────

/**
 * Compute NAV Trust Score from DB-sourced metrics.
 *
 * @param {{ nonAccrualFVPct, pikIncomePct, pikIncomePriorPct, qoqMarkdownPct,
 *            trailingRealizedLossesPct, dividendCoverage }} portfolioMetrics
 * @param {{ softwarePct, top10HoldingsPct }} sectorExposure
 * @returns {{ score: number, grade: string, components: object[] }}
 */
export function computeNavTrustScore(portfolioMetrics, sectorExposure) {
  const pm = portfolioMetrics ?? {};
  const sx = sectorExposure   ?? {};

  const components = [
    scoreNonAccrual(pm.non_accrual_fv_pct),
    scorePIK(pm.pik_income_pct, pm.pik_income_prior_pct),
    scoreMarkdown(pm.qoq_markdown_pct),
    scoreSectorConcentration(sx.software_pct, sx.top_10_holdings_pct),
    scoreRealizedLosses(pm.trailing_realized_losses_pct),
    scoreDividendCoverage(pm.dividend_coverage),
  ];

  const totalWeight   = components.reduce((s, c) => s + c.weight, 0);
  const weightedScore = components.reduce((s, c) => s + c.raw * c.weight, 0);
  const score = Math.round(weightedScore / totalWeight);

  let grade;
  if      (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';
  else                  grade = 'F';

  return { score, grade, components };
}

// ─── Alert generator ──────────────────────────────────────────────────────

/**
 * Generate alerts from DB-sourced data.
 *
 * @param {{ ticker, latestNav, latestPrice, discount30dAgo }} valuation
 * @param {object} portfolioMetrics
 * @param {object} sectorExposure
 * @param {Array}  recentInsiderTrades
 * @returns {Array<{type, severity, label, detail}>}
 */
export function generateAlerts(valuation, portfolioMetrics, sectorExposure, recentInsiderTrades = []) {
  const alerts = [];
  const pm = portfolioMetrics ?? {};
  const sx = sectorExposure   ?? {};
  const t  = ALERT_THRESHOLDS;

  const currentDiscount = valuation.latestNav
    ? ((valuation.latestPrice - valuation.latestNav) / valuation.latestNav) * 100
    : null;

  const discount30dAgo = valuation.discount30dAgo ?? null;

  // Discount widening
  if (currentDiscount != null && discount30dAgo != null) {
    const widening = currentDiscount - discount30dAgo;
    if (widening < t.discountWidening30d) {
      alerts.push({ type: 'discount_widening', severity: 'high', label: 'Discount Widened', detail: `Discount widened ${Math.abs(widening).toFixed(1)}% over 30 days` });
    }
  }

  // PIK spike
  if (pm.pik_income_pct != null && pm.pik_income_prior_pct != null) {
    const deltaBps = (pm.pik_income_pct - pm.pik_income_prior_pct) * 100;
    if (deltaBps > t.pikSpikeBps) {
      alerts.push({ type: 'pik_spike', severity: 'high', label: 'PIK Spike', detail: `PIK income rose ${deltaBps.toFixed(0)}bps QoQ (${pm.pik_income_prior_pct.toFixed(1)}% → ${pm.pik_income_pct.toFixed(1)}%)` });
    }
  }

  // Uncovered dividend
  if (pm.dividend_coverage != null && pm.dividend_coverage < t.dividendCoverage) {
    alerts.push({ type: 'uncovered_dividend', severity: 'high', label: 'Uncovered Dividend', detail: `NII covers only ${(pm.dividend_coverage * 100).toFixed(0)}% of dividend` });
  }

  // Software concentration
  if (sx.software_pct != null && sx.software_pct > t.softwareConcentration) {
    alerts.push({ type: 'concentration', severity: 'medium', label: 'Software Concentration', detail: `Software/tech exposure at ${sx.software_pct.toFixed(1)}% — above ${t.softwareConcentration}% threshold` });
  }

  // Material markdown
  if (pm.qoq_markdown_pct != null && pm.qoq_markdown_pct < t.markdownMaterial) {
    alerts.push({ type: 'markdown', severity: 'medium', label: 'Material Markdown', detail: `Portfolio marked down ${Math.abs(pm.qoq_markdown_pct).toFixed(1)}% QoQ` });
  }

  // Insider buy below NAV
  if (valuation.latestNav) {
    for (const trade of recentInsiderTrades) {
      if (trade.trade_type === 'buy' && trade.price_per_share < valuation.latestNav) {
        alerts.push({ type: 'insider_buy', severity: 'info', label: 'Insider Buy Below NAV', detail: `${trade.insider_name} (${trade.insider_title}) bought ${trade.shares.toLocaleString()} @ $${trade.price_per_share.toFixed(2)} on ${trade.transaction_date}` });
      }
    }
  }

  return alerts;
}
