/**
 * Shared EDGAR Rate Limiter
 *
 * EDGAR publishes a ceiling of 10 requests/sec per client, and it applies
 * across everything you send them — not per endpoint. This module owns the
 * single gate that every EDGAR request in the ETL passes through.
 *
 * It used to be three copies of the same eight-line helper — one each in
 * submissions.js, xbrl.js and form4.js — with a module-scoped `_lastCall`
 * apiece. (form4.js never actually called its copy; all of its EDGAR
 * traffic goes through the submissions.js helpers. So two were live.) Each
 * copy honoured the 110ms gap only against its OWN previous request, so
 * they ran as independent ~9/sec budgets that interleaved freely: ~18/sec
 * in aggregate against a 10/sec ceiling. That works until EDGAR starts
 * throttling, and then the TAIL of a run fails — the 2026-08-17 nightly
 * run lost TPVG, TRIN, TSLX and WHF to
 * HTTP 429 (the last four tickers alphabetically) after the first 42
 * processed fine, which is the signature of sustained over-limit traffic
 * rather than anything wrong with those four filers.
 *
 * Requests are queued rather than merely delayed. A single shared
 * `_lastCall` would still let two concurrent callers read the same
 * timestamp and fire together; chaining gives each caller its own slot.
 * The chain is on the SLOT, not on `fn()` completion — the next caller
 * waits 110ms from when this one started, not from when its response came
 * back, which preserves the original throughput. companyfacts blobs take
 * seconds to download, so gating on completion would have made a full
 * 46-BDC run dramatically slower.
 */

import { EDGAR_RATE_LIMIT_MS } from '../constants.js';

let _lastCall = 0;
let _gate = Promise.resolve();

/**
 * Run `fn` no sooner than EDGAR_RATE_LIMIT_MS after the previous EDGAR
 * request across the whole ETL. Returns whatever `fn` returns.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function rateLimited(fn) {
  const slot = _gate.then(async () => {
    const wait = EDGAR_RATE_LIMIT_MS - (Date.now() - _lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
  });
  // Only ever awaits a timer, so it cannot reject and wedge the queue.
  _gate = slot;
  return slot.then(() => fn());
}
