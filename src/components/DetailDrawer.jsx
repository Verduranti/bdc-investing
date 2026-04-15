import { X, ChevronRight, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell
} from 'recharts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatRow({ label, value, subValue, highlight }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-700/30 last:border-0">
      <span className="text-xs text-slate-400">{label}</span>
      <div className="text-right">
        <span className={`text-xs font-mono font-semibold ${highlight ?? 'text-slate-200'}`}>{value}</span>
        {subValue && <div className="text-xs text-slate-500">{subValue}</div>}
      </div>
    </div>
  );
}

function ScoreComponentBar({ component }) {
  const width = `${component.raw}%`;
  let color;
  if (component.raw >= 75) color = 'bg-emerald-500';
  else if (component.raw >= 55) color = 'bg-yellow-500';
  else if (component.raw >= 35) color = 'bg-orange-500';
  else color = 'bg-red-500';

  return (
    <div className="py-1.5 border-b border-slate-700/20 last:border-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-300">{component.label}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">{(component.weight * 100).toFixed(0)}% wt</span>
          <span className="text-xs font-mono font-semibold text-slate-200 w-6 text-right">{component.raw}</span>
        </div>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width }} />
      </div>
      <div className="text-xs text-slate-500 mt-0.5">{component.qualLabel}</div>
    </div>
  );
}

