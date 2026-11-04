
const config = require('./config');

const {
  createExchange,
  closeExchange,
  getEnabledExchanges
} = require('./exchanges');

const {
  validateOrderBook,
  simulateBudget
} = require('./simulation');

// ==========================================
// CRYPTO ARBITRAGE SCANNER 6.2.2
// SPOT + SIMULAÇÃO USD / BRL
// CONEXÕES REUTILIZADAS POR CICLO
// ==========================================

const SIMULATION = config.SIMULATION || {};
const ARBITRAGE = config.ARBITRAGE || {};

const QUOTE_CURRENCIES = ['USDT', 'USDC', 'USD', 'BRL'];
const STABLE_CURRENCIES = ['USD', 'USDT', 'USDC'];

const ALLOWED_BUDGET_VALUES = [50, 100, 150, 250, 500];

function finiteNumber(value, fallback, min = 0) {
  const number = Number(value);

  return Number.isFinite(number) && number >= min
    ? number
    : fallback;
}


// ==========================================
// ORÇAMENTOS USD E BRL
// ==========================================

function normalizeBudgets(configured, fallback) {
  const source = Array.isArray(configured)
    ? configured
    : fallback;

  const budgets = source
    .map(Number)
    .filter(value =>
      Number.isFinite(value) &&
      ALLOWED_BUDGET_VALUES.includes(value)
    );

  return budgets.length > 0
    ? [...new Set(budgets)].sort((a, b) => a - b)
    : [...ALLOWED_BUDGET_VALUES];
}

const BUDGETS_USD = normalizeBudgets(
  SIMULATION.TRADE_BUDGETS_USD,
  ALLOWED_BUDGET_VALUES
);

const BUDGETS_BRL = normalizeBudgets(
  SIMULATION.TRADE_BUDGETS_BRL,
  ALLOWED_BUDGET_VALUES
);


// ==========================================
// CONFIGURAÇÕES
// ==========================================

const MAX_CANDIDATES = Math.max(
  1,
  Math.floor(finiteNumber(
    SIMULATION.MAX_CANDIDATES_TO_VALIDATE,
    100,
    1
  ))
);

const ORDERBOOK_AGE = Math.max(
  1000,
  finiteNumber(
    SIMULATION.ORDERBOOK_MAX_AGE_MS,
    15000,
    1000
  )
);

const MAX_BOOK_SKEW = Math.max(
  500,
  finiteNumber(
    SIMULATION.MAX_BOOK_SKEW_MS,
    5000,
    500
  )
);

const MIN_PROFIT = finiteNumber(
  ARBITRAGE.MIN_PROFIT_PERCENT,
  0.30
);

const MAX_SPREAD = finiteNumber(
  ARBITRAGE.MAX_SPREAD_PERCENT,
  10,
  0.01
);

const ORDERBOOK_LIMIT =
  SIMULATION.ORDERBOOK_DEPTH || undefined;

const FETCH_CONCURRENCY = 5;

const VALIDATION_CONCURRENCY = Math.min(
  6,
  Math.max(
    1,
    Math.floor(finiteNumber(
      SIMULATION.VALIDATION_CONCURRENCY,
      4,
      1
    ))
  )
);


// ==========================================
// CONCORRÊNCIA CONTROLADA
// ==========================================

async function mapWithConcurrency(items, limit, callback) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (true) {
      const index = currentIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await callback(items[index], index);
      } catch (error) {
        results[index] = {
          error: error.message || String(error)
        };
      }
    }
  }

  const workerCount = Math.min(
    Math.max(1, Number(limit) || 1),
    items.length
  );

  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );

  return results;
}


// ==========================================
// FECHAMENTO SEGURO
// ==========================================

async function safeCloseExchange(exchange) {
  if (!exchange) return;

  try {
    await closeExchange(exchange);
  } catch (error) {
    console.warn(
      '[SCANNER] Erro ao fechar corretora:',
      error.message || String(error)
    );
  }
}


// ==========================================
// MERCADOS SPOT
// ==========================================

function isSpotMarket(market) {
  if (!market || market.active === false) return false;

  if (
    market.spot === false ||
    market.contract === true ||
    market.swap === true ||
    market.future === true ||
    market.option === true
  ) {
    return false;
  }

  if (!market.base || !market.quote) return false;

  const quote = String(market.quote).toUpperCase();

  return QUOTE_CURRENCIES.includes(quote);
}


// ==========================================
// SELEÇÃO DE MERCADOS
// ==========================================

