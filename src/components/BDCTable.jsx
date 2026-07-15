import { useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, AlertTriangle, Info, TrendingDown } from 'lucide-react';
import DataSourceBadge from './DataSourceBadge';

const SEVERITY_COLOR = {
  high: 'text-red-400',
  medium: 'text-yellow-400',
  info: 'text-blue-400',
};

function SortIcon({ col, sortKey, sortDir }) {
  if (sortKey !== col) return <ChevronsUpDown size={13} className="ml-1 text-slate-500 inline" />;
  return sortDir === 'asc'
    ? <ChevronUp size={13} className="ml-1 text-indigo-400 inline" />
    : <ChevronDown size={13} className="ml-1 text-indigo-400 inline" />;
}

function DiscountBadge({ discount }) {
  const abs = Math.abs(discount);
  let color;
  if (discount < -15) color = 'bg-red-900/60 text-red-300 border border-red-700/50';
  else if (discount < -8) color = 'bg-orange-900/60 text-orange-300 border border-orange-700/50';
  else if (discount < -3) color = 'bg-yellow-900/60 text-yellow-300 border border-yellow-700/50';
  else if (discount < 0) color = 'bg-slate-700/60 text-slate-300 border border-slate-600/50';
  else color = 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/50';

  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold ${color}`}>
      {discount < 0 ? '-' : '+'}{abs.toFixed(1)}%
    </span>
  );
}

function TrustBar({ score, incomplete }) {
  if (score == null) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-slate-700/50 rounded-full overflow-hidden" />
        <span className="text-xs font-mono text-slate-600 w-6 text-right" title="No asset-quality data yet">—</span>
      </div>
    );
  }

  let barColor;
  if (score >= 75) barColor = 'bg-emerald-500';
  else if (score >= 55) barColor = 'bg-yellow-500';
  else if (score >= 35) barColor = 'bg-orange-500';
  else barColor = 'bg-red-500';

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all ${incomplete ? 'opacity-50' : ''}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-xs font-mono w-6 text-right ${incomplete ? 'text-slate-400' : 'text-slate-200'}`} title={incomplete ? 'Partial score — some asset-quality data still missing' : undefined}>
        {score}{incomplete ? '*' : ''}
      </span>
    </div>
  );
}

function CoverageChip({ coverage }) {
  if (coverage == null) {
    return <span className="text-xs font-mono text-slate-600" title="No dividend coverage data yet">—</span>;
  }
  const pct = (coverage * 100).toFixed(0);
  const covered = coverage >= 1.0;
  return (
    <span className={`text-xs font-mono ${covered ? 'text-emerald-400' : 'text-red-400 font-semibold'}`}>
      {pct}%{!covered && ' ⚠'}
    </span>
  );
}

function AlertBubbles({ alerts }) {
  if (!alerts || alerts.length === 0) return <span className="text-slate-600 text-xs">—</span>;
  const highs = alerts.filter(a => a.severity === 'high').length;
  const meds = alerts.filter(a => a.severity === 'medium').length;
  const infos = alerts.filter(a => a.severity === 'info').length;

  return (
    <div className="flex items-center gap-1">
      {highs > 0 && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-900/50 text-red-400 text-xs border border-red-700/40">
          <AlertTriangle size={10} />{highs}
        </span>
      )}
      {meds > 0 && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-400 text-xs border border-yellow-700/40">
          <TrendingDown size={10} />{meds}
        </span>
      )}
      {infos > 0 && (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400 text-xs border border-blue-700/40">
          <Info size={10} />{infos}
        </span>
      )}
    </div>
  );
}

const COLUMNS = [
  { key: 'ticker',           label: 'Ticker',           align: 'left' },
  { key: 'discount',         label: 'Discount',         align: 'center' },
  { key: 'discountChange30d',label: '30d Δ',            align: 'center' },
  { key: 'zScore',           label: 'Z-Score',          align: 'center' },
  { key: 'price',            label: 'Price',            align: 'right' },
  { key: 'nav',              label: 'NAV',              align: 'right' },
  { key: 'navTrustScore',    label: 'NAV Trust',        align: 'left' },
  { key: 'software',         label: 'Soft %',           align: 'center' },
  { key: 'coverage',         label: 'Div Cov',          align: 'center' },
  { key: 'pik',              label: 'PIK %',            align: 'center' },
  { key: 'alerts',           label: 'Alerts',           align: 'left' },
];