function SectorBar({ label, value, threshold }) {
  const isHigh = threshold && value > threshold;
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-xs text-slate-400 w-24 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${isHigh ? 'bg-orange-500' : 'bg-indigo-500'}`}
          style={{ width: `${Math.min(value, 50) * 2}%` }}
        />
      </div>
      <span className={`text-xs font-mono w-8 text-right ${isHigh ? 'text-orange-400 font-semibold' : 'text-slate-300'}`}>
        {value.toFixed(1)}%
      </span>
    </div>
  );
}

function InsiderBadge({ activity }) {
  if (!activity || activity.length === 0) {
    return <span className="text-xs text-slate-600">No recent Form 4 activity</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {activity.map((a, i) => (
        <div key={i} className={`flex items-center gap-2 text-xs rounded px-2 py-1 ${a.type === 'buy' ? 'bg-emerald-900/30 text-emerald-300' : 'bg-red-900/30 text-red-300'}`}>
          <span className="font-semibold uppercase">{a.type}</span>
          <span className="text-slate-400">{a.insider}</span>
          <span className="ml-auto font-mono">{a.shares.toLocaleString()} @ ${a.price.toFixed(2)}</span>
          <span className="text-slate-500">{a.date}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Mini-charts ──────────────────────────────────────────────────────────────

function PriceNavChart({ bdc }) {
  const priceHistory = bdc.valuation.priceHistory ?? [];
  const navHistory   = bdc.valuation.navHistory ?? [];

  const combined = priceHistory.map((p, i) => ({
    date: p.date.slice(0, 7),
    price: parseFloat(p.value.toFixed(2)),
    nav:   parseFloat((navHistory[i]?.value ?? bdc.valuation.nav).toFixed(2)),
  }));

  return (
    <ResponsiveContainer width="100%" height={100}>
      <AreaChart data={combined} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="navGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.2} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" hide />
        <YAxis hide domain={['auto', 'auto']} />
        <Tooltip
          contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', fontSize: '11px' }}
          labelStyle={{ color: '#94a3b8' }}
          itemStyle={{ color: '#e2e8f0' }}
        />
        <Area type="monotone" dataKey="nav"   stroke="#6366f1" strokeWidth={1.5} fill="url(#navGrad)"   dot={false} name="NAV" />
        <Area type="monotone" dataKey="price" stroke="#22c55e" strokeWidth={1.5} fill="url(#priceGrad)" dot={false} name="Price" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Main Drawer ──────────────────────────────────────────────────────────────

export default function DetailDrawer({ bdc, onClose }) {
  if (!bdc) return null;

  const { computed, assetQuality, sectorExposure, insiderActivity, valuation, meta } = bdc;
  const { valuation: v, navTrust, alerts } = computed;

  const discountColor = v.discount < -10 ? 'text-red-400' :
    v.discount < -5 ? 'text-orange-400' :
    v.discount < 0 ? 'text-yellow-400' : 'text-emerald-400';

  const trustColor = navTrust.score >= 75 ? 'text-emerald-400' :
    navTrust.score >= 55 ? 'text-yellow-400' :
    navTrust.score >= 35 ? 'text-orange-400' : 'text-red-400';

  return (
    <div className="flex flex-col h-full bg-slate-900 border-l border-slate-700/60">
      {/* Header */}
      <div className="flex items-start justify-between p-4 border-b border-slate-700/60">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-white">{bdc.ticker}</span>
            <span className={`text-lg font-bold ${discountColor}`}>
              {v.discount >= 0 ? '+' : ''}{v.discount.toFixed(1)}%
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-0.5">{bdc.name}</div>
          <div className="text-xs text-slate-500">{bdc.manager} · {meta.filingPeriod}</div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">

        {/* Key stats row */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-slate-800/60 rounded-lg p-3">
            <div className="text-xs text-slate-500 mb-1">NAV Trust Score</div>
            <div className={`text-2xl font-bold ${trustColor}`}>{navTrust.score}</div>
            <div className="text-xs text-slate-400">Grade: {navTrust.grade}</div>
          </div>
          <div className="bg-slate-800/60 rounded-lg p-3">
            <div className="text-xs text-slate-500 mb-1">Price / NAV</div>
            <div className="text-2xl font-bold text-slate-200">{v.priceToNav.toFixed(3)}x</div>
            <div className="text-xs text-slate-400">Z-Score: {v.zScore >= 0 ? '+' : ''}{v.zScore.toFixed(2)}σ</div>
          </div>
        </div>

        {/* Price vs NAV mini-chart */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-300">Price vs NAV — 12 Quarter History</span>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-indigo-400 inline-block rounded" /> NAV</span>
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-400 inline-block rounded" /> Price</span>
            </div>
          </div>
          <PriceNavChart bdc={bdc} />
        </div>

        {/* Valuation detail */}
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">Valuation</div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <StatRow label="Price" value={`$${v.price.toFixed(2)}`} />
            <StatRow label="NAV" value={`$${v.nav.toFixed(2)}`} />
            <StatRow label="Discount" value={`${v.discount >= 0 ? '+' : ''}${v.discount.toFixed(2)}%`} highlight={discountColor} />
            <StatRow label="30d Discount Δ" value={`${v.discountChange30d >= 0 ? '+' : ''}${v.discountChange30d.toFixed(2)}%`}
              highlight={v.discountChange30d < -2 ? 'text-red-400' : 'text-slate-200'} />
            <StatRow label="Discount Z-Score" value={`${v.zScore >= 0 ? '+' : ''}${v.zScore.toFixed(2)}σ`} />
            <StatRow label="Annual Dividend" value={`$${valuation.dividendAnnual.toFixed(2)}`} subValue={valuation.dividendFrequency} />
            <StatRow label="Div / NII Coverage"
              value={`${(assetQuality.dividendCoverage * 100).toFixed(0)}%`}
              highlight={assetQuality.dividendCoverage < 1 ? 'text-red-400' : 'text-emerald-400'}
            />
          </div>
        </div>

        {/* NAV Trust Score breakdown */}
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">NAV Trust Score Breakdown</div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            {navTrust.components.map(c => (
              <ScoreComponentBar key={c.key} component={c} />
            ))}
          </div>
        </div>

        {/* Asset quality */}
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">Asset Quality</div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <StatRow label="Non-Accrual (cost)" value={`${assetQuality.nonAccrualCostPct.toFixed(1)}%`} />
            <StatRow label="Non-Accrual (FV)" value={`${assetQuality.nonAccrualFVPct.toFixed(1)}%`}
              highlight={assetQuality.nonAccrualFVPct > 2 ? 'text-orange-400' : 'text-slate-200'} />
            <StatRow label="PIK Income" value={`${assetQuality.pikIncomePct.toFixed(1)}%`}
              subValue={`Prior: ${assetQuality.pikIncomePriorQuarterPct.toFixed(1)}% (Δ${((assetQuality.pikIncomePct - assetQuality.pikIncomePriorQuarterPct) * 100).toFixed(0)}bps)`}
              highlight={assetQuality.pikIncomePct > 10 ? 'text-red-400' : 'text-slate-200'} />
            <StatRow label="QoQ Markdown" value={`${assetQuality.qoqMarkdownPct >= 0 ? '+' : ''}${assetQuality.qoqMarkdownPct.toFixed(2)}%`}
              highlight={assetQuality.qoqMarkdownPct < -0.5 ? 'text-orange-400' : 'text-slate-200'} />
            <StatRow label="Realized Losses" value={`${assetQuality.trailingRealizedLossesPct.toFixed(1)}%`}
              highlight={assetQuality.trailingRealizedLossesPct > 1.5 ? 'text-orange-400' : 'text-slate-200'} />
          </div>
        </div>

        {/* Sector exposure */}
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">Sector Exposure</div>
          <div className="bg-slate-800/40 rounded-lg p-3 space-y-1">
            <SectorBar label="Software/Tech" value={sectorExposure.software} threshold={25} />
            <SectorBar label="Healthcare" value={sectorExposure.healthcare} />
            <SectorBar label="Consumer" value={sectorExposure.consumer} />
            <SectorBar label="Industrial" value={sectorExposure.industrial} />
            <SectorBar label="Asset-Backed" value={sectorExposure.assetBacked} />
            <SectorBar label="Financial" value={sectorExposure.financial} />
            <SectorBar label="Other" value={sectorExposure.other} />
            <div className="pt-2 mt-2 border-t border-slate-700/40">
              <SectorBar label="Top-10 Holdings" value={sectorExposure.top10HoldingsPct} threshold={28} />
            </div>
          </div>
        </div>

        {/* Insider activity */}
        <div>
          <div className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">Insider Activity (Form 4)</div>
          <div className="bg-slate-800/40 rounded-lg p-3">
            <InsiderBadge activity={insiderActivity} />
          </div>
        </div>

        {/* Active alerts */}
        {alerts.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">Active Alerts</div>
            <div className="space-y-2">
              {alerts.map((a, i) => (
                <div key={i} className={`rounded-lg border p-2.5 text-xs ${
                  a.severity === 'high' ? 'border-red-700/40 bg-red-900/20' :
                  a.severity === 'medium' ? 'border-yellow-700/40 bg-yellow-900/10' :
                  'border-blue-700/40 bg-blue-900/10'
                }`}>
                  <div className="font-semibold text-slate-200 mb-0.5">{a.label}</div>
                  <div className="text-slate-400">{a.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Data source footer */}
        <div className="text-xs text-slate-600 pt-2 border-t border-slate-700/30">
          Data source: {meta.dataSource} · Updated {meta.lastUpdated} · {meta.filingPeriod}
        </div>
      </div>
    </div>
  );
}
