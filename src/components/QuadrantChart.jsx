import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Cell, Label
} from 'recharts';

// Color per quadrant
function getQuadrantColor(discount, navTrustScore) {
  const cheap = discount < -5;          // trading at >5% discount
  const trusted = navTrustScore >= 55;  // trust score above midpoint

  if (cheap && trusted)  return '#22c55e';   // green  — opportunity
  if (cheap && !trusted) return '#ef4444';   // red    — value trap
  if (!cheap && trusted) return '#94a3b8';   // gray   — fairly priced
  return '#f59e0b';                          // amber  — richly priced + questionable
}

function getQuadrantLabel(discount, navTrustScore) {
  const cheap = discount < -5;
  const trusted = navTrustScore >= 55;
  if (cheap && trusted)  return 'Opportunity';
  if (cheap && !trusted) return 'Value Trap';
  if (!cheap && trusted) return 'Fairly Priced';
  return 'Avoid';
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-slate-800 border border-slate-600 rounded-lg p-3 shadow-xl text-sm">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
        <span className="font-bold text-white">{d.ticker}</span>
        <span className="text-slate-400 text-xs ml-1">{d.name}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-slate-400">Discount</span>
        <span className={`font-mono font-semibold ${d.discount < 0 ? 'text-red-300' : 'text-emerald-300'}`}>
          {d.discount >= 0 ? '+' : ''}{d.discount.toFixed(1)}%
        </span>
        <span className="text-slate-400">NAV Trust</span>
        <span className="font-mono text-slate-200">{d.navTrustScore} / 100</span>
        <span className="text-slate-400">Grade</span>
        <span className="font-mono text-slate-200">{d.grade}</span>
        <span className="text-slate-400">Price</span>
        <span className="font-mono text-slate-200">${d.price.toFixed(2)}</span>
        <span className="text-slate-400">NAV</span>
        <span className="font-mono text-slate-200">${d.nav.toFixed(2)}</span>
        <span className="text-slate-400">Quadrant</span>
        <span className="font-semibold" style={{ color: d.color }}>{d.quadrant}</span>
      </div>
      {d.alerts > 0 && (
        <div className="mt-2 pt-2 border-t border-slate-700 text-xs text-red-400">
          ⚠ {d.alerts} active alert{d.alerts > 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

// Custom dot with ticker label
function CustomDot(props) {
  const { cx, cy, payload, selectedTicker, onSelect } = props;
  if (cx == null || cy == null) return null;

  const isSelected = selectedTicker === payload.ticker;
  const r = isSelected ? 14 : 10;

  return (
    <g
      onClick={() => onSelect(payload.ticker === selectedTicker ? null : payload.ticker)}
      style={{ cursor: 'pointer' }}
    >
      {isSelected && (
        <circle cx={cx} cy={cy} r={r + 5} fill={payload.color} opacity={0.2} />
      )}
      <circle
        cx={cx} cy={cy} r={r}
        fill={payload.color}
        fillOpacity={0.85}
        stroke={isSelected ? '#fff' : payload.color}
        strokeWidth={isSelected ? 2 : 1}
      />
      <text
        x={cx} y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#fff"
        fontSize={isSelected ? 11 : 9}
        fontWeight="bold"
        fontFamily="system-ui"
        pointerEvents="none"
      >
        {payload.ticker}
      </text>
    </g>
  );
}

// Quadrant label overlay
function QuadrantLabels() {
  return (
    <>
      {/* Top-right: Fairly Priced */}
      <text x="74%" y="12%" textAnchor="middle" fill="#475569" fontSize={10} fontFamily="system-ui">
        Fairly Priced
      </text>
      {/* Top-left: Opportunity */}
      <text x="18%" y="12%" textAnchor="middle" fill="#166534" fontSize={10} fontFamily="system-ui">
        ✦ Opportunity
      </text>
      {/* Bottom-right: Avoid */}
      <text x="74%" y="88%" textAnchor="middle" fill="#78350f" fontSize={10} fontFamily="system-ui">
        Avoid
      </text>
      {/* Bottom-left: Value Trap */}
      <text x="18%" y="88%" textAnchor="middle" fill="#7f1d1d" fontSize={10} fontFamily="system-ui">
        ⚠ Value Trap
      </text>
    </>
  );
}

export default function QuadrantChart({ data, selectedTicker, onSelectTicker }) {
  const chartData = data.map(bdc => ({
    ticker: bdc.ticker,
    name: bdc.name,
    discount: bdc.computed.valuation.discount,
    navTrustScore: bdc.computed.navTrust.score,
    grade: bdc.computed.navTrust.grade,
    price: bdc.computed.valuation.price,
    nav: bdc.computed.valuation.nav,
    alerts: bdc.computed.alerts.length,
    color: getQuadrantColor(bdc.computed.valuation.discount, bdc.computed.navTrust.score),
    quadrant: getQuadrantLabel(bdc.computed.valuation.discount, bdc.computed.navTrust.score),
  }));

  return (
    <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-slate-200">Opportunity Map</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Click a dot to select · Discount to NAV (x) vs NAV Trust Score (y)
        </p>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-4 text-xs">
        {[
          { color: '#22c55e', label: 'Opportunity (cheap + trustworthy)' },
          { color: '#ef4444', label: 'Value Trap (cheap + questionable)' },
          { color: '#94a3b8', label: 'Fairly Priced' },
          { color: '#f59e0b', label: 'Avoid' },
        ].map(l => (
          <div key={l.label} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: l.color }} />
            <span className="text-slate-400">{l.label}</span>
          </div>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={340}>
        <ScatterChart margin={{ top: 20, right: 30, bottom: 30, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />

          {/* Vertical reference line: discount = -5% (cheap threshold) */}
          <ReferenceLine x={-5} stroke="#475569" strokeDasharray="4 3" strokeWidth={1} />
          {/* Horizontal reference line: trust score = 55 (trust threshold) */}
          <ReferenceLine y={55} stroke="#475569" strokeDasharray="4 3" strokeWidth={1} />

          <XAxis
            type="number"
            dataKey="discount"
            domain={['auto', 'auto']}
            tick={{ fontSize: 10, fill: '#64748b', fontFamily: 'monospace' }}
            tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`}
          >
            <Label value="Discount to NAV (%)" position="insideBottom" offset={-15} fill="#64748b" fontSize={11} />
          </XAxis>

          <YAxis
            type="number"
            dataKey="navTrustScore"
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: '#64748b', fontFamily: 'monospace' }}
            tickFormatter={v => `${v}`}
          >
            <Label value="NAV Trust Score" angle={-90} position="insideLeft" offset={15} fill="#64748b" fontSize={11} />
          </YAxis>

          <Tooltip content={<CustomTooltip />} cursor={false} />

          <Scatter
            data={chartData}
            shape={(props) => (
              <CustomDot
                {...props}
                selectedTicker={selectedTicker}
                onSelect={onSelectTicker}
              />
            )}
          >
            {chartData.map((entry) => (
              <Cell key={entry.ticker} fill={entry.color} />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
