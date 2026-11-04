
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
// CRYPTO ARBITRAGE SCANNER 6.2
// SPOT + SIMULAÇÃO
// ==========================================

const SIMULATION = config.SIMULATION || {};
const ARBITRAGE = config.ARBITRAGE || {};

const QUOTE_CURRENCIES = ['USDT', 'USDC', 'USD', 'BRL'];
const STABLE_CURRENCIES = ['USD', 'USDT', 'USDC'];

const BUDGETS = (
  SIMULATION.TRADE_BUDGETS_USD || [50, 100, 150, 250, 500, 1000]
)
  .map(Number)
  .filter(value => Number.isFinite(value) && value > 0);

const MAX_CANDIDATES = Math.max(
  1,
  Number(SIMULATION.MAX_CANDIDATES_TO_VALIDATE ?? 100)
);

const ORDERBOOK_AGE = Math.max(
  1000,
  Number(SIMULATION.ORDERBOOK_MAX_AGE_MS ?? 15000)
);

const MAX_BOOK_SKEW = Math.max(
  500,
  Number(SIMULATION.MAX_BOOK_SKEW_MS ?? 5000)
);

const MIN_PROFIT = Number(
  ARBITRAGE.MIN_PROFIT_PERCENT ?? 0.30
);

const MAX_SPREAD = Number(
  ARBITRAGE.MAX_SPREAD_PERCENT ?? 10
);

const ORDERBOOK_LIMIT =
  SIMULATION.ORDERBOOK_DEPTH || undefined;

const FETCH_CONCURRENCY = 5;


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

  return QUOTE_CURRENCIES.includes(
    String(market.quote).toUpperCase()
  );
}


// ==========================================
// SELEÇÃO DE MERCADOS
// ==========================================

