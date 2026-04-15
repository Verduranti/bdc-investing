/**
 * NAV Trust Score Engine
 *
 * Produces a 0–100 composite score estimating how trustworthy a BDC's
 * reported NAV is. Higher = more trustworthy.
 *
 * The score is decomposable: each component is returned alongside
 * its weight, raw value, and a short explanation, so the UI can
 * render a full breakdown.
 *
 * Scoring philosophy:
 *   - Low non-accruals   → positive
 *   - Low PIK            → positive
 *   - Stable/rising markups → positive
 *   - Diversified sectors → positive
 *   - Repeated realized losses → negative
 *   - Rising PIK + flat non-accruals → strong red flag (window-dressing risk)
 *   - Uncovered dividend  → negative
 */

// ─── Component definitions ───────────────────────────────────────────────────

/**
 * Score non-accrual exposure.
 * Input: nonAccrualFVPct (% at fair value — more conservative signal)
 * Thresholds: <1% = excellent, 1-2% = ok, 2-4% = concern, >4% = red flag
 */
function scoreNonAccrual(nonAccrualFVPct) {
  let raw;
  let label;
  if (nonAccrualFVPct < 0.5) {
    raw = 100; label = 'Minimal';
  } else if (nonAccrualFVPct < 1.0) {
    raw = 85; label = 'Low';
  } else if (nonAccrualFVPct < 2.0) {
    raw = 65; label = 'Moderate';
  } else if (nonAccrualFVPct < 3.5) {
    raw = 40; label = 'Elevated';
  } else {
    raw = 15; label = 'High — significant credit concern';
  }
  return {
    key: 'nonAccrual',
    label: 'Non-Accrual Exposure',
    weight: 0.25,
    raw,
    display: `${nonAccrualFVPct.toFixed(1)}% at FV`,
    qualLabel: label,
    explanation: 'Loans no longer paying cash interest; high values erode NAV reliability.',
  };
}

/**
 * Score PIK income level and trend.
 * Rising PIK with stable non-accruals is a strong warning — borrowers
 * paying in-kind instead of cash may be masking stress.
 */
function scorePIK(pikIncomePct, pikPrior) {
  const pikDelta = pikIncomePct - pikPrior;      // basis-point-style, both in %
  const deltaBps = pikDelta * 100;               // convert % to bps

  let raw;
  let label;

  // Base score from absolute level
  if (pikIncomePct < 5) {
    raw = 90; label = 'Low';
  } else if (pikIncomePct < 8) {
    raw = 72; label = 'Moderate';
  } else if (pikIncomePct < 12) {
    raw = 50; label = 'Elevated';
  } else {
    raw = 25; label = 'High';
  }

  // Penalize rising trend
  let trendPenalty = 0;
  let trendNote = '';
  if (deltaBps > 200) {
    trendPenalty = 20;
    trendNote = ' — rising rapidly (+' + deltaBps.toFixed(0) + 'bps QoQ), potential stress masking';
  } else if (deltaBps > 100) {
    trendPenalty = 12;
    trendNote = ' — rising (+' + deltaBps.toFixed(0) + 'bps QoQ)';
  } else if (deltaBps > 0) {
    trendPenalty = 5;
    trendNote = ' — ticking up';
  }

  raw = Math.max(0, raw - trendPenalty);

  return {
    key: 'pik',
    label: 'PIK Income',
    weight: 0.20,
    raw,
    display: `${pikIncomePct.toFixed(1)}% of income`,
    qualLabel: label + trendNote,
    explanation: 'PIK (payment-in-kind) income is recognized but not received in cash. Rising PIK can mask deteriorating borrower health.',
  };
}

/**
 * Score QoQ markdown trend.
 * Negative qoqMarkdownPct means net portfolio markdowns.
 */
function scoreMarkdown(qoqMarkdownPct) {
  let raw;
  let label;
  if (qoqMarkdownPct > 0.5) {
    raw = 100; label = 'Net markup';
  } else if (qoqMarkdownPct >= -0.2) {
    raw = 80; label = 'Stable';
  } else if (qoqMarkdownPct >= -0.7) {
    raw = 60; label = 'Modest markdowns';
  } else if (qoqMarkdownPct >= -1.5) {
    raw = 38; label = 'Material markdowns';
  } else {
    raw = 15; label = 'Significant markdowns';
  }
  return {
    key: 'markdown',
    label: 'Portfolio Markdown Trend',
    weight: 0.20,
    raw,
    display: `${qoqMarkdownPct >= 0 ? '+' : ''}${qoqMarkdownPct.toFixed(1)}% QoQ`,
    qualLabel: label,
    explanation: 'Net fair value change to the portfolio. Persistent markdowns compress NAV and signal worsening credit.',
  };
}

