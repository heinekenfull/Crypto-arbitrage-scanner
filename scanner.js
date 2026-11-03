
const ccxt = require('ccxt');
const config = require('./config');

// ==========================================
// CRYPTO ARBITRAGE SCANNER
// SPOT + SIMULAÇÃO
// ==========================================

const exchangeCache = {};

const QUOTE_CURRENCIES = [
  'USDT',
  'USDC',
  'USD',
  'BRL'
];

const STABLE_RATES = [
  ['USD', 'USDT', 1],
  ['USDT', 'USD', 1],
  ['USD', 'USDC', 1],
  ['USDC', 'USD', 1],
  ['USDT', 'USDC', 1],
  ['USDC', 'USDT', 1]
];

const SIMULATION = config.SIMULATION || {};

const BUDGETS = SIMULATION.TRADE_BUDGETS_USD || [
  50, 100, 150, 250, 500, 1000
];

const MAX_CANDIDATES =
  SIMULATION.MAX_CANDIDATES_TO_VALIDATE || 100;

const ORDERBOOK_AGE =
  SIMULATION.ORDERBOOK_MAX_AGE_MS || 15000;

const MAX_SLIPPAGE =
  SIMULATION.MAX_SLIPPAGE_PERCENT || 1;

const MIN_FILL =
  SIMULATION.MIN_BUDGET_FILL_RATIO || 0.98;

const MIN_PROFIT =
  config.ARBITRAGE.MIN_PROFIT_PERCENT || 0.30;

const MIN_PROFIT_BRL =
  SIMULATION.MIN_NET_PROFIT_BRL || 0.10;

const MAX_SPREAD =
  config.ARBITRAGE.MAX_SPREAD_PERCENT || 10;

const ORDERBOOK_LIMIT =
  SIMULATION.ORDERBOOK_DEPTH || 20;


// ==========================================
// CONEXÃO COM CORRETORAS
// ==========================================

function createExchange(exchangeId) {
  if (exchangeCache[exchangeId]) {
    return exchangeCache[exchangeId];
  }

  if (!ccxt[exchangeId]) {
    throw new Error(
      'Corretora não suportada pelo CCXT: ' + exchangeId
    );
  }

  const exchange = new ccxt[exchangeId]({
    enableRateLimit: true,
    timeout: config.REQUEST_TIMEOUT || 15000,
    options: {
      defaultType: 'spot'
    }
  });

  exchangeCache[exchangeId] = exchange;

  return exchange;
}


// ==========================================
// EXECUÇÃO COM CONCORRÊNCIA CONTROLADA
// ==========================================

async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (true) {
      const index = currentIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await callback(items[index], index);
      } catch (error) {
        results[index] = {
          error: error.message
        };
      }
    }
  }

  const workers = [];

  const workerCount = Math.min(
    Math.max(1, limit || 1),
    items.length
  );

  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return results;
}


// ==========================================
// IDENTIFICAÇÃO DE MERCADOS SPOT
// ==========================================

function isSpotMarket(market) {
  if (!market || market.active === false) {
    return false;
  }

  if (
    market.spot === false ||
    market.contract ||
    market.swap ||
    market.future ||
    market.option
  ) {
    return false;
  }

  if (!market.base || !market.quote) {
    return false;
  }

  if (!QUOTE_CURRENCIES.includes(market.quote)) {
    return false;
  }

  return true;
}


function getEligibleMarkets(exchange) {
  const markets = Object.values(exchange.markets || {});

  const eligible = markets.filter(isSpotMarket);

  // Conversões são úteis para calcular valores em BRL/USD.
  const conversionMarkets = eligible.filter(market =>
    (
      market.base === 'USDT' ||
      market.base === 'USDC' ||
      market.base === 'USD'
    ) &&
    market.quote === 'BRL'
  );

  const remaining = eligible.filter(market =>
    !conversionMarkets.includes(market)
  );

  const maxMarkets =
    config.MAX_MARKETS_PER_EXCHANGE || 500;

  return [
    ...conversionMarkets,
    ...remaining
  ].slice(0, maxMarkets);
}


// ==========================================
// TAXAS DAS CORRETORAS
// ==========================================