function getEligibleMarkets(exchange) {
  const markets = Object.values(exchange.markets || {})
    .filter(isSpotMarket);

  const conversionMarkets = markets.filter(
    market =>
      STABLE_CURRENCIES.includes(market.base) &&
      market.quote === 'BRL'
  );

  const conversionSymbols = new Set(
    conversionMarkets.map(market => market.symbol)
  );

  const remaining = markets.filter(
    market => !conversionSymbols.has(market.symbol)
  );

  const maxMarkets = Math.max(
    1,
    Number(config.MAX_MARKETS_PER_EXCHANGE || 500)
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

  return Number(
    ARBITRAGE.TRADING_FEE_PERCENT ?? 0.10
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
    base: market.base,
    quote: market.quote,

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

  if (
    exchange.has &&
    exchange.has.fetchTickers === true
  ) {
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
// ==========================================

async function fetchExchangePrices(exchangeId) {
  const exchange = createExchange(exchangeId);

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
    await closeExchange(exchange);
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

    addRate(item.base, item.quote, item.bid);
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
// CONVERSÃO DO ORÇAMENTO
// ==========================================

function findBudgetConversionRate(graph, quote) {
  const direct = findConversionRate(
    graph,
    'USD',
    quote
  );

  if (
    direct &&
    Number.isFinite(direct) &&
    direct > 0
  ) {
    return {
      rate: direct,
      estimated: false
    };
  }

  if (STABLE_CURRENCIES.includes(quote)) {
    return {
      rate: 1,
      estimated: true
    };
  }

  return null;
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

        // O filtro preliminar não usa o mínimo final de lucro.
        // A aprovação financeira fica para o livro de ofertas.
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
// CONSULTAR LIVRO DE OFERTAS
// ==========================================

async function fetchOrderBookSnapshot(exchangeId, symbol) {
  const exchange = createExchange(exchangeId);

  try {
    await exchange.loadMarkets();

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

    if (
      !exchange.has ||
      exchange.has.fetchOrderBook !== true
    ) {
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
    await closeExchange(exchange);
  }
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
// AVALIAR OPORTUNIDADE
// ==========================================

async function evaluateCandidate(opportunity, conversionGraph) {
  const [buyBook, sellBook] = await Promise.all([
    fetchOrderBookSnapshot(
      opportunity.buyExchangeId,
      opportunity.symbol
    ),

    fetchOrderBookSnapshot(
      opportunity.sellExchangeId,
      opportunity.symbol
    )
  ]);

  validateBookSynchronization(buyBook, sellBook);

  // Usa as taxas obtidas dos mercados carregados
  // durante a consulta dos livros.
  opportunity.buyFeePercent = buyBook.feePercent;
  opportunity.sellFeePercent = sellBook.feePercent;

  const quoteToBRL = findConversionRate(
    conversionGraph,
    opportunity.quote,
    'BRL'
  );

  const budgetConversion = findBudgetConversionRate(
    conversionGraph,
    opportunity.quote
  );

  if (
    !quoteToBRL ||
    !Number.isFinite(quoteToBRL) ||
    quoteToBRL <= 0 ||
    !budgetConversion
  ) {
    throw new Error(
      `Conversão indisponível: ${opportunity.quote} para BRL ou USD para ${opportunity.quote}`
    );
  }

  opportunity.conversion = {
    quoteToBRL,
    usdToQuote: budgetConversion.rate,
    budgetConversionEstimated: budgetConversion.estimated
  };

  // ========================================
  // SIMULAÇÃO DOS ORÇAMENTOS
  // ========================================

  opportunity.simulations = BUDGETS.map(budgetUSD => {
    const budgetQuote =
      Number(budgetUSD) * budgetConversion.rate;

    const result = simulateBudget({
      budgetQuote,
      budgetUSD,

      buyOrderBook: buyBook,
      sellOrderBook: sellBook,

      buyFeePercent: opportunity.buyFeePercent,
      sellFeePercent: opportunity.sellFeePercent,

      quoteToBRL
    });

    return {
      ...result,

      budgetUSD,
      tradeBudgetUSD: budgetUSD,

      quoteCurrency: opportunity.quote,

      budgetConversionEstimated:
        budgetConversion.estimated
    };
  });

  const validated = opportunity.simulations.filter(
    simulation => simulation.validated === true
  );

  opportunity.validatedBudgets = validated.map(
    simulation => simulation.budgetUSD
  );

  opportunity.validatedCount = validated.length;

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

  opportunity.status =
    validated.length > 0 ? 'validated' : 'rejected';

  const defaultBudget = Number(
    SIMULATION.DEFAULT_TRADE_BUDGET_USD || 100
  );

  const defaultSimulation =
    opportunity.simulations.find(
      item => Number(item.budgetUSD) === defaultBudget
    ) || opportunity.simulations[0];

  if (defaultSimulation) {
    opportunity.netProfitBRL =
      defaultSimulation.netProfitBRL;

    opportunity.netProfitPercent =
      defaultSimulation.profitPercent;

    opportunity.fillRatio =
      defaultSimulation.fillRatio;
  }

  return opportunity;
}


// ==========================================
// CICLO PRINCIPAL
// ==========================================

async function scanMarket() {
  const startedAt = Date.now();

  const enabledExchanges = getEnabledExchanges();

  console.log(
    '[SCANNER] Corretoras habilitadas:',
    enabledExchanges.join(', ')
  );

  // ========================================
  // CONSULTAR CORRETORAS
  // ========================================

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

  // ========================================
  // VALIDAR COM LIVROS
  // ========================================

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
        console.error(
          '[SCANNER] Candidato rejeitado:',
          candidate.symbol,
          candidate.buyExchangeId,
          '->',
          candidate.sellExchangeId,
          error.message
        );

        return {
          ...candidate,

          status: 'rejected',

          error: error.message || String(error),

          simulations: [],
          validatedBudgets: [],
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
        .filter(item => item.validated)
        .map(item => Number(item.netProfitBRL) || 0)
    );

    const bBest = Math.max(
      0,
      ...b.simulations
        .filter(item => item.validated)
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

      budgets: BUDGETS,

      quoteCurrencies: QUOTE_CURRENCIES,

      minimumEstimatedProfitPercent: MIN_PROFIT,
      maximumSpreadPercent: MAX_SPREAD,

      preliminaryFilter:
        'Spread líquido estimado positivo. A aprovação depende da simulação completa.',

      note:
        'A aprovação final considera livro de ofertas, liquidez, taxas, slippage e lucro líquido. A paridade USD/stablecoin pode ser estimada quando não existe cotação direta.'
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

  return result;
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

  mapWithConcurrency,

  createExchange
};
