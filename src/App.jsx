import { useState, useMemo, useEffect } from 'react';
import { Activity, AlertTriangle, Table2, ScatterChart, Bell, RefreshCw, ChevronRight } from 'lucide-react';

import BDCTable from './components/BDCTable';
import QuadrantChart from './components/QuadrantChart';
import AlertsPanel from './components/AlertsPanel';
import DetailDrawer from './components/DetailDrawer';

import { BDC_UNIVERSE } from './data/bdcData';
import { fetchLiveUniverse } from './data/fetchLiveUniverse';
import { enrichBDCUniverse } from './utils/scoring';

// ─── Mock fallback, rendered immediately while the live fetch resolves ────────
const MOCK_ENRICHED = enrichBDCUniverse(BDC_UNIVERSE);

// ─── Summary stat cards ───────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  return (
    <div className="bg-slate-800/50 rounded-xl border border-slate-700/40 px-4 py-3 flex flex-col gap-0.5">
      <span className="text-xs text-slate-500 uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-bold font-mono ${color ?? 'text-slate-100'}`}>{value}</span>
      {sub && <span className="text-xs text-slate-500">{sub}</span>}
    </div>
  );
}

// ─── Nav tabs ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'table',    label: 'Table',          icon: Table2 },
  { id: 'quadrant', label: 'Opportunity Map', icon: ScatterChart },
  { id: 'alerts',   label: 'Alerts',         icon: Bell },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('table');
  const [selectedTicker, setSelectedTicker] = useState(null);

  // Start with mock data so the UI renders instantly, then swap in live
  // Supabase data (or stay on mock, per-ticker, for anything the ETL
  // hasn't processed yet — see fetchLiveUniverse.js).
  const [universe, setUniverse] = useState(BDC_UNIVERSE);
  const [dataStatus, setDataStatus] = useState({ loading: true, liveCount: 0, error: null });

  useEffect(() => {
    let cancelled = false;
    fetchLiveUniverse().then(({ universe: live, liveTickers, error }) => {
      if (cancelled) return;
      setUniverse(live);
      setDataStatus({ loading: false, liveCount: liveTickers.length, error });
    });
    return () => { cancelled = true; };
  }, []);

  const ENRICHED = useMemo(() => enrichBDCUniverse(universe), [universe]);

  // Summary stats
  const stats = useMemo(() => {
    const totalAlerts = ENRICHED.reduce((s, b) => s + b.computed.alerts.length, 0);
    const highAlerts  = ENRICHED.reduce((s, b) => s + b.computed.alerts.filter(a => a.severity === 'high').length, 0);
    const discounts   = ENRICHED.map(b => b.computed.valuation.discount);
    const avgDiscount = discounts.reduce((a, b) => a + b, 0) / discounts.length;
    const biggestDiscount = Math.min(...discounts);
    const biggestDiscountTicker = ENRICHED.find(b => b.computed.valuation.discount === biggestDiscount)?.ticker;
    return { totalAlerts, highAlerts, avgDiscount, biggestDiscount, biggestDiscountTicker };
  }, [ENRICHED]);

  const selectedBDC = useMemo(
    () => ENRICHED.find(b => b.ticker === selectedTicker) ?? null,
    [ENRICHED, selectedTicker]
  );

  const activeAlertCount = ENRICHED.reduce((s, b) => s + b.computed.alerts.filter(a => a.severity === 'high').length, 0);

  const statusLabel = dataStatus.loading
    ? 'Loading live data…'
    : dataStatus.error
      ? 'Live data unavailable · Mock Data'
      : dataStatus.liveCount === 0
        ? 'Mock Data'
        : dataStatus.liveCount === ENRICHED.length
          ? 'Live'
          : `Live (${dataStatus.liveCount}/${ENRICHED.length}) · rest Mock`;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-200">

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-700/60 bg-slate-900/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Activity size={18} className="text-indigo-400" />
            <span className="font-bold text-white tracking-tight">BDC Stress Radar</span>
            <span className="hidden sm:inline text-xs text-slate-500 ml-1">· MVP v0.1 · {statusLabel}</span>
          </div>
          <div className="flex items-center gap-3">
            {activeAlertCount > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-red-400 bg-red-900/30 border border-red-700/40 rounded-full px-2.5 py-1">
                <AlertTriangle size={11} />
                {activeAlertCount} high-severity
              </div>
            )}
            <div className="text-xs text-slate-500 flex items-center gap-1.5">
              <RefreshCw size={11} className={dataStatus.loading ? 'animate-spin' : ''} />
              {dataStatus.loading ? 'Syncing…' : statusLabel}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-screen-2xl mx-auto w-full px-4 sm:px-6 flex-1 flex flex-col gap-4 py-4">

        {/* ── Summary cards ────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="BDCs Tracked"
            value={ENRICHED.length}
            sub={dataStatus.loading ? 'Loading…' : `${dataStatus.liveCount} live · ${ENRICHED.length - dataStatus.liveCount} mock`}
          />
          <StatCard
            label="Avg Discount"
            value={`${stats.avgDiscount >= 0 ? '+' : ''}${stats.avgDiscount.toFixed(1)}%`}
            sub="to reported NAV"
            color={stats.avgDiscount < -5 ? 'text-orange-400' : 'text-slate-100'}
          />
          <StatCard
            label="Deepest Discount"
            value={`${stats.biggestDiscount.toFixed(1)}%`}
            sub={stats.biggestDiscountTicker}
            color="text-red-400"
          />
          <StatCard
            label="High Alerts"
            value={stats.highAlerts}
            sub={`${stats.totalAlerts} total alerts`}
            color={stats.highAlerts > 0 ? 'text-red-400' : 'text-emerald-400'}
          />
        </div>

        {/* ── Main content: tabs + optional drawer ─────────────────────── */}
        <div className="flex gap-4 flex-1 min-h-0">

          {/* Left: tabs + panel */}
          <div className="flex-1 flex flex-col gap-3 min-w-0">

            {/* Tab bar */}
            <div className="flex items-center gap-1 bg-slate-800/50 rounded-xl border border-slate-700/40 p-1 w-fit">
              {TABS.map(tab => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`
                      flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all
                      ${isActive
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}
                    `}
                  >
                    <Icon size={14} />
                    {tab.label}
                    {tab.id === 'alerts' && stats.highAlerts > 0 && (
                      <span className="ml-1 px-1.5 py-0.5 rounded-full bg-red-600 text-white text-xs font-bold leading-none">
                        {stats.highAlerts}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Panel content */}
            {activeTab === 'table' && (
              <BDCTable
                data={ENRICHED}
                onSelectTicker={setSelectedTicker}
                selectedTicker={selectedTicker}
              />
            )}
            {activeTab === 'quadrant' && (
              <QuadrantChart
                data={ENRICHED}
                selectedTicker={selectedTicker}
                onSelectTicker={setSelectedTicker}
              />
            )}
            {activeTab === 'alerts' && (
              <AlertsPanel data={ENRICHED} onSelectTicker={(ticker) => {
                setSelectedTicker(ticker);
                setActiveTab('table');
              }} />
            )}

            {/* Hint when something is selected */}
            {selectedTicker && activeTab !== 'table' && (
              <div className="text-xs text-slate-500 flex items-center gap-1.5">
                <ChevronRight size={12} className="text-indigo-400" />
                {selectedTicker} detail pane open →
              </div>
            )}
          </div>

          {/* Right: Detail drawer (always visible when a ticker is selected) */}
          {selectedBDC && (
            <div className="w-80 xl:w-96 flex-shrink-0 rounded-xl overflow-hidden border border-slate-700/50 shadow-2xl">
              <DetailDrawer
                bdc={selectedBDC}
                onClose={() => setSelectedTicker(null)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-slate-700/40 py-3 px-6 text-xs text-slate-600 text-center">
        BDC Stress Radar MVP · Data is for research purposes only, not investment advice · {statusLabel}
      </footer>
    </div>
  );
}