/**
 * Score sector concentration risk.
 * Heavy software/tech exposure is flagged given covenant-lite, growth-equity risk.
 */
function scoreSectorConcentration(sectorExposure) {
  const { software = 0, top10HoldingsPct = 0 } = sectorExposure;

  let raw = 100;
  let flags = [];

  if (software > 30) {
    raw -= 25;
    flags.push(`Software ${software.toFixed(0)}% (>30% threshold)`);
  } else if (software > 20) {
    raw -= 12;
    flags.push(`Software ${software.toFixed(0)}% (elevated)`);
  }

  if (top10HoldingsPct > 30) {
    raw -= 15;
    flags.push(`Top-10 holdings ${top10HoldingsPct.toFixed(0)}% (concentrated)`);
  } else if (top10HoldingsPct > 22) {
    raw -= 8;
    flags.push(`Top-10 holdings ${top10HoldingsPct.toFixed(0)}%`);
  }

  raw = Math.max(0, raw);
  const label = flags.length === 0 ? 'Well-diversified' : flags.join('; ');

  return {
    key: 'concentration',
    label: 'Sector Concentration',
    weight: 0.15,
    raw,
    display: `Software ${software.toFixed(0)}% | Top-10 ${top10HoldingsPct.toFixed(0)}%`,
    qualLabel: label,
    explanation: 'High software/tech exposure and borrower concentration increase NAV volatility in a credit downturn.',
  };
}

/**
 * Score realized losses.
 * Trailing realized losses as % of portfolio signal real credit impairment.
 */
function scoreRealizedLosses(trailingRealizedLossesPct) {
  let raw;
  let label;
  if (trailingRealizedLossesPct < 0.2) {
    raw = 95; label = 'Minimal';
  } else if (trailingRealizedLossesPct < 0.5) {
    raw = 78; label = 'Low';
  } else if (trailingRealizedLossesPct < 1.5) {
    raw = 55; label = 'Moderate';
  } else if (trailingRealizedLossesPct < 3.0) {
    raw = 30; label = 'Elevated';
  } else {
    raw = 10; label = 'High — realized losses compounding';
  }
  return {
    key: 'realizedLosses',
    label: 'Trailing Realized Losses',
    weight: 0.10,
    raw,
    display: `${trailingRealizedLossesPct.toFixed(1)}% of portfolio`,
    qualLabel: label,
    explanation: 'Realized losses are permanent NAV impairments. A persistent trend undermines the manager\'s credit selection.',
  };
}

/**
 * Score dividend coverage.
 * NII / Dividend < 1.0 means the dividend is not covered by earnings.
 */
function scoreDividendCoverage(coverage) {
  let raw;
  let label;
  if (coverage >= 1.15) {
    raw = 95; label = 'Well-covered';
  } else if (coverage >= 1.05) {
    raw = 78; label = 'Adequately covered';
  } else if (coverage >= 1.00) {
    raw = 60; label = 'Barely covered';
  } else if (coverage >= 0.95) {
    raw = 35; label = 'Uncovered — potential cut risk';
  } else {
    raw = 15; label = 'Significantly uncovered';
  }
  return {
    key: 'dividendCoverage',
    label: 'Dividend / NII Coverage',
    weight: 0.10,
    raw,
    display: `${(coverage * 100).toFixed(0)}%`,
    qualLabel: label,
    explanation: 'Coverage <100% means the BDC is distributing capital, not earnings — a sustainable dividend requires NII coverage.',
  };
}

// ─── Main Scorer ──────────────────────────────────────────────────────────────

/**
 * Compute NAV Trust Score for a single BDC record.
 *
 * @param {object} bdc - A record from BDC_UNIVERSE
 * @returns {{ score: number, grade: string, components: object[] }}
 */
export function computeNAVTrustScore(bdc) {
  const { assetQuality, sectorExposure } = bdc;

  const components = [
    scoreNonAccrual(assetQuality.nonAccrualFVPct),
    scorePIK(assetQuality.pikIncomePct, assetQuality.pikIncomePriorQuarterPct),
    scoreMarkdown(assetQuality.qoqMarkdownPct),
    scoreSectorConcentration(sectorExposure),
    scoreRealizedLosses(assetQuality.trailingRealizedLossesPct),
    scoreDividendCoverage(assetQuality.dividendCoverage),
  ];

  // Weighted sum
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const weightedScore = components.reduce((s, c) => s + c.raw * c.weight, 0);
  const score = Math.round(weightedScore / totalWeight);

  // Letter grade
  let grade;
  if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'F';

  return { score, grade, components };
}

