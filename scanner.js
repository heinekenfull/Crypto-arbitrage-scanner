
const config = require('./config');

const {
  createExchange,
  getEnabledExchanges
} = require('./exchanges');

const {
  validateOrderBook,
  simulateBudget
} = require('./simulation');

// ==========================================
// CRYPTO ARBITRAGE SCANNER
// SPOT + SIMULAÇÃO INTEGRADA
// ==========================================

const SIMULATION = config.SIMULATION || {};
const ARBITRAGE = config.ARBITRAGE || {};

const QUOTE_CURRENCIES = ['USDT', 'USDC', 'USD', 'BRL'];

const STABLE_CURRENCIES = ['USD', 'USDT', 'USDC'];

const BUDGETS =
  SIMULATION.TRADE_BUDGETS_USD ||
  [50, 100, 150, 250, 500, 1000];

const MAX_CANDIDATES =
  Number(SIMULATION.MAX_CANDIDATES_TO_VALIDATE || 100);

const ORDERBOOK_AGE =
  Number(SIMULATION.ORDERBOOK_MAX_AGE_MS || 15000);

const MAX_BOOK_SKEW =
  Number(SIMULATION.MAX_BOOK_SKEW_MS || 5000);

const MIN_PROFIT =
  Number(ARBITRAGE.MIN_PROFIT_PERCENT || 0.30);

const MAX_SPREAD =
  Number(ARBITRAGE.MAX_SPREAD_PERCENT || 10);

const ORDERBOOK_LIMIT =
  SIMULATION.ORDERBOOK_DEPTH || undefined;

const FETCH_CONCURRENCY = 5;


// ==========================================
// CONCORRÊNCIA CONTROLADA
// ==========================================

async function mapWithConcurrency(items, limit, callback) {
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

  const workers = [];

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
    market.contract === true ||
    market.swap === true ||
    market.future === true ||
    market.option === true
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


// ==========================================
// SELEÇÃO DOS MERCADOS
// ==========================================

function getEligibleMarkets(exchange) {
  const markets = Object.values(exchange.markets || {});

  const eligible = markets.filter(isSpotMarket);

  const conversionMarkets = eligible.filter(market =>
    STABLE_CURRENCIES.includes(market.base) &&
    market.quote === 'BRL'
  );

  const remaining = eligible.filter(
    market => !conversionMarkets.includes(market)
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
// TAXAS DAS CORRETORAS
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
// NORMALIZAÇÃO DE COTAÇÕES
// ==========================================

function normalizeTicker(
  exchangeId,
  exchange,
  market,
  ticker
) {
  if (!ticker) return null;

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
    Number.isFinite(sourceTimestamp) &&
    sourceTimestamp > 0
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
      config.EXCHANGES[exchangeId]?.name ||
      exchangeId,

    symbol: market.symbol,
    base: market.base,
    quote: market.quote,

    bid,
    ask,

    last: Number(ticker.last) || null,

    feePercent: getMarketFee(
      exchangeId,
      market
    ),

    quoteVolume:
      Number(ticker.quoteVolume) || 0,

    timestamp,
    receivedAt,

    timestampEstimated:
      sourceTimestamp === null ||
      !Number.isFinite(sourceTimestamp)
  };
}


// ==========================================
// CONSULTA DE TICKERS
// ==========================================

async function fetchTickerChunk(
  exchange,
  exchangeId,
  markets
) {
  const symbols = markets.map(
    market => market.symbol
  );

  const results = [];

  if (exchange.has.fetchTickers) {
    try {
      const tickers = await exchange.fetchTickers(symbols);

      for (const market of markets) {
        const ticker = tickers[market.symbol];

        const normalized = normalizeTicker(
          exchangeId,
          exchange,
          market,
          ticker
        );

        if (normalized) {
          results.push(normalized);
        }
      }

      // Se o lote retornou cotações, preserva o resultado.
      // Se não retornou nenhuma, tenta individualmente.
      if (results.length > 0) {
        return results;
      }
    } catch (error) {
      // Continua para consulta individual.
    }
  }

  const individualResults = await mapWithConcurrency(
    markets,
    FETCH_CONCURRENCY,
    async market => {
      const ticker = await exchange.fetchTicker(
        market.symbol
      );

      return normalizeTicker(
        exchangeId,
        exchange,
        market,
        ticker
      );
    }
  );

  for (const item of individualResults) {
    if (item && !item.error) {
      results.push(item);
    }
  }

  return results;
}


// ==========================================
// CONSULTA DE UMA CORRETORA
// ==========================================

async function fetchExchangePrices(exchangeId) {
  const exchange = createExchange(exchangeId);

  await exchange.loadMarkets();

  const markets = getEligibleMarkets(exchange);

  const allPrices = [];

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
      config.EXCHANGES[exchangeId]?.name ||
      exchangeId,

    status: 'connected',
    connected: true,

    markets: allPrices.length,
    prices: allPrices
  };
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

    if (!graph[from]) {
      graph[from] = [];
    }

    graph[from].push({
      currency: to,
      rate
    });
  }

  for (const item of prices) {
    if (
      !Number.isFinite(item.bid) ||
      !Number.isFinite(item.ask) ||
      item.bid <= 0 ||
      item.ask <= 0
    ) {
      continue;
    }

    addRate(
      item.base,
      item.quote,
      item.bid
    );

    addRate(
      item.quote,
      item.base,
      1 / item.ask
    );
  }

  return graph;
}