function getEligibleMarkets(exchange) {
  const markets = Object.values(exchange.markets || {})
    .filter(isSpotMarket);

  const conversionMarkets = markets.filter(market => {
    const base = String(market.base).toUpperCase();
    const quote = String(market.quote).toUpperCase();

    return (
      STABLE_CURRENCIES.includes(base) &&
      quote === 'BRL'
    );
  });

  const conversionSymbols = new Set(
    conversionMarkets.map(market => market.symbol)
  );

  const remaining = markets.filter(
    market => !conversionSymbols.has(market.symbol)
  );

  const maxMarkets = Math.max(
    1,
    Math.floor(finiteNumber(
      config.MAX_MARKETS_PER_EXCHANGE,
      500,
      1
    ))
  );

  return [
    ...conversionMarkets,
    ...remaining
  ].slice(0, maxMarkets);
}


// ==========================================
// TAXAS
// ==========================================

function getMarketFee(exchangeId, market) {
  const overrides =
    ARBITRAGE.EXCHANGE_TAKER_FEES_PERCENT || {};

  const override = overrides[exchangeId];

  if (
    override !== undefined &&
    override !== null &&
    Number.isFinite(Number(override)) &&
    Number(override) >= 0
  ) {
    return Number(override);
  }

  if (
    market &&
    market.taker !== undefined &&
    market.taker !== null &&
    Number.isFinite(Number(market.taker)) &&
    Number(market.taker) >= 0
  ) {
    return Number(market.taker) * 100;
  }

  return finiteNumber(
    ARBITRAGE.TRADING_FEE_PERCENT,
    0.10
  );
}


// ==========================================
// NORMALIZAÇÃO DE TICKERS
// ==========================================

function normalizeTicker(exchangeId, market, ticker) {
  if (!ticker || !market) return null;

  const bid = Number(ticker.bid);
  const ask = Number(ticker.ask);

  if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask <= 0 ||
    ask < bid
  ) {
    return null;
  }

  const receivedAt = Date.now();

  const sourceTimestamp =
    ticker.timestamp === undefined ||
    ticker.timestamp === null
      ? null
      : Number(ticker.timestamp);

  const timestamp =
    Number.isFinite(sourceTimestamp) && sourceTimestamp > 0
      ? sourceTimestamp
      : receivedAt;

  if (
    timestamp > receivedAt + 60000 ||
    receivedAt - timestamp > 30000
  ) {
    return null;
  }

  return {
    exchangeId,

    exchange:
      config.EXCHANGES?.[exchangeId]?.name || exchangeId,

    symbol: market.symbol,
    base: String(market.base).toUpperCase(),
    quote: String(market.quote).toUpperCase(),

    bid,
    ask,

    last: Number(ticker.last) || null,

    feePercent: getMarketFee(exchangeId, market),

    quoteVolume: Number(ticker.quoteVolume) || 0,

    timestamp,
    receivedAt,

    timestampEstimated:
      sourceTimestamp === null ||
      !Number.isFinite(sourceTimestamp)
  };
}


// ==========================================
// TICKER INDIVIDUAL
// ==========================================

async function fetchSingleTicker(exchange, exchangeId, market) {
  try {
    const ticker = await exchange.fetchTicker(market.symbol);

    return normalizeTicker(exchangeId, market, ticker);
  } catch (error) {
    return {
      error: error.message || String(error),
      symbol: market.symbol,
      exchangeId
    };
  }
}


// ==========================================
// TICKERS EM LOTES
// ==========================================

async function fetchTickerChunk(exchange, exchangeId, markets) {
  const results = [];
  const receivedSymbols = new Set();

  const supportsFetchTickers =
    exchange.has &&
    exchange.has.fetchTickers !== false &&
    typeof exchange.fetchTickers === 'function';

  if (supportsFetchTickers) {
    try {
      const tickers = await exchange.fetchTickers(
        markets.map(market => market.symbol)
      );

      for (const market of markets) {
        const ticker = tickers?.[market.symbol];

        const normalized = normalizeTicker(
          exchangeId,
          market,
          ticker
        );

        if (normalized) {
          results.push(normalized);
          receivedSymbols.add(market.symbol);
        }
      }
    } catch (error) {
      console.warn(
        '[SCANNER] Falha no lote:',
        exchangeId,
        error.message
      );
    }
  }

  const missingMarkets = markets.filter(
    market => !receivedSymbols.has(market.symbol)
  );

  if (missingMarkets.length > 0) {
    const individualResults = await mapWithConcurrency(
      missingMarkets,
      FETCH_CONCURRENCY,
      market =>
        fetchSingleTicker(exchange, exchangeId, market)
    );

    for (const item of individualResults) {
      if (item && !item.error) {
        results.push(item);
      }
    }
  }

  return results;
}


