/**
 * ETL Healthcheck
 *
 * Checks that the ETL has run successfully within the last 48 hours.
 * Exits with code 1 (failing the CI job) if not — which triggers
 * a GitHub Actions notification.
 *
 * Run: node server/etl/healthcheck.js
 */

import { supabase } from './db/client.js';

const MAX_STALE_HOURS = 48;

const { data, error } = await supabase
  .from('etl_runs')
  .select('run_at, status')
  .eq('status', 'success')
  .order('run_at', { ascending: false })
  .limit(1)
  .single();

if (error || !data) {
  console.error('Healthcheck FAILED: No successful ETL run found in database');
  process.exit(1);
}

const lastRun     = new Date(data.run_at);
const hoursSince  = (Date.now() - lastRun.getTime()) / 1000 / 3600;

if (hoursSince > MAX_STALE_HOURS) {
  console.error(`Healthcheck FAILED: Last successful ETL was ${hoursSince.toFixed(1)}h ago (limit: ${MAX_STALE_HOURS}h)`);
  process.exit(1);
}

console.log(`Healthcheck OK: Last successful ETL ran ${hoursSince.toFixed(1)}h ago (${data.run_at})`);
