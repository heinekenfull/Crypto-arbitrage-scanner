
const ccxt = require('ccxt');
const config = require('./config');

const exchangeCache = {};

const SYMBOLS = [
  'BTC/USDT',
  'ETH/USDT',
  'SOL/USDT',
  'XRP/USDT',
  'BNB/USDT',
  'ADA/USDT',
  'DOGE/USDT',
  'TRX/USDT',
  'LINK/USDT',
  'LTC/USDT',
  'AVAX/USDT',
  'DOT/USDT',
  'ATOM/USDT',
  'NEAR/USDT',
  'UNI/USDT',
  'APT/USDT',
  'ARB/USDT',
  'OP/USDT',
  'FIL/USDT',
  'SUI/USDT'
];

function createExchange(id) {
  if (exchangeCache[id]) {
    return exchangeCache[id];
  }

  if (!ccxt[id]) {
    throw new Error(`Corretora não suportada: ${id}`);
  }

  const exchange = new ccxt[id]({
    enableRateLimit: true,
    timeout: config.REQUEST_TIMEOUT
  });

  exchangeCache[id] = exchange;

  return exchange;
}

async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index++;

      if (current >= items.length) return;

      try {
        results[current] = await callback(items[current]);
      } catch (error) {
        results[current] = {
          error: error.message
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

async function fetchExchangePrices(exchangeId) {
  const exchange = createExchange(exchangeId);

  await exchange.loadMarkets();

  const symbols = SYMBOLS.filter(
    symbol => exchange.markets[symbol]
  );

  if (symbols.length === 0) {
    return {
      exchange: exchangeId,
      prices: {},
      error: 'Nenhum mercado compatível encontrado'
    };
  }

  const tickers = await exchange.fetchTickers(symbols);

  const prices = {};

  for (const symbol of symbols) {
    const ticker = tickers[symbol];

    if (!ticker) continue;

    const bid = Number(ticker.bid);
    const ask = Number(ticker.ask);

    if (
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      bid > 0 &&
      ask > 0 &&
      ask >= bid
    ) {
      prices[symbol] = {
        bid,
        ask,
        last: Number(ticker.last) || null,
        timestamp: ticker.timestamp || Date.now()
      };
    }
  }

  return {
    exchange: exchangeId,
    prices,
    timestamp: Date.now()
  };
}

function calculateOpportunities(exchangeData) {
  const opportunities = [];

  const symbols = new Set();

  for (const exchange of exchangeData) {
    if (exchange.error) continue;

    Object.keys(exchange.prices).forEach(
      symbol => symbols.add(symbol)
    );
  }

  for (const symbol of symbols) {
    const markets = [];

    for (const exchange of exchangeData) {
      if (exchange.error) continue;

      const price = exchange.prices[symbol];

      if (!price) continue;

      markets.push({
        exchange: exchange.exchange,
        bid: price.bid,
        ask: price.ask,
        timestamp: price.timestamp
      });
    }

    for (const buy of markets) {
      for (const sell of markets) {
        if (buy.exchange === sell.exchange) continue;

        const grossProfit =
          ((sell.bid - buy.ask) / buy.ask) * 100;

        const fee = config.ARBITRAGE.TRADING_FEE_PERCENT;

        const netProfit = grossProfit - (fee * 2);

        if (netProfit >= config.ARBITRAGE.MIN_PROFIT_PERCENT) {
          opportunities.push({
            symbol,
            buyExchange: buy.exchange,
            sellExchange: sell.exchange,
            buyPrice: buy.ask,
            sellPrice: sell.bid,
            grossProfitPercent: Number(
              grossProfit.toFixed(4)
            ),
            estimatedFeesPercent: Number(
              (fee * 2).toFixed(4)
            ),
            netProfitPercent: Number(
              netProfit.toFixed(4)
            ),
            timestamp: Date.now(),
            mode: 'SIMULATION'
          });
        }
      }
    }
  }

  return opportunities.sort(
    (a, b) => b.netProfitPercent - a.netProfitPercent
  );
}

async function scanMarket() {
  const exchangeIds = Object.entries(config.EXCHANGES)
    .filter(([id, settings]) => {
      return settings.enabled && ccxt[id];
    })
    .map(([id]) => id);

  const results = await mapWithConcurrency(
    exchangeIds,
    3,
    fetchExchangePrices
  );

  const exchangeData = results.filter(
    result => result && !result.error
  );

  const opportunities = calculateOpportunities(
    exchangeData
  );

  return {
    timestamp: Date.now(),
    exchangesConnected: exchangeData.length,
    exchanges: exchangeData.map(exchange => ({
      name: exchange.exchange,
      markets: Object.keys(exchange.prices).length
    })),
    opportunities,
    totalOpportunities: opportunities.length
  };
}

module.exports = {
  scanMarket,
  calculateOpportunities,
  fetchExchangePrices,
  mapWithConcurrency,
  SYMBOLS
};