function getMarketFee(exchangeId, market) {
  const overrides =
    config.ARBITRAGE.EXCHANGE_TAKER_FEES_PERCENT || {};

  if (
    overrides[exchangeId] !== undefined &&
    Number.isFinite(Number(overrides[exchangeId]))
  ) {
    return Number(overrides[exchangeId]);
  }

  if (
    market &&
    Number.isFinite(Number(market.taker)) &&
    Number(market.taker) >= 0
  ) {
    return Number(market.taker) * 100;
  }

  return Number(
    config.ARBITRAGE.TRADING_FEE_PERCENT || 0.10
  );
}


// ==========================================
// CONSULTA DE COTAÇÕES
// ==========================================

async function fetchExchangePrices(exchangeId) {
  const exchange = createExchange(exchangeId);

  await exchange.loadMarkets();

  const markets = getEligibleMarkets(exchange);

  const allPrices = [];

  // Consulta em blocos para evitar requisições gigantes.
  const chunkSize = 100;

  for (
    let start = 0;
    start < markets.length;
    start += chunkSize
  ) {
    const chunk = markets.slice(
      start,
      start + chunkSize
    );

    const symbols = chunk.map(market => market.symbol);

    const tickers = await exchange.fetchTickers(symbols);

    for (const symbol of symbols) {
      const ticker = tickers[symbol];

      if (!ticker) continue;

      const market = exchange.markets[symbol];

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

      const timestamp = Number(ticker.timestamp) || Date.now();

      if (Date.now() - timestamp > 30000) {
        continue;
      }

      allPrices.push({
        exchangeId,
        exchange: config.EXCHANGES[exchangeId]?.name || exchangeId,
        symbol,
        base: market.base,
        quote: market.quote,
        bid,
        ask,
        last: Number(ticker.last) || null,
        feePercent: getMarketFee(exchangeId, market),
        quoteVolume: Number(ticker.quoteVolume) || 0,
        timestamp
      });
    }
  }

  return {
    exchangeId,
    exchange: config.EXCHANGES[exchangeId]?.name || exchangeId,
    status: 'connected',
    connected: true,
    markets: allPrices.length,
    prices: allPrices
  };
}


// ==========================================
// GRAFO DE CONVERSÃO DE MOEDAS
// ==========================================

function buildConversionGraph(prices) {
  const graph = {};

  function addRate(from, to, rate) {
    if (!from || !to || !Number.isFinite(rate) || rate <= 0) {
      return;
    }

    if (!graph[from]) graph[from] = [];

    graph[from].push({
      currency: to,
      rate
    });
  }

  for (const [from, to, rate] of STABLE_RATES) {
    addRate(from, to, rate);
  }

  for (const item of prices) {
    if (!item.bid || !item.ask) continue;

    const mid = (item.bid + item.ask) / 2;

    addRate(item.base, item.quote, mid);
    addRate(item.quote, item.base, 1 / mid);
  }

  return graph;
}


function findConversionRate(graph, from, to) {
  if (from === to) return 1;

  if (!graph[from]) return null;

  const queue = [{
    currency: from,
    rate: 1,
    depth: 0
  }];

  const visited = new Set([from]);

  while (queue.length) {
    const current = queue.shift();

    if (current.depth >= 4) continue;

    for (const edge of graph[current.currency] || []) {
      if (visited.has(edge.currency)) continue;

      const rate = current.rate * edge.rate;

      if (edge.currency === to) {
        return rate;
      }

      visited.add(edge.currency);

      queue.push({
        currency: edge.currency,
        rate,
        depth: current.depth + 1
      });
    }
  }

  return null;
}


// ==========================================
// IDENTIFICAÇÃO DE OPORTUNIDADES
// ==========================================

function calculateOpportunities(exchangeResults) {
  const prices = exchangeResults.flatMap(result =>
    result && result.prices ? result.prices : []
  );

  const grouped = {};

  for (const item of prices) {
    if (!grouped[item.symbol]) {
      grouped[item.symbol] = [];
    }

    grouped[item.symbol].push(item);
  }

  const opportunities = [];

  for (const symbol of Object.keys(grouped)) {
    const markets = grouped[symbol];

    if (markets.length < 2) continue;

    for (let i = 0; i < markets.length; i++) {
      for (let j = 0; j < markets.length; j++) {
        if (i === j) continue;

        const buy = markets[i];
        const sell = markets[j];

        if (buy.exchangeId === sell.exchangeId) continue;

        const grossSpread =
          ((sell.bid - buy.ask) / buy.ask) * 100;

        if (
          grossSpread <= 0 ||
          grossSpread > MAX_SPREAD
        ) {
          continue;
        }

        const fees =
          buy.feePercent + sell.feePercent;

        const estimatedNet =
          grossSpread - fees;

        if (estimatedNet <= 0) continue;

        opportunities.push({
          symbol,
          base: buy.base,
          quote: buy.quote,

          buyExchange: buy.exchange,
          sellExchange: sell.exchange,

          buyExchangeId: buy.exchangeId,
          sellExchangeId: sell.exchangeId,

          buyPrice: buy.ask,
          sellPrice: sell.bid,

          grossSpreadPercent: grossSpread,
          estimatedFeePercent: fees,
          estimatedNetPercent: estimatedNet,

          buyTimestamp: buy.timestamp,
          sellTimestamp: sell.timestamp,

          simulations: []
        });
      }
    }
  }

  return opportunities.sort((a, b) =>
    b.estimatedNetPercent - a.estimatedNetPercent
  );
}