// ==========================================
// CONSULTAR UMA CORRETORA
// ACEITA INSTÂNCIA COMPARTILHADA
// ==========================================

async function fetchExchangePrices(exchangeId, sharedExchange = null) {
  const ownsExchange = !sharedExchange;
  const exchange = sharedExchange || createExchange(exchangeId);

  try {
    await exchange.loadMarkets();

    const markets = getEligibleMarkets(exchange);
    const allPrices = [];

    const chunkSize = 100;

    for (
      let start = 0;
      start < markets.length;
      start += chunkSize
    ) {
      const chunk = markets.slice(start, start + chunkSize);

      const prices = await fetchTickerChunk(
        exchange,
        exchangeId,
        chunk
      );

      allPrices.push(...prices);
    }

    return {
      exchangeId,

      exchange:
        config.EXCHANGES?.[exchangeId]?.name || exchangeId,

      status: 'connected',
      connected: true,

      markets: allPrices.length,
      availableMarkets: markets.length,

      prices: allPrices
    };

  } catch (error) {
    console.error(
      '[SCANNER] Erro na corretora:',
      exchangeId,
      error.message
    );

    throw error;

  } finally {
    if (ownsExchange) {
      await safeCloseExchange(exchange);
    }
  }
}


// ==========================================
// GRAFO DE CONVERSÃO
// ==========================================

function buildConversionGraph(prices) {
  const graph = {};

  function addRate(from, to, rate) {
    if (
      !from ||
      !to ||
      !Number.isFinite(rate) ||
      rate <= 0
    ) {
      return;
    }

    if (!graph[from]) graph[from] = [];

    graph[from].push({
      currency: to,
      rate
    });
  }

  for (const item of prices || []) {
    if (
      !item ||
      !Number.isFinite(item.bid) ||
      !Number.isFinite(item.ask) ||
      item.bid <= 0 ||
      item.ask <= 0
    ) {
      continue;
    }

    // Venda da moeda-base pelo bid.
    addRate(item.base, item.quote, item.bid);

    // Compra da moeda-base pelo ask.
    addRate(item.quote, item.base, 1 / item.ask);
  }

  return graph;
}


// ==========================================
// MELHOR TAXA DE CONVERSÃO
// ==========================================

function findConversionRate(graph, from, to) {
  if (from === to) return 1;
  if (!graph || !graph[from]) return null;

  let bestRate = null;

  function search(currency, rate, depth, visited) {
    if (depth >= 4) return;

    for (const edge of graph[currency] || []) {
      if (visited.has(edge.currency)) continue;

      const nextRate = rate * edge.rate;

      if (
        !Number.isFinite(nextRate) ||
        nextRate <= 0
      ) {
        continue;
      }

      if (edge.currency === to) {
        if (bestRate === null || nextRate > bestRate) {
          bestRate = nextRate;
        }

        continue;
      }

      const nextVisited = new Set(visited);
      nextVisited.add(edge.currency);

      search(
        edge.currency,
        nextRate,
        depth + 1,
        nextVisited
      );
    }
  }

  search(from, 1, 0, new Set([from]));

  return bestRate;
}


// ==========================================
// CONVERSÃO COM PARIDADE DE STABLECOINS
// A PARIDADE É SEMPRE IDENTIFICADA
// ==========================================

function findConversionWithStableBridge(graph, from, to) {
  const direct = findConversionRate(graph, from, to);

  if (
    direct !== null &&
    Number.isFinite(direct) &&
    direct > 0
  ) {
    return {
      rate: direct,
      estimated: false,
      route: 'direct'
    };
  }

  if (
    STABLE_CURRENCIES.includes(from) &&
    STABLE_CURRENCIES.includes(to)
  ) {
    return {
      rate: 1,
      estimated: true,
      route: 'stablecoin-parity'
    };
  }

  // USD pode ser aproximado por USDT/USDC,
  // mas a conversão restante precisa existir no mercado.
  if (from === 'USD') {
    for (const stable of ['USDT', 'USDC']) {
      const stableRate = findConversionRate(
        graph,
        stable,
        to
      );

      if (
        stableRate !== null &&
        Number.isFinite(stableRate) &&
        stableRate > 0
      ) {
        return {
          rate: stableRate,
          estimated: true,
          route: `USD≈${stable}`
        };
      }
    }
  }

  return null;
}