export default function BDCTable({ data, onSelectTicker, selectedTicker }) {
  const [sortKey, setSortKey] = useState('discount');
  const [sortDir, setSortDir] = useState('asc'); // ascending = biggest discount first

  function handleSort(col) {
    if (sortKey === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(col);
      setSortDir('asc');
    }
  }

  function getValue(row, key) {
    switch (key) {
      case 'ticker':            return row.ticker;
      case 'discount':          return row.computed.valuation.discount;
      case 'discountChange30d': return row.computed.valuation.discountChange30d;
      case 'zScore':            return row.computed.valuation.zScore;
      case 'price':             return row.computed.valuation.price;
      case 'nav':               return row.computed.valuation.nav;
      case 'navTrustScore':     return row.computed.navTrust.score;
      case 'software':          return row.sectorExposure.software;
      case 'coverage':          return row.assetQuality.dividendCoverage;
      case 'pik':               return row.assetQuality.pikIncomePct;
      case 'alerts':            return row.computed.alerts.length;
      default:                  return 0;
    }
  }

  const sorted = [...data].sort((a, b) => {
    const av = getValue(a, sortKey);
    const bv = getValue(b, sortKey);
    // Nulls (missing data) always sort to the bottom regardless of
    // direction, rather than silently coercing to 0 in the subtraction
    // below (which would rank "unknown" as if it were the best/worst
    // possible value depending on sort direction).
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700/50 bg-slate-800/40">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-700/60">
            {COLUMNS.map(col => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                className={`px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 select-none whitespace-nowrap text-${col.align}`}
              >
                {col.label}
                <SortIcon col={col.key} sortKey={sortKey} sortDir={sortDir} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((bdc, i) => {
            const v = bdc.computed.valuation;
            const nt = bdc.computed.navTrust;
            const aq = bdc.assetQuality;
            const sx = bdc.sectorExposure;
            const isSelected = selectedTicker === bdc.ticker;

            return (
              <tr
                key={bdc.ticker}
                onClick={() => onSelectTicker(bdc.ticker === selectedTicker ? null : bdc.ticker)}
                className={`
                  border-b border-slate-700/30 cursor-pointer transition-colors
                  ${isSelected
                    ? 'bg-indigo-900/30 border-indigo-700/40'
                    : i % 2 === 0 ? 'bg-slate-800/20 hover:bg-slate-700/30' : 'hover:bg-slate-700/30'}
                `}
              >
                {/* Ticker */}
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-white">{bdc.ticker}</span>
                      <DataSourceBadge dataSource={bdc.meta?.dataSource} />
                    </div>
                    <span className="text-xs text-slate-500 truncate max-w-[140px]">{bdc.name}</span>
                  </div>
                </td>

                {/* Discount */}
                <td className="px-4 py-3 text-center">
                  <DiscountBadge discount={v.discount} />
                </td>

                {/* 30d Change */}
                <td className="px-4 py-3 text-center font-mono text-xs">
                  <span className={v.discountChange30d < -1 ? 'text-red-400' : v.discountChange30d > 1 ? 'text-emerald-400' : 'text-slate-400'}>
                    {v.discountChange30d >= 0 ? '+' : ''}{v.discountChange30d.toFixed(1)}%
                  </span>
                </td>

                {/* Z-Score */}
                <td className="px-4 py-3 text-center font-mono text-xs">
                  <span className={
                    v.zScore < -1.5 ? 'text-red-400' :
                    v.zScore < -0.5 ? 'text-orange-400' :
                    v.zScore > 0.5 ? 'text-emerald-400' : 'text-slate-400'
                  }>
                    {v.zScore >= 0 ? '+' : ''}{v.zScore.toFixed(2)}σ
                  </span>
                </td>

                {/* Price */}
                <td className="px-4 py-3 text-right font-mono text-slate-200 text-xs">
                  ${v.price.toFixed(2)}
                </td>

                {/* NAV */}
                <td className="px-4 py-3 text-right font-mono text-slate-200 text-xs">
                  ${v.nav.toFixed(2)}
                </td>

                {/* NAV Trust Score */}
                <td className="px-4 py-3 min-w-[120px]">
                  <TrustBar score={nt.score} incomplete={nt.dataCompleteness != null && nt.dataCompleteness < 1} />
                </td>

                {/* Software % */}
                <td className="px-4 py-3 text-center font-mono text-xs">
                  {sx.software == null ? (
                    <span className="text-slate-600">—</span>
                  ) : (
                    <span className={sx.software > 30 ? 'text-orange-400 font-semibold' : sx.software > 20 ? 'text-yellow-400' : 'text-slate-300'}>
                      {sx.software.toFixed(1)}%
                    </span>
                  )}
                </td>

                {/* Dividend Coverage */}
                <td className="px-4 py-3 text-center">
                  <CoverageChip coverage={aq.dividendCoverage} />
                </td>

                {/* PIK % */}
                <td className="px-4 py-3 text-center font-mono text-xs">
                  {aq.pikIncomePct == null ? (
                    <span className="text-slate-600">—</span>
                  ) : (
                    <span className={aq.pikIncomePct > 12 ? 'text-red-400' : aq.pikIncomePct > 8 ? 'text-orange-400' : 'text-slate-300'}>
                      {aq.pikIncomePct.toFixed(1)}%
                    </span>
                  )}
                </td>

                {/* Alerts */}
                <td className="px-4 py-3">
                  <AlertBubbles alerts={bdc.computed.alerts} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