// ==========================================
// LIVRO DE OFERTAS
// ==========================================

async function fetchOrderBookSnapshot(exchangeId, symbol) {
  const exchange = createExchange(exchangeId);

  const startedAt = Date.now();

  const book = await exchange.fetchOrderBook(
    symbol,
    ORDERBOOK_LIMIT || undefined
  );

  const fetchedAt = Date.now();

  const asks = (book.asks || [])
    .filter(level =>
      Number(level[0]) > 0 &&
      Number(level[1]) > 0
    )
    .sort((a, b) => a[0] - b[0]);

  const bids = (book.bids || [])
    .filter(level =>
      Number(level[0]) > 0 &&
      Number(level[1]) > 0
    )
    .sort((a, b) => b[0] - a[0]);

  if (!asks.length || !bids.length) {
    throw new Error('Livro de ofertas vazio');
  }

  if (asks[0][0] < bids[0][0]) {
    throw new Error('Livro de ofertas inconsistente');
  }

  const timestamp = Number(book.timestamp) || fetchedAt;

  if (
    fetchedAt - timestamp > ORDERBOOK_AGE ||
    fetchedAt - startedAt > ORDERBOOK_AGE
  ) {
    throw new Error('Livro de ofertas desatualizado');
  }

  return {
    asks,
    bids,
    timestamp,
    fetchedAt
  };
}


// ==========================================
// CÁLCULO DE LIQUIDEZ
// ==========================================

function getTotalQuantity(levels) {
  return levels.reduce((total, level) => {
    return total + Number(level[1]);
  }, 0);
}


function calculateBuyCost(asks, quantity) {
  let remaining = quantity;
  let cost = 0;
  let filled = 0;

  for (const [price, amount] of asks) {
    if (remaining <= 0) break;

    const available = Number(amount);
    const take = Math.min(remaining, available);

    cost += take * Number(price);
    filled += take;
    remaining -= take;
  }

  return {
    cost,
    filled,
    averagePrice: filled > 0 ? cost / filled : 0
  };
}


function calculateSellRevenue(bids, quantity) {
  let remaining = quantity;
  let revenue = 0;
  let filled = 0;

  for (const [price, amount] of bids) {
    if (remaining <= 0) break;

    const available = Number(amount);
    const take = Math.min(remaining, available);

    revenue += take * Number(price);
    filled += take;
    remaining -= take;
  }

  return {
    revenue,
    filled,
    averagePrice: filled > 0 ? revenue / filled : 0
  };
}


// ==========================================
// SIMULAÇÃO DE UMA OPERAÇÃO
// ==========================================