// ==========================================
// CONVERSÃO DO ORÇAMENTO
// USD -> MOEDA DO PAR
// BRL -> MOEDA DO PAR
// ==========================================

function findBudgetConversionRate(graph, budgetCurrency, quote) {
  const currency = String(budgetCurrency).toUpperCase();

  if (currency === quote) {
    return {
      rate: 1,
      estimated: false,
      route: 'same-currency'
    };
  }

  return findConversionWithStableBridge(
    graph,
    currency,
    quote
  );
}


// ==========================================
// CONVERSÃO PARA BRL
// ==========================================

function findQuoteToBRL(graph, quote) {
  if (quote === 'BRL') {
    return {
      rate: 1,
      estimated: false,
      route: 'same-currency'
    };
  }

  return findConversionWithStableBridge(
    graph,
    quote,
    'BRL'
  );
}


// ==========================================
// COTAÇÃO USD -> BRL
// ==========================================

function findUSDToBRL(graph) {
  return findConversionWithStableBridge(
    graph,
    'USD',
    'BRL'
  );
}


// ==========================================
// IDENTIFICAR OPORTUNIDADES
// ==========================================

function calculateOpportunities(exchangeResults) {
  const prices = (exchangeResults || []).flatMap(
    result => result?.prices || []
  );

  const grouped = {};

  for (const item of prices) {
    if (!item || !item.base || !item.quote) continue;

    const key = `${item.base}/${item.quote}`;

    if (!grouped[key]) grouped[key] = [];

    grouped[key].push(item);
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

        if (
          buy.base !== sell.base ||
          buy.quote !== sell.quote
        ) {
          continue;
        }

        const grossSpread =
          ((sell.bid - buy.ask) / buy.ask) * 100;

        if (
          !Number.isFinite(grossSpread) ||
          grossSpread <= 0 ||
          grossSpread > MAX_SPREAD
        ) {
          continue;
        }

        const fees =
          Number(buy.feePercent || 0) +
          Number(sell.feePercent || 0);

        const estimatedNet = grossSpread - fees;

        if (estimatedNet <= 0) continue;

        opportunities.push({
          symbol: buy.symbol,

          base: buy.base,
          quote: buy.quote,

          buyExchange: buy.exchange,
          sellExchange: sell.exchange,

          buyExchangeId: buy.exchangeId,
          sellExchangeId: sell.exchangeId,

          buyPrice: buy.ask,
          sellPrice: sell.bid,

          buyFeePercent: buy.feePercent,
          sellFeePercent: sell.feePercent,

          grossSpreadPercent: grossSpread,
          estimatedFeePercent: fees,
          estimatedNetPercent: estimatedNet,

          buyTimestamp: buy.timestamp,
          sellTimestamp: sell.timestamp,

          buyReceivedAt: buy.receivedAt,
          sellReceivedAt: sell.receivedAt,

          buyTimestampEstimated: buy.timestampEstimated,
          sellTimestampEstimated: sell.timestampEstimated,

          simulations: []
        });
      }
    }
  }

  return opportunities.sort(
    (a, b) => b.estimatedNetPercent - a.estimatedNetPercent
  );
}


// ==========================================
// CONSULTAR LIVRO COM INSTÂNCIA EXISTENTE
// ==========================================

