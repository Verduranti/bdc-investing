/**
 * Market Price Fetcher
 *
 * Fetches daily OHLCV price data for BDC tickers using yahoo-finance2.
 * No API key required. Reasonable for personal use at this data volume.
 *
 * Returns price history going back `days` calendar days, which is used for:
 *   - Current price (latest close)
 *   - 30-day discount change
 *   - 3-year z-score calculation
 */

import yahooFinance from 'yahoo-finance2';

/**
 * Fetch historical daily closes for a single ticker.
 *
 * @param {string} ticker
 * @param {number} days - lookback in calendar days (default 365*3 = 3yr)
 * @returns {Promise<Array<{date: string, close: number, volume: number}>>}
 */
export async function fetchPriceHistory(ticker, days = 365 * 3) {
  const period1 = new Date();
  period1.setDate(period1.getDate() - days);

  try {
    const result = await yahooFinance.historical(ticker, {
      period1: period1.toISOString().slice(0, 10),
      interval: '1d',
    });

    return result
      .filter(r => r.close != null)
      .map(r => ({
        date:   r.date.toISOString().slice(0, 10),
        close:  parseFloat(r.close.toFixed(4)),
        volume: r.volume ?? 0,
      }))
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
