/**
 * Market Price Fetcher
 *
 * Fetches daily OHLCV price data for BDC tickers via Yahoo Finance's v8
 * chart API. No API key required. Reasonable for personal use at this
 * data volume.
 *
 * Returns price history going back `days` calendar days, which is used for:
 *   - Current price (latest close)
 *   - 30-day discount change
 *   - 3-year z-score calculation
 *
 * Note: yahoo-finance2 v2.14+ dropped the `historical` module; we call
 * Yahoo's undocumented-but-stable v8/finance/chart endpoint directly.
 */

import yahooFinance from 'yahoo-finance2';

const YF_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; bdc-radar/1.0)',
  'Accept': 'application/json',
};

/**
 * Fetch historical daily closes for a single ticker via Yahoo Finance chart API.
 *
 * Returns BOTH series, because they answer different questions and are not
 * interchangeable:
 *
 *   close    - the raw traded price. This is what discount-to-NAV must be
 *              measured against, and it is stable: a past day's close does
 *              not change.
 *   adjClose - back-adjusted for every dividend since. Correct for
 *              total-return work, wrong for discount-to-NAV, and RESTATED
 *              on every ex-dividend date.
 *
 * This used to return only adjClose (under the name `close`), which broke
 * both properties at once. BDCs yield 8-17%, so three years of adjustment
 * is enormous — OXSQ closed at $3.06 on 2023-08-21 but its adjusted close
 * reads $1.71, a 44% gap (PSEC 37%, ARCC 25%, MAIN 21%). And because the
 * adjustment factor moves every month or quarter, the stored "history"
 * shifted underneath us on every run, which is the opposite of keeping one.
 *
 * @param {string} ticker
 * @param {number} days - lookback in calendar days (default 365*3 = 3yr)
 * @returns {Promise<Array<{date: string, close: number, adjClose: number|null, volume: number}>>}
 */
export async function fetchPriceHistory(ticker, days = 365 * 3) {
  const period1 = Math.floor((Date.now() - days * 86400 * 1000) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `${YF_CHART_URL}/${ticker}?interval=1d&period1=${period1}&period2=${period2}&events=div`;

  try {
    const res = await fetch(url, { headers: YF_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('No chart data in response');

    const timestamps = result.timestamp ?? [];
    // Raw close is the primary series and the one we filter on; adjusted is
    // carried alongside it and may legitimately be missing.
    const closes    = result.indicators?.quote?.[0]?.close ?? [];
    const adjCloses = result.indicators?.adjclose?.[0]?.adjclose ?? [];
    const volumes   = result.indicators?.quote?.[0]?.volume ?? [];

    return timestamps
      .map((ts, i) => ({
        date:     new Date(ts * 1000).toISOString().slice(0, 10),
        close:    closes[i]    != null ? parseFloat(closes[i].toFixed(4))    : null,
        adjClose: adjCloses[i] != null ? parseFloat(adjCloses[i].toFixed(4)) : null,
        volume:   volumes[i] ?? 0,
      }))
      .filter(r => r.close != null)
      .sort((a, b) => a.date.localeCompare(b.date));

  } catch (err) {
    console.error(`  Price fetch failed for ${ticker}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch current quote (price, 52-week range) for a ticker.
 * More lightweight than full history when we just need today's price.
 *
 * @param {string} ticker
 * @returns {Promise<{price: number, previousClose: number, marketCap: number|null} | null>}
 */
export async function fetchCurrentQuote(ticker) {
  try {
    const quote = await yahooFinance.quote(ticker);
    return {
      price:         quote.regularMarketPrice,
      previousClose: quote.regularMarketPreviousClose,
      marketCap:     quote.marketCap ?? null,
    };
  } catch (err) {
    console.error(`  Quote fetch failed for ${ticker}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch price history for all tickers in the BDC universe.
 * Runs sequentially to be polite to Yahoo's servers.
 *
 * @param {string[]} tickers
 * @param {number} days
 * @returns {Promise<Record<string, Array>>}
 */
export async function fetchAllPrices(tickers, days = 365 * 3) {
  const results = {};
  for (const ticker of tickers) {
    console.log(`  Fetching prices: ${ticker}`);
    results[ticker] = await fetchPriceHistory(ticker, days);
    // Polite delay between requests
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}