async function fetchOrderBookWithExchange(
  exchangeId,
  symbol,
  sharedExchange = null
) {
  const ownsExchange = !sharedExchange;
  const exchange = sharedExchange || createExchange(exchangeId);

  try {
    if (
      !exchange.markets ||
      Object.keys(exchange.markets).length === 0
    ) {
      await exchange.loadMarkets();
    }

    const market = exchange.markets?.[symbol];

    if (!market) {
      throw new Error(
        `Mercado ${symbol} não encontrado em ${exchangeId}`
      );
    }

    if (!isSpotMarket(market)) {
      throw new Error(
        `Mercado ${symbol} não é SPOT em ${exchangeId}`
      );
    }

    const canFetchOrderBook =
      typeof exchange.fetchOrderBook === 'function' &&
      exchange.has &&
      exchange.has.fetchOrderBook !== false;

    if (!canFetchOrderBook) {
      throw new Error(
        `A corretora ${exchangeId} não disponibiliza livro de ofertas`
      );
    }

    const startedAt = Date.now();

    const book = await exchange.fetchOrderBook(
      symbol,
      ORDERBOOK_LIMIT
    );

    const fetchedAt = Date.now();

    const asks = (book.asks || [])
      .filter(level =>
        Number(level[0]) > 0 &&
        Number(level[1]) > 0
      )
      .map(level => [
        Number(level[0]),
        Number(level[1])
      ])
      .sort((a, b) => a[0] - b[0]);

    const bids = (book.bids || [])
      .filter(level =>
        Number(level[0]) > 0 &&
        Number(level[1]) > 0
      )
      .map(level => [
        Number(level[0]),
        Number(level[1])
      ])
      .sort((a, b) => b[0] - a[0]);

    const normalizedBook = { asks, bids };

    const validation = validateOrderBook(normalizedBook);

    if (!validation.valid) {
      throw new Error(validation.reason);
    }

    const sourceTimestamp =
      book.timestamp === undefined || book.timestamp === null
        ? null
        : Number(book.timestamp);

    const timestamp =
      Number.isFinite(sourceTimestamp) && sourceTimestamp > 0
        ? sourceTimestamp
        : fetchedAt;

    if (
      timestamp > fetchedAt + 60000 ||
      fetchedAt - timestamp > ORDERBOOK_AGE
    ) {
      throw new Error(
        'Livro de ofertas desatualizado na origem'
      );
    }

    const requestDurationMs = fetchedAt - startedAt;

    if (requestDurationMs > ORDERBOOK_AGE) {
      throw new Error(
        'Consulta do livro de ofertas demorou demais'
      );
    }

    return {
      asks,
      bids,

      timestamp,
      fetchedAt,
      requestDurationMs,

      timestampEstimated:
        sourceTimestamp === null ||
        !Number.isFinite(sourceTimestamp),

      feePercent: getMarketFee(exchangeId, market),

      marketLimits: {
        amount: market.limits?.amount || null,
        price: market.limits?.price || null,
        cost: market.limits?.cost || null
      }
    };

  } finally {
    if (ownsExchange) {
      await safeCloseExchange(exchange);
    }
  }
}


// ==========================================
// FUNÇÃO PÚBLICA DE LIVRO DE OFERTAS
// ==========================================

async function fetchOrderBookSnapshot(exchangeId, symbol) {
  return fetchOrderBookWithExchange(
    exchangeId,
    symbol,
    null
  );
}


// ==========================================
// SINCRONIZAÇÃO DOS LIVROS
// ==========================================

function validateBookSynchronization(buyBook, sellBook) {
  const difference = Math.abs(
    buyBook.fetchedAt - sellBook.fetchedAt
  );

  if (difference > MAX_BOOK_SKEW) {
    throw new Error(
      `Livros fora de sincronização: diferença de ${difference} ms`
    );
  }

  return true;
}


// ==========================================
// IDENTIFICAR SIMULAÇÃO APROVADA
// ==========================================

function isSimulationValidated(simulation) {
  return Boolean(
    simulation &&
    (
      simulation.validated === true ||
      simulation.status === 'validated'
    )
  );
}


// ==========================================
// CRIAR UMA SIMULAÇÃO DE ORÇAMENTO
// ==========================================

function createBudgetSimulation({
  opportunity,
  budgetCurrency,
  budgetAmount,
  budgetConversion,
  quoteToBRL,
  usdToBRL,
  buyBook,
  sellBook
}) {
  const budgetQuote =
    budgetAmount * budgetConversion.rate;

  const result = simulateBudget({
    budgetCurrency,
    budgetAmount,

    budgetQuote,

    buyOrderBook: buyBook,
    sellOrderBook: sellBook,

    buyFeePercent: opportunity.buyFeePercent,
    sellFeePercent: opportunity.sellFeePercent,

    quoteToBRL,
    usdToBRL,

    buyMarketLimits: buyBook.marketLimits,
    sellMarketLimits: sellBook.marketLimits
  });

  const validated = isSimulationValidated(result);

  return {
    ...result,

    validated,
    status: validated ? 'validated' : 'rejected',

    budgetCurrency,
    budgetAmount,

    quoteCurrency: opportunity.quote,

    budgetConversionRate: budgetConversion.rate,
    budgetConversionEstimated: budgetConversion.estimated,
    budgetConversionRoute: budgetConversion.route,

    quoteToBRLEstimated: quoteToBRL.estimated,
    usdToBRLEstimated: usdToBRL
      ? usdToBRL.estimated
      : null
  };
}


// ==========================================
// AVALIAR OPORTUNIDADE
// ==========================================

