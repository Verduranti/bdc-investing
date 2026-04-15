import { AlertTriangle, TrendingDown, Info, Bell, ArrowUpRight } from 'lucide-react';

const ALERT_ICON = {
  high:   <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />,
  medium: <TrendingDown size={14} className="text-yellow-400 flex-shrink-0 mt-0.5" />,
  info:   <Info size={14} className="text-blue-400 flex-shrink-0 mt-0.5" />,
};

const ALERT_TYPE_LABELS = {
  discount_widening: 'Discount Widening',
  pik_spike:         'PIK Spike',
  uncovered_dividend:'Uncovered Dividend',
  insider_buy:       'Insider Buy',
  concentration:     'Concentration Risk',
  markdown:          'Material Markdown',
};

const SEVERITY_RING = {
  high:   'border-red-700/40 bg-red-900/20',
  medium: 'border-yellow-700/40 bg-yellow-900/10',
  info:   'border-blue-700/40 bg-blue-900/10',
};

const TICKER_COLORS = {
  ARCC: 'bg-indigo-500',
  BXSL: 'bg-purple-500',
  TSLX: 'bg-cyan-600',
  GBDC: 'bg-orange-500',
  FSK:  'bg-pink-600',
};

function TickerBadge({ ticker, onClick }) {
  const color = TICKER_COLORS[ticker] ?? 'bg-slate-600';
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold text-white ${color} hover:opacity-80 transition-opacity`}
    >
      {ticker}
      <ArrowUpRight size={10} />
    </button>
  );
}

function AlertCard({ alert, ticker, onSelectTicker }) {
  return (
    <div className={`rounded-lg border p-3 ${SEVERITY_RING[alert.severity]}`}>
      <div className="flex items-start gap-2">
        {ALERT_ICON[alert.severity]}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-semibold text-slate-200">{alert.label}</span>
            <TickerBadge ticker={ticker} onClick={() => onSelectTicker(ticker)} />
          </div>
          <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{alert.detail}</p>
        </div>
      </div>
    </div>
  );
}

export default function AlertsPanel({ data, onSelectTicker }) {
  // Flatten all alerts across BDCs, tagged with ticker
  const allAlerts = data.flatMap(bdc =>
    (bdc.computed.alerts ?? []).map(a => ({ ...a, ticker: bdc.ticker }))
  );

  const high   = allAlerts.filter(a => a.severity === 'high');
  const medium = allAlerts.filter(a => a.severity === 'medium');
  const info   = allAlerts.filter(a => a.severity === 'info');

  const ordered = [...high, ...medium, ...info];

  return (
    <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell size={15} className="text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-200">Active Alerts</h3>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {high.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-red-900/50 text-red-400 border border-red-700/40 font-semibold">
              {high.length} HIGH
            </span>
          )}
          {medium.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-yellow-900/50 text-yellow-400 border border-yellow-700/40">
              {medium.length} MED
            </span>
          )}
          {info.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-900/50 text-blue-400 border border-blue-700/40">
              {info.length} INFO
            </span>
          )}
        </div>
      </div>

      {/* Alert list */}
      {ordered.length === 0 ? (
        <div className="text-center py-8 text-slate-600 text-sm">
          No active alerts
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {ordered.map((alert, i) => (
            <AlertCard
              key={`${alert.ticker}-${alert.type}-${i}`}
              alert={alert}
              ticker={alert.ticker}
              onSelectTicker={onSelectTicker}
            />
          ))}
        </div>
      )}

      {/* Alert legend */}
      <div className="mt-auto pt-3 border-t border-slate-700/40 grid grid-cols-1 gap-1 text-xs text-slate-500">
        <div className="flex items-center gap-1.5"><AlertTriangle size={10} className="text-red-500" /> High: PIK spike &gt;100bps QoQ, uncovered dividend, discount widening &gt;5%</div>
        <div className="flex items-center gap-1.5"><TrendingDown size={10} className="text-yellow-500" /> Medium: sector concentration, material markdown</div>
        <div className="flex items-center gap-1.5"><Info size={10} className="text-blue-500" /> Info: insider buys below NAV</div>
      </div>
    </div>
  );
}