// ==========================================
// LOCALIZAR TAXA DE CONVERSÃO
// ==========================================

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
      if (visited.has(edge.currency)) {
        continue;
      }

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
// CONVERSÃO DO ORÇAMENTO USD
// ==========================================

function findBudgetConversionRate(graph, quote) {
  const direct = findConversionRate(
    graph,
    'USD',
    quote
  );

  if (direct && direct > 0) {
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
// IDENTIFICAÇÃO DE OPORTUNIDADES
// ==========================================

function calculateOpportunities(exchangeResults) {
  const prices = exchangeResults.flatMap(
    result => result?.prices || []
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

        if (buy.exchangeId === sell.exchangeId) {
          continue;
        }

        if (
          buy.base !== sell.base ||
          buy.quote !== sell.quote
        ) {
          continue;
        }

        const grossSpread =
          ((sell.bid - buy.ask) / buy.ask) * 100;

        if (
          grossSpread <= 0 ||
          grossSpread > MAX_SPREAD
        ) {
          continue;
        }

        const fees =
          buy.feePercent +
          sell.feePercent;

        const estimatedNet =
          grossSpread - fees;

        if (estimatedNet < MIN_PROFIT) {
          continue;
        }

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

          buyFeePercent: buy.feePercent,
          sellFeePercent: sell.feePercent,

          grossSpreadPercent: grossSpread,
          estimatedFeePercent: fees,
          estimatedNetPercent: estimatedNet,

          buyTimestamp: buy.timestamp,
          sellTimestamp: sell.timestamp,

          buyTimestampEstimated:
            buy.timestampEstimated,

          sellTimestampEstimated:
            sell.timestampEstimated,

          simulations: []
        });
      }
    }
  }

  return opportunities.sort(
    (a, b) =>
      b.estimatedNetPercent -
      a.estimatedNetPercent
  );
}


// ==========================================
// CONSULTA DO LIVRO DE OFERTAS
// ==========================================