async function evaluateCandidate(
  opportunity,
  conversionGraph,
  exchangeInstances = null
) {
  const buyExchange = exchangeInstances?.get(
    opportunity.buyExchangeId
  );

  const sellExchange = exchangeInstances?.get(
    opportunity.sellExchangeId
  );

  if (!buyExchange || !sellExchange) {
    throw new Error(
      'Instância de corretora indisponível para validação'
    );
  }

  const [buyBook, sellBook] = await Promise.all([
    fetchOrderBookWithExchange(
      opportunity.buyExchangeId,
      opportunity.symbol,
      buyExchange
    ),

    fetchOrderBookWithExchange(
      opportunity.sellExchangeId,
      opportunity.symbol,
      sellExchange
    )
  ]);

  validateBookSynchronization(buyBook, sellBook);

  opportunity.buyFeePercent = buyBook.feePercent;
  opportunity.sellFeePercent = sellBook.feePercent;

  // Conversão da moeda do par para BRL.
  const quoteToBRL = findQuoteToBRL(
    conversionGraph,
    opportunity.quote
  );

  // Conversão de USD para BRL.
  const usdToBRL = findUSDToBRL(conversionGraph);

  if (!quoteToBRL) {
    throw new Error(
      `Conversão de ${opportunity.quote} para BRL indisponível`
    );
  }

  if (!usdToBRL) {
    console.warn(
      '[SCANNER] Conversão USD/BRL indisponível. Equivalências em USD serão omitidas.'
    );
  }

  // ========================================
  // DEZ SIMULAÇÕES
  // CINCO USD + CINCO BRL
  // ========================================

  const simulations = [];

  for (const budgetUSD of BUDGETS_USD) {
    const conversion = findBudgetConversionRate(
      conversionGraph,
      'USD',
      opportunity.quote
    );

    if (!conversion) {
      simulations.push({
        validated: false,
        status: 'rejected',
        reason: `Não foi possível converter USD para ${opportunity.quote}.`,

        budgetCurrency: 'USD',
        budgetAmount: budgetUSD,
        budgetUSD,
        budgetBRL: null,

        netProfit: 0,
        netProfitUSD: null,
        netProfitBRL: 0,

        profitPercent: 0,
        fillRatio: 0,

        checks: {}
      });

      continue;
    }

    simulations.push(
      createBudgetSimulation({
        opportunity,
        budgetCurrency: 'USD',
        budgetAmount: budgetUSD,
        budgetConversion: conversion,
        quoteToBRL: quoteToBRL.rate,
        usdToBRL: usdToBRL?.rate || null,
        buyBook,
        sellBook
      })
    );
  }

  for (const budgetBRL of BUDGETS_BRL) {
    const conversion = findBudgetConversionRate(
      conversionGraph,
      'BRL',
      opportunity.quote
    );

    if (!conversion) {
      simulations.push({
        validated: false,
        status: 'rejected',
        reason: `Não foi possível converter BRL para ${opportunity.quote}.`,

        budgetCurrency: 'BRL',
        budgetAmount: budgetBRL,
        budgetUSD: usdToBRL
          ? budgetBRL / usdToBRL.rate
          : null,
        budgetBRL,

        netProfit: 0,
        netProfitUSD: null,
        netProfitBRL: 0,

        profitPercent: 0,
        fillRatio: 0,

        checks: {}
      });

      continue;
    }

    simulations.push(
      createBudgetSimulation({
        opportunity,
        budgetCurrency: 'BRL',
        budgetAmount: budgetBRL,
        budgetConversion: conversion,
        quoteToBRL: quoteToBRL.rate,
        usdToBRL: usdToBRL?.rate || null,
        buyBook,
        sellBook
      })
    );
  }

  opportunity.simulations = simulations;

  // ========================================
  // CONTAGEM DAS APROVAÇÕES
  // ========================================

  const validated = simulations.filter(
    isSimulationValidated
  );

  const validatedUSD = simulations.filter(
    item =>
      item.budgetCurrency === 'USD' &&
      isSimulationValidated(item)
  );

  const validatedBRL = simulations.filter(
    item =>
      item.budgetCurrency === 'BRL' &&
      isSimulationValidated(item)
  );

  opportunity.validatedBudgets = validatedUSD.map(
    item => item.budgetAmount
  );

  opportunity.validatedBudgetsUSD =
    validatedUSD.map(item => item.budgetAmount);

  opportunity.validatedBudgetsBRL =
    validatedBRL.map(item => item.budgetAmount);

  opportunity.validatedCount = validated.length;

  opportunity.validatedCountUSD = validatedUSD.length;
  opportunity.validatedCountBRL = validatedBRL.length;

  opportunity.bookTimestamp = Math.min(
    buyBook.timestamp,
    sellBook.timestamp
  );

  opportunity.bookTimestampEstimated =
    buyBook.timestampEstimated ||
    sellBook.timestampEstimated;

  opportunity.bookSynchronizationMs = Math.abs(
    buyBook.fetchedAt - sellBook.fetchedAt
  );

  opportunity.conversion = {
    quoteToBRL: quoteToBRL.rate,
    quoteToBRLEstimated: quoteToBRL.estimated,

    usdToBRL: usdToBRL?.rate || null,
    usdToBRLEstimated: usdToBRL?.estimated ?? null
  };

  opportunity.status =
    validated.length > 0 ? 'validated' : 'rejected';

  // ========================================
  // SIMULAÇÃO PADRÃO PARA EXIBIÇÃO
  // ========================================

  const defaultBudget = finiteNumber(
    SIMULATION.DEFAULT_TRADE_BUDGET_USD,
    100,
    1
  );

  const defaultSimulation =
    simulations.find(
      item =>
        item.budgetCurrency === 'USD' &&
        Number(item.budgetAmount) === defaultBudget
    ) ||
    validatedUSD[0] ||
    validatedBRL[0] ||
    simulations[0];

  if (defaultSimulation) {
    opportunity.netProfitBRL =
      defaultSimulation.netProfitBRL;

    opportunity.netProfitUSD =
      defaultSimulation.netProfitUSD;

    opportunity.netProfitPercent =
      defaultSimulation.profitPercent;

    opportunity.fillRatio =
      defaultSimulation.fillRatio;

    opportunity.defaultBudgetCurrency =
      defaultSimulation.budgetCurrency;

    opportunity.defaultBudgetAmount =
      defaultSimulation.budgetAmount;
  }

  return opportunity;
}


