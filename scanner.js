const ccxt = require('ccxt');
const config = require('./config');

const exchangeCache = {};

const QUOTE_PRIORITY = [
  'USDT',
  'USDC',
  'FDUSD',
  'BTC',
  'ETH',
  'BRL'
];

const MAX_MARKETS = 500;
const MAX_PRICE_AGE = 30000;
const MAX_SPREAD = config.ARBITRAGE.MAX_SPREAD_PERCENT;

function createExchange(id) {
  if (exchangeCache[id]) {
    return exchangeCache[id];
  }

  if (!ccxt[id]) {
    throw new Error(`Corretora não suportada: ${id}`);
  }

  const exchange = new ccxt[id]({
    enableRateLimit: true,
    timeout: config.REQUEST_TIMEOUT,
    options: {
      defaultType: 'spot'
    }
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

function getMarketFee(market) {
  const configuredFee =
    Number(config.ARBITRAGE.TRADING_FEE_PERCENT);

  const fallback = Number.isFinite(configuredFee)
    ? configuredFee
    : 0.10;

  // CCXT informa taker como fração:
  // 0.001 equivale a 0,10%.

  if (
    market &&
    Number.isFinite(Number(market.taker)) &&
    Number(market.taker) >= 0
  ) {
    return Number(market.taker) * 100;
  }

  return fallback;
}

function getEligibleMarkets(exchange) {
  const markets = Object.values(exchange.markets || {});

  return markets
    .filter(market => {
      return (
        market &&
        market.symbol &&
        market.spot === true &&
        market.active !== false &&
        QUOTE_PRIORITY.includes(market.quote)
      );
    })
    .sort((a, b) => {
      const priorityA = QUOTE_PRIORITY.indexOf(a.quote);
      const priorityB = QUOTE_PRIORITY.indexOf(b.quote);

      return priorityA - priorityB;
    })
    .slice(
      0,
      Number(config.MAX_MARKETS_PER_EXCHANGE) || MAX_MARKETS
    );
}

async function fetchExchangePrices(exchangeId) {
  const exchange = createExchange(exchangeId);

  await exchange.loadMarkets();

  const markets = getEligibleMarkets(exchange);

  if (!markets.length) {
    throw new Error('Nenhum mercado Spot compatível');
  }

  if (!exchange.has.fetchTickers) {
    throw new Error('Corretora não oferece fetchTickers');
  }

  const symbols = markets.map(market => market.symbol);

  const tickers = await exchange.fetchTickers(symbols);

  const receivedAt = Date.now();
  const prices = {};

  for (const market of markets) {
    const ticker = tickers[market.symbol];

    if (!ticker) continue;

    const bid = Number(ticker.bid);
    const ask = Number(ticker.ask);

    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask <= 0 ||
      ask < bid
    ) {
      continue;
    }

    const sourceTimestamp =
      Number(ticker.timestamp) || null;

    const timestamp = sourceTimestamp || receivedAt;

    if (receivedAt - timestamp > MAX_PRICE_AGE) {
      continue;
    }

    prices[market.symbol] = {
      bid,
      ask,
      last: Number(ticker.last) || null,
      timestamp,
      timestampEstimated: !sourceTimestamp,
      takerFeePercent: getMarketFee(market),
      base: market.base,
      quote: market.quote,
      volume: Number(ticker.quoteVolume) || null
    };
  }

  return {
    exchange: exchangeId,
    prices,
    marketsDiscovered: markets.length,
    marketsReceived: Object.keys(prices).length,
    timestamp: receivedAt
  };
}

function calculateAllCandidates(exchangeData) {
  const candidates = [];
  const symbols = new Set();

  for (const exchange of exchangeData) {
    if (!exchange || exchange.error) continue;

    Object.keys(exchange.prices || {}).forEach(symbol => {
      symbols.add(symbol);
    });
  }

  let comparisons = 0;

  for (const symbol of symbols) {
    const markets = [];

    for (const exchange of exchangeData) {
      if (!exchange || exchange.error) continue;

      const price = exchange.prices[symbol];

      if (!price) continue;

      markets.push({
        exchange: exchange.exchange,
        bid: price.bid,
        ask: price.ask,
        timestamp: price.timestamp,
        timestampEstimated: price.timestampEstimated,
        fee: price.takerFeePercent,
        volume: price.volume
      });
    }

    if (markets.length < 2) continue;

    for (const buy of markets) {
      for (const sell of markets) {
        if (buy.exchange === sell.exchange) continue;

        comparisons++;

        const grossProfit =
          ((sell.bid - buy.ask) / buy.ask) * 100;

        if (
          !Number.isFinite(grossProfit) ||
          grossProfit > MAX_SPREAD
        ) {
          continue;
        }

        const estimatedFees =
          buy.fee + sell.fee;

        const netProfit =
          grossProfit - estimatedFees;

        const oldestPrice = Math.min(
          buy.timestamp,
          sell.timestamp
        );

        candidates.push({
          symbol,

          buyExchange: buy.exchange,
          sellExchange: sell.exchange,

          buyPrice: buy.ask,
          sellPrice: sell.bid,

          grossProfitPercent: Number(
            grossProfit.toFixed(4)
          ),

          buyFeePercent: Number(
            buy.fee.toFixed(4)
          ),

          sellFeePercent: Number(
            sell.fee.toFixed(4)
          ),

          estimatedFeesPercent: Number(
            estimatedFees.toFixed(4)
          ),

          netProfitPercent: Number(
            netProfit.toFixed(4)
          ),

          buyTimestamp: buy.timestamp,
          sellTimestamp: sell.timestamp,

          timestampEstimated:
            buy.timestampEstimated ||
            sell.timestampEstimated,

          timestamp: Date.now(),
          mode: 'SIMULATION'
        });
      }
    }
  }

  candidates.sort(
    (a, b) =>
      b.netProfitPercent - a.netProfitPercent
  );

  return {
    candidates,
    symbolsCompared: symbols.size,
    comparisons
  };
}

function calculateOpportunities(exchangeData) {
  const result = calculateAllCandidates(exchangeData);

  return result.candidates.filter(opportunity => {
    return (
      opportunity.netProfitPercent >=
      config.ARBITRAGE.MIN_PROFIT_PERCENT
    );
  });
}

async function scanMarket() {
  const exchangeIds = Object.entries(config.EXCHANGES)
    .filter(([id, settings]) => {
      return settings.enabled && ccxt[id];
    })
    .map(([id]) => id);

  const results = await mapWithConcurrency(
    exchangeIds,
    2,
    fetchExchangePrices
  );

  const exchangeData = results.filter(
    result => result && !result.error
  );

  const failedExchanges = results
    .map((result, index) => {
      if (!result || !result.error) return null;

      return {
        name: exchangeIds[index],
        error: result.error
      };
    })
    .filter(Boolean);

  const analysis = calculateAllCandidates(exchangeData);

  const minProfit =
    Number(config.ARBITRAGE.MIN_PROFIT_PERCENT);

  const opportunities = analysis.candidates.filter(
    item => item.netProfitPercent >= minProfit
  );

  const marketSignals = analysis.candidates
    .filter(item => item.netProfitPercent > 0)
    .slice(0, 100);

  return {
    timestamp: Date.now(),

    exchangesConnected: exchangeData.length,

    exchangesConfigured: exchangeIds.length,

    failedExchanges,

    exchanges: exchangeData.map(exchange => ({
      name: exchange.exchange,
      marketsDiscovered: exchange.marketsDiscovered,
      markets: exchange.marketsReceived
    })),

    totalMarkets:
      exchangeData.reduce(
        (total, exchange) =>
          total + exchange.marketsReceived,
        0
      ),

    symbolsCompared: analysis.symbolsCompared,

    totalComparisons: analysis.comparisons,

    opportunities,

    totalOpportunities: opportunities.length,

    marketSignals,

    totalMarketSignals: marketSignals.length,

    minProfitPercent: minProfit,

    mode: 'SIMULATION'
  };
}

module.exports = {
  scanMarket,
  calculateOpportunities,
  calculateAllCandidates,
  fetchExchangePrices,
  mapWithConcurrency,
  createExchange
};