/**
 * Compute discount % and 30-day change.
 * (Simplified: uses the oldest vs latest price for the "30d" proxy in mock data)
 */
export function computeValuationMetrics(bdc) {
  const { price, nav, priceHistory } = bdc.valuation;
  const discount = ((price - nav) / nav) * 100;

  // 30-day change proxy: compare most recent vs 2 quarters ago in mock
  const priceLen = priceHistory.length;
  const price30dAgo = priceLen >= 2 ? priceHistory[priceLen - 2].value : price;
  const nav30dAgo = priceLen >= 2 ? bdc.valuation.navHistory[priceLen - 2]?.value ?? nav : nav;
  const discount30dAgo = ((price30dAgo - nav30dAgo) / nav30dAgo) * 100;
  const discountChange30d = discount - discount30dAgo;

  // Simplified z-score based on discount position relative to historical
  const discountValues = priceHistory.map((p, i) => {
    const n = bdc.valuation.navHistory[i]?.value ?? nav;
    return ((p.value - n) / n) * 100;
  });
  const mean = discountValues.reduce((a, b) => a + b, 0) / discountValues.length;
  const variance = discountValues.reduce((a, b) => a + (b - mean) ** 2, 0) / discountValues.length;
  const stdDev = Math.sqrt(variance);
  const zScore = stdDev > 0 ? (discount - mean) / stdDev : 0;

  return {
    price,
    nav,
    discount: parseFloat(discount.toFixed(2)),
    discountChange30d: parseFloat(discountChange30d.toFixed(2)),
    zScore: parseFloat(zScore.toFixed(2)),
    priceToNav: parseFloat((price / nav).toFixed(4)),
  };
}

/**
 * Generate alerts for a BDC based on computed metrics + raw data.
 */
export function generateAlerts(bdc, valuation, navTrust) {
  const alerts = [];
  const { assetQuality, sectorExposure, insiderActivity } = bdc;
  const { components } = navTrust;

  // Discount widening
  if (valuation.discountChange30d < -5) {
    alerts.push({
      type: 'discount_widening',
      severity: 'high',
      label: 'Discount Widened',
      detail: `Discount widened ${Math.abs(valuation.discountChange30d).toFixed(1)}% in ~30 days`,
    });
  }

  // PIK spike
  const pikDelta = assetQuality.pikIncomePct - assetQuality.pikIncomePriorQuarterPct;
  if (pikDelta * 100 > 100) {
    alerts.push({
      type: 'pik_spike',
      severity: 'high',
      label: 'PIK Spike',
      detail: `PIK income rose ${(pikDelta * 100).toFixed(0)}bps QoQ (${assetQuality.pikIncomePriorQuarterPct.toFixed(1)}% → ${assetQuality.pikIncomePct.toFixed(1)}%)`,
    });
  }

  // Dividend uncovered
  if (assetQuality.dividendCoverage < 1.0) {
    alerts.push({
      type: 'uncovered_dividend',
      severity: 'high',
      label: 'Uncovered Dividend',
      detail: `NII covers only ${(assetQuality.dividendCoverage * 100).toFixed(0)}% of dividend`,
    });
  }

  // Insider buy below NAV
  const recentBuys = insiderActivity.filter(a => a.type === 'buy' && a.price < bdc.valuation.nav);
  recentBuys.forEach(buy => {
    alerts.push({
      type: 'insider_buy',
      severity: 'info',
      label: 'Insider Buy Below NAV',
      detail: `${buy.insider} (${buy.title}) bought ${buy.shares.toLocaleString()} shares @ $${buy.price.toFixed(2)} on ${buy.date}`,
    });
  });

  // Software concentration
  if (sectorExposure.software > 30) {
    alerts.push({
      type: 'concentration',
      severity: 'medium',
      label: 'Software Concentration',
      detail: `Software/tech exposure at ${sectorExposure.software.toFixed(1)}% — above 30% threshold`,
    });
  }

  // Material markdown
  if (assetQuality.qoqMarkdownPct < -1.0) {
    alerts.push({
      type: 'markdown',
      severity: 'medium',
      label: 'Material Markdown',
      detail: `Portfolio marked down ${Math.abs(assetQuality.qoqMarkdownPct).toFixed(1)}% QoQ`,
    });
  }

  return alerts;
}

/**
 * Process the full BDC universe and return enriched records ready for the UI.
 */
export function enrichBDCUniverse(universe) {
  return universe.map(bdc => {
    const valuation = computeValuationMetrics(bdc);
    const navTrust = computeNAVTrustScore(bdc);
    const alerts = generateAlerts(bdc, valuation, navTrust);

    return {
      ...bdc,
      computed: {
        valuation,
        navTrust,
        alerts,
      },
    };
  });
}