// ==========================================
// CICLO PRINCIPAL
// ==========================================

async function scanMarket() {
  const startedAt = Date.now();

  const enabledExchanges = getEnabledExchanges();

  const exchangeInstances = new Map();

  console.log(
    '[SCANNER] Corretoras habilitadas:',
    enabledExchanges.join(', ')
  );

  try {
    // ========================================
    // CONSULTAR CORRETORAS
    // ========================================

    const exchangeResults = await mapWithConcurrency(
      enabledExchanges,
      config.EXCHANGE_SCAN_CONCURRENCY || 2,
      async exchangeId => {
        try {
          const exchange = createExchange(exchangeId);

          exchangeInstances.set(exchangeId, exchange);

          return await fetchExchangePrices(
            exchangeId,
            exchange
          );

        } catch (error) {
          console.error(
            '[SCANNER] Falha ao consultar:',
            exchangeId,
            error.message || String(error)
          );

          return {
            exchangeId,

            exchange:
              config.EXCHANGES?.[exchangeId]?.name || exchangeId,

            status: 'error',
            connected: false,

            markets: 0,
            availableMarkets: 0,

            prices: [],

            error: error.message || String(error)
          };
        }
      }
    );

    const connected = exchangeResults.filter(
      result => result && result.connected
    );

    const totalMarkets = connected.reduce(
      (total, result) =>
        total + Number(result.markets || 0),
      0
    );

    const prices = connected.flatMap(
      result => result.prices || []
    );

    console.log(
      '[SCANNER] Corretoras conectadas:',
      connected.length,
      '/',
      enabledExchanges.length
    );

    console.log(
      '[SCANNER] Cotações recebidas:',
      prices.length
    );

    // ========================================
    // CONVERSÕES
    // ========================================

    const conversionGraph = buildConversionGraph(prices);

    // ========================================
    // CANDIDATOS
    // ========================================

    const candidates = calculateOpportunities(connected);

    console.log(
      '[SCANNER] Oportunidades preliminares:',
      candidates.length
    );

    const selectedCandidates = candidates.slice(
      0,
      MAX_CANDIDATES
    );

    console.log(
      '[SCANNER] Candidatos selecionados:',
      selectedCandidates.length,
      '| Concorrência:',
      VALIDATION_CONCURRENCY
    );

    // ========================================
    // VALIDAR COM LIVROS
    // ========================================

    const validationResults = await mapWithConcurrency(
      selectedCandidates,
      VALIDATION_CONCURRENCY,
      async candidate => {
        try {
          return await evaluateCandidate(
            candidate,
            conversionGraph,
            exchangeInstances
          );

        } catch (error) {
          console.warn(
            '[SCANNER] Candidato rejeitado:',
            candidate.symbol,
            candidate.buyExchangeId,
            '->',
            candidate.sellExchangeId,
            error.message || String(error)
          );

          return {
            ...candidate,

            status: 'rejected',

            error: error.message || String(error),

            simulations: [],
            validatedBudgets: [],
            validatedBudgetsUSD: [],
            validatedBudgetsBRL: [],
            validatedCount: 0
          };
        }
      }
    );

    // ========================================
    // RESULTADOS
    // ========================================

    const validatedOpportunities = validationResults.filter(
      item =>
        item &&
        item.status === 'validated' &&
        item.validatedCount > 0
    );

    const rejectedCandidates = validationResults.filter(
      item => item && item.status === 'rejected'
    );

    validatedOpportunities.sort((a, b) => {
      const aBest = Math.max(
        0,
        ...a.simulations
          .filter(isSimulationValidated)
          .map(item => Number(item.netProfitBRL) || 0)
      );

      const bBest = Math.max(
        0,
        ...b.simulations
          .filter(isSimulationValidated)
          .map(item => Number(item.netProfitBRL) || 0)
      );

      return bBest - aBest;
    });

    // ========================================
    // RESPOSTA
    // ========================================

    const finishedAt = Date.now();

    const result = {
      timestamp: finishedAt,

      durationMs: finishedAt - startedAt,

      version: '6.2.2',

      mode: 'SPOT',

      exchangesConnected: connected.length,

      exchanges: exchangeResults.map(item => ({
        name: item.exchange,
        id: item.exchangeId,

        status: item.status,
        connected: item.connected,

        markets: item.markets || 0,

        error: item.error || null
      })),

      marketsAnalyzed: totalMarkets,

      totalCandidates: candidates.length,

      candidatesValidated: validationResults.length,

      rejectedCount: rejectedCandidates.length,

      validatedCount: validatedOpportunities.length,

      opportunities: validatedOpportunities,

      rejectedCandidates: rejectedCandidates.map(item => ({
        symbol: item.symbol,

        buyExchange: item.buyExchange,
        sellExchange: item.sellExchange,

        buyExchangeId: item.buyExchangeId,
        sellExchangeId: item.sellExchangeId,

        grossSpreadPercent: item.grossSpreadPercent,
        estimatedNetPercent: item.estimatedNetPercent,

        error: item.error || null,

        simulations: item.simulations || []
      })),

      diagnostics: {
        enabledExchanges: enabledExchanges.length,
        connectedExchanges: connected.length,

        marketsAnalyzed: totalMarkets,
        tickersReceived: prices.length,

        candidatesFound: candidates.length,
        candidatesChecked: validationResults.length,

        candidatesRejected: rejectedCandidates.length,
        opportunitiesApproved: validatedOpportunities.length,

        budgetsUSD: BUDGETS_USD,
        budgetsBRL: BUDGETS_BRL,

        simulationsPerOpportunity:
          BUDGETS_USD.length + BUDGETS_BRL.length,

        quoteCurrencies: QUOTE_CURRENCIES,

        configuredReferenceMinimumProfitPercent: MIN_PROFIT,
        maximumSpreadPercent: MAX_SPREAD,

        validationConcurrency: VALIDATION_CONCURRENCY,

        preliminaryFilter:
          'Spread líquido estimado positivo. A aprovação depende da simulação completa.',

        note:
          'A aprovação final considera livro de ofertas, limites mínimos dos mercados, liquidez, taxas, slippage e lucro líquido. Conversões por paridade de stablecoins são identificadas como estimadas.'
      }
    };

    console.log(
      '[SCANNER] Finalizado em:',
      result.durationMs,
      'ms'
    );

    console.log(
      '[SCANNER] Aprovadas:',
      result.validatedCount,
      '| Rejeitadas:',
      result.rejectedCount
    );

    console.log(
      '[SCANNER] Análise concluída:',
      result.marketsAnalyzed,
      'mercados;',
      result.validatedCount,
      'oportunidades aprovadas.'
    );

    return result;

  } finally {
    // Fecha todas as instâncias somente ao final do ciclo.
    await Promise.all(
      Array.from(exchangeInstances.values()).map(
        exchange => safeCloseExchange(exchange)
      )
    );
  }
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

  buildConversionGraph,

  findConversionRate,

  findBudgetConversionRate,

  findUSDToBRL,

  mapWithConcurrency,

  createExchange
};
