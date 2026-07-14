/**
 * Small badge indicating whether a BDC's data came from the live ETL
 * pipeline (Supabase) or is still falling back to the mock seed record
 * (see src/data/fetchLiveUniverse.js — a BDC falls back to mock whenever
 * the ETL hasn't yet produced a complete filing period + price snapshot
 * for it).
 */
export default function DataSourceBadge({ dataSource, className = '' }) {
  const isLive = dataSource !== 'mock_seed_v1';

  return (
    <span
      title={isLive ? `Live data · source: ${dataSource}` : 'Mock/seed data — ETL has not processed this BDC yet'}
      className={`
        inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide
        ${isLive
          ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-700/40'
          : 'bg-slate-700/50 text-slate-400 border border-slate-600/40'}
        ${className}
      `}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400' : 'bg-slate-500'}`} />
      {isLive ? 'Live' : 'Mock'}
    </span>
  );
}