function simulateBudget(
  opportunity,
  buyBook,
  sellBook,
  budgetUSD,
  conversionGraph
) {
  const quoteToBRL = findConversionRate(
    conversionGraph,
    opportunity.quote,
    'BRL'
  );

  const usdToQuote = findConversionRate(
    conversionGraph,
    'USD',
    opportunity.quote
  );

  if (!quoteToBRL || !usdToQuote) {
    return {
      budgetUSD,
      status: 'rejected',
      reason: 'Conversão para USD ou BRL indisponível',
      netProfitBRL: 0,
      netProfitPercent: 0,
      fillRatio: 0
    };
  }

  const budgetQuote = budgetUSD * usdToQuote;

  const buyFeeRate =
    opportunity.buyFeePercent / 100;

  const sellFeeRate =
    opportunity.sellFeePercent / 100;

  const bestAsk = buyBook.asks[0][0];
  const bestBid = sellBook.bids[0][0];

  const affordableQuantity =
    budgetQuote / (bestAsk * (1 + buyFeeRate));

  const sellCapacity = getTotalQuantity(sellBook.bids);

  const quantity = Math.min(
    affordableQuantity,
    sellCapacity
  );

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {
      budgetUSD,
      status: 'rejected',
      reason: 'Liquidez insuficiente',
      netProfitBRL: 0,
      netProfitPercent: 0,
      fillRatio: 0
    };
  }

  const buy = calculateBuyCost(
    buyBook.asks,
    quantity
  );

  const sell = calculateSellRevenue(
    sellBook.bids,
    quantity
  );

  const actualQuantity = Math.min(
    buy.filled,
    sell.filled
  );

  if (actualQuantity <= 0) {
    return {
      budgetUSD,
      status: 'rejected',
      reason: 'Nenhum volume executável',
      netProfitBRL: 0,
      netProfitPercent: 0,
      fillRatio: 0
    };
  }

  const finalBuy = calculateBuyCost(
    buyBook.asks,
    actualQuantity
  );

  const finalSell = calculateSellRevenue(
    sellBook.bids,
    actualQuantity
  );

  const buyFee = finalBuy.cost * buyFeeRate;
  const sellFee = finalSell.revenue * sellFeeRate;

  const totalCost = finalBuy.cost + buyFee;

  const netRevenue = finalSell.revenue - sellFee;

  const netProfitQuote = netRevenue - totalCost;

  const netProfitPercent =
    totalCost > 0
      ? (netProfitQuote / totalCost) * 100
      : 0;

  const netProfitBRL =
    netProfitQuote * quoteToBRL;

  const fillRatio = totalCost / budgetQuote;

  const buySlippage =
    ((finalBuy.averagePrice - bestAsk) / bestAsk) * 100;

  const sellSlippage =
    ((bestBid - finalSell.averagePrice) / bestBid) * 100;

  const totalSlippage =
    Math.max(0, buySlippage) +
    Math.max(0, sellSlippage);

  const reasons = [];

  if (fillRatio < MIN_FILL) {
    reasons.push('Preenchimento abaixo do mínimo');
  }

  if (totalSlippage > MAX_SLIPPAGE) {
    reasons.push('Slippage acima do limite');
  }

  if (netProfitPercent < MIN_PROFIT) {
    reasons.push('Lucro líquido abaixo do mínimo');
  }

  if (netProfitBRL < MIN_PROFIT_BRL) {
    reasons.push('Lucro líquido em BRL insuficiente');
  }

  const validated = reasons.length === 0;

  return {
    budgetUSD,

    tradeBudgetUSD: budgetUSD,

    budgetQuote,

    quoteCurrency: opportunity.quote,

    quantity: actualQuantity,

    buyAveragePrice: finalBuy.averagePrice,
    sellAveragePrice: finalSell.averagePrice,

    buyCost: finalBuy.cost,
    sellRevenue: finalSell.revenue,

    buyFee,
    sellFee,

    totalFees: buyFee + sellFee,

    netProfitQuote,
    netProfitBRL,
    netProfitPercent,

    fillRatio,
    budgetFillRatio: fillRatio,

    buySlippagePercent: buySlippage,
    sellSlippagePercent: sellSlippage,
    totalSlippagePercent: totalSlippage,

    status: validated ? 'validated' : 'rejected',

    reason: reasons.join('; '),

    validated
  };
}


// ==========================================
// VALIDAÇÃO COMPLETA DA OPORTUNIDADE
// ==========================================

async function evaluateCandidate(
  opportunity,
  conversionGraph
) {
  const [
    buyBook,
    sellBook
  ] = await Promise.all([
    fetchOrderBookSnapshot(
      opportunity.buyExchangeId,
      opportunity.symbol
    ),

    fetchOrderBookSnapshot(
      opportunity.sellExchangeId,
      opportunity.symbol
    )
  ]);

  const buyExchange = createExchange(
    opportunity.buyExchangeId
  );

  const sellExchange = createExchange(
    opportunity.sellExchangeId
  );

  const buyMarket =
    buyExchange.markets[opportunity.symbol];

  const sellMarket =
    sellExchange.markets[opportunity.symbol];

  opportunity.buyFeePercent = getMarketFee(
    opportunity.buyExchangeId,
    buyMarket
  );

  opportunity.sellFeePercent = getMarketFee(
    opportunity.sellExchangeId,
    sellMarket
  );

  opportunity.simulations = BUDGETS.map(budget =>
    simulateBudget(
      opportunity,
      buyBook,
      sellBook,
      Number(budget),
      conversionGraph
    )
  );

  const validated = opportunity.simulations.filter(
    simulation => simulation.validated
  );

  opportunity.validatedBudgets = validated.map(
    simulation => simulation.budgetUSD
  );

  opportunity.validatedCount = validated.length;

  opportunity.bookTimestamp = Math.min(
    buyBook.timestamp,
    sellBook.timestamp
  );

  opportunity.status =
    validated.length > 0 ? 'validated' : 'rejected';

  // Simulação padrão para compatibilidade com o painel.
  const defaultBudget =
    SIMULATION.DEFAULT_TRADE_BUDGET_USD || 100;

  const defaultSimulation =
    opportunity.simulations.find(item =>
      item.budgetUSD === defaultBudget
    ) || opportunity.simulations[0];

  if (defaultSimulation) {
    opportunity.netProfitBRL =
      defaultSimulation.netProfitBRL;

    opportunity.netProfitPercent =
      defaultSimulation.netProfitPercent;

    opportunity.fillRatio =
      defaultSimulation.fillRatio;
  }

  return opportunity;
}