async function fetchOrderBookSnapshot(
  exchangeId,
  symbol
) {
  const exchange = createExchange(exchangeId);

  // CORREÇÃO:
  // Carrega os mercados antes de consultar o livro.
  await exchange.loadMarkets();

  if (!exchange.markets[symbol]) {
    throw new Error(
      `Mercado ${symbol} não encontrado em ${exchangeId}`
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
    .sort((a, b) => a[0] - b[0]);

  const bids = (book.bids || [])
    .filter(level =>
      Number(level[0]) > 0 &&
      Number(level[1]) > 0
    )
    .sort((a, b) => b[0] - a[0]);

  const normalizedBook = {
    asks,
    bids
  };

  const validation = validateOrderBook(
    normalizedBook
  );

  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const sourceTimestamp =
    book.timestamp === undefined ||
    book.timestamp === null
      ? null
      : Number(book.timestamp);

  const timestamp =
    Number.isFinite(sourceTimestamp) &&
    sourceTimestamp > 0
      ? sourceTimestamp
      : fetchedAt;

  if (
    timestamp > fetchedAt + 60000 ||
    fetchedAt - timestamp > ORDERBOOK_AGE ||
    fetchedAt - startedAt > ORDERBOOK_AGE
  ) {
    throw new Error(
      'Livro de ofertas desatualizado'
    );
  }

  return {
    asks,
    bids,

    timestamp,
    fetchedAt,

    timestampEstimated:
      sourceTimestamp === null ||
      !Number.isFinite(sourceTimestamp)
  };
}


// ==========================================
// VALIDAR SINCRONIZAÇÃO DOS LIVROS
// ==========================================

function validateBookSynchronization(
  buyBook,
  sellBook
) {
  // Quando ambos os servidores fornecem timestamps,
  // compara também os horários de origem.
  const difference = Math.abs(
    buyBook.timestamp - sellBook.timestamp
  );

  if (difference > MAX_BOOK_SKEW) {
    throw new Error(
      'Livros de ofertas consultados em horários muito diferentes'
    );
  }

  return true;
}


// ==========================================
// AVALIAR UMA OPORTUNIDADE
// ==========================================

async function evaluateCandidate(
  opportunity,
  conversionGraph
) {
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

  validateBookSynchronization(
    buyBook,
    sellBook
  );

  const buyExchange = createExchange(
    opportunity.buyExchangeId
  );

  const sellExchange = createExchange(
    opportunity.sellExchangeId
  );

  // CORREÇÃO PRINCIPAL:
  // As duas instâncias precisam carregar os mercados.
  await Promise.all([
    buyExchange.loadMarkets(),
    sellExchange.loadMarkets()
  ]);

  const buyMarket =
    buyExchange.markets[opportunity.symbol];

  const sellMarket =
    sellExchange.markets[opportunity.symbol];

  if (!buyMarket || !sellMarket) {
    throw new Error(
      'Não foi possível carregar os dados dos mercados para calcular as taxas'
    );
  }

  opportunity.buyFeePercent = getMarketFee(
    opportunity.buyExchangeId,
    buyMarket
  );

  opportunity.sellFeePercent = getMarketFee(
    opportunity.sellExchangeId,
    sellMarket
  );

  const quoteToBRL = findConversionRate(
    conversionGraph,
    opportunity.quote,
    'BRL'
  );

  const budgetConversion =
    findBudgetConversionRate(
      conversionGraph,
      opportunity.quote
    );

  if (!quoteToBRL || !budgetConversion) {
    throw new Error(
      'Conversão realista para BRL ou USD indisponível'
    );
  }

  opportunity.conversion = {
    quoteToBRL,

    usdToQuote: budgetConversion.rate,

    budgetConversionEstimated:
      budgetConversion.estimated
  };

  opportunity.simulations = BUDGETS.map(
    budgetUSD => {
      const budgetQuote =
        Number(budgetUSD) *
        budgetConversion.rate;

      const result = simulateBudget({
        budgetQuote,
        budgetUSD,

        buyOrderBook: buyBook,
        sellOrderBook: sellBook,

        buyFeePercent:
          opportunity.buyFeePercent,

        sellFeePercent:
          opportunity.sellFeePercent,

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
    }
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

  opportunity.bookTimestampEstimated =
    buyBook.timestampEstimated ||
    sellBook.timestampEstimated;

  opportunity.status =
    validated.length > 0
      ? 'validated'
      : 'rejected';

  const defaultBudget = Number(
    SIMULATION.DEFAULT_TRADE_BUDGET_USD || 100
  );

  const defaultSimulation =
    opportunity.simulations.find(
      item => item.budgetUSD === defaultBudget
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

  const enabledExchanges =
    getEnabledExchanges();

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
            config.EXCHANGES[exchangeId]?.name ||
            exchangeId,

          status: 'error',
          connected: false,

          markets: 0,
          prices: [],

          error:
            error.message || String(error)
        };
      }
    }
  );

  const connected = exchangeResults.filter(
    result => result && result.connected
  );

  const totalMarkets = connected.reduce(
    (total, result) =>
      total + result.markets,
    0
  );

  const prices = connected.flatMap(
    result => result.prices || []
  );

  const conversionGraph =
    buildConversionGraph(prices);

  const candidates =
    calculateOpportunities(connected);

  const selectedCandidates =
    candidates.slice(0, MAX_CANDIDATES);

  const validationResults =
    await mapWithConcurrency(
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

            error:
              error.message || String(error),

            simulations: [],
            validatedCount: 0
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

  const rejectedCandidates =
    validationResults.filter(item =>
      item && item.status === 'rejected'
    );

  return {
    timestamp: Date.now(),

    durationMs: Date.now() - startedAt,

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

    rejectedCount: rejectedCandidates.length,

    validatedCount: validatedOpportunities.length,

    opportunities: validatedOpportunities,

    // NOVO:
    // Mantém as razões das rejeições para diagnóstico.
    rejectedCandidates: rejectedCandidates.map(item => ({
      symbol: item.symbol,

      buyExchange: item.buyExchange,
      sellExchange: item.sellExchange,

      grossSpreadPercent:
        item.grossSpreadPercent,

      estimatedNetPercent:
        item.estimatedNetPercent,

      error: item.error || null,

      simulations: item.simulations || []
    })),

    diagnostics: {
      enabledExchanges: enabledExchanges.length,

      connectedExchanges: connected.length,

      marketsAnalyzed: totalMarkets,

      candidatesFound: candidates.length,

      candidatesChecked: validationResults.length,

      candidatesRejected: rejectedCandidates.length,

      opportunitiesApproved:
        validatedOpportunities.length,

      budgets: BUDGETS,

      quoteCurrencies: QUOTE_CURRENCIES,

      note:
        'As simulações utilizam livros de ofertas e taxas de mercado. A paridade USD/stablecoin usada no orçamento é identificada como estimativa.'
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

  buildConversionGraph,

  findConversionRate,

  mapWithConcurrency,

  createExchange
};