// ==========================================
// CICLO PRINCIPAL DO SCANNER
// ==========================================

async function scanMarket() {
  const enabledExchanges = Object.entries(
    config.EXCHANGES
  )
    .filter(([id, settings]) =>
      settings.enabled && ccxt[id]
    )
    .map(([id]) => id);

  const exchangeResults = await mapWithConcurrency(
    enabledExchanges,
    config.EXCHANGE_SCAN_CONCURRENCY || 2,
    async exchangeId => {
      try {
        return await fetchExchangePrices(exchangeId);
      } catch (error) {
        return {
          exchangeId,
          exchange:
            config.EXCHANGES[exchangeId]?.name || exchangeId,
          status: 'error',
          connected: false,
          markets: 0,
          prices: [],
          error: error.message
        };
      }
    }
  );

  const connected = exchangeResults.filter(result =>
    result && result.connected
  );

  const totalMarkets = connected.reduce(
    (total, result) => total + result.markets,
    0
  );

  const prices = connected.flatMap(result =>
    result.prices || []
  );

  const conversionGraph =
    buildConversionGraph(prices);

  const candidates =
    calculateOpportunities(connected);

  const selectedCandidates =
    candidates.slice(0, MAX_CANDIDATES);

  const validationResults = await mapWithConcurrency(
    selectedCandidates,
    SIMULATION.VALIDATION_CONCURRENCY || 2,
    async candidate => {
      try {
        return await evaluateCandidate(
          candidate,
          conversionGraph
        );
      } catch (error) {
        return {
          ...candidate,
          status: 'rejected',
          error: error.message,
          simulations: []
        };
      }
    }
  );

  const validatedOpportunities =
    validationResults.filter(item =>
      item &&
      item.status === 'validated' &&
      item.validatedCount > 0
    );

  validatedOpportunities.sort((a, b) => {
    const aBest = Math.max(
      ...a.simulations
        .filter(item => item.validated)
        .map(item => item.netProfitBRL)
    );

    const bBest = Math.max(
      ...b.simulations
        .filter(item => item.validated)
        .map(item => item.netProfitBRL)
    );

    return bBest - aBest;
  });

  return {
    timestamp: Date.now(),

    mode: 'SPOT',

    exchangesConnected: connected.length,

    exchanges: exchangeResults.map(result => ({
      name: result.exchange,
      id: result.exchangeId,
      status: result.status,
      connected: result.connected,
      markets: result.markets,
      error: result.error || null
    })),

    marketsAnalyzed: totalMarkets,

    totalCandidates: candidates.length,

    candidatesValidated: validationResults.length,

    validatedCount: validatedOpportunities.length,

    opportunities: validatedOpportunities,

    diagnostics: {
      enabledExchanges: enabledExchanges.length,
      connectedExchanges: connected.length,
      marketsAnalyzed: totalMarkets,
      candidatesFound: candidates.length,
      candidatesChecked: validationResults.length,
      opportunitiesApproved: validatedOpportunities.length,
      budgets: BUDGETS
    }
  };
}


// ==========================================
// EXPORTAÇÕES
// ==========================================

module.exports = {
  scanMarket,
  fetchExchangePrices,
  fetchOrderBookSnapshot,
  calculateOpportunities,
  evaluateCandidate,
  simulateBudget,
  buildConversionGraph,
  findConversionRate,
  mapWithConcurrency,
  createExchange
};
