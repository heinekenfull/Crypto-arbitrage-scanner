
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
// CRYPTO ARBITRAGE SCANNER 6.2.4
// SPOT — SIMULAÇÃO USD / BRL
// ==========================================

const SIM = config.SIMULATION || {};
const ARB = config.ARBITRAGE || {};

const QUOTE_CURRENCIES = ['USDT', 'USDC', 'USD', 'BRL'];
const STABLE_CURRENCIES = ['USD', 'USDT', 'USDC'];

const ALLOWED_BUDGET_VALUES = [50, 100, 150, 250, 500];

const BUDGETS_USD = normalizeBudgets(
  SIM.TRADE_BUDGETS_USD
);

const BUDGETS_BRL = normalizeBudgets(
  SIM.TRADE_BUDGETS_BRL
);

const MIN_PROFIT_PERCENT = Number(
  ARB.MIN_PROFIT_PERCENT ?? 0.30
);

const MAX_SPREAD_PERCENT = Number(
  ARB.MAX_SPREAD_PERCENT ?? 10
);

const MAX_CANDIDATES = Math.max(
  1,
  Number(SIM.MAX_CANDIDATES_TO_VALIDATE ?? 100)
);

const VALIDATION_CONCURRENCY = Math.max(
  1,
  Number(SIM.VALIDATION_CONCURRENCY ?? 2)
);

// ==========================================
// UTILITÁRIOS
// ==========================================

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBudgets(values) {
  const source = Array.isArray(values)
    ? values
    : ALLOWED_BUDGET_VALUES;

  const result = source
    .map(Number)
    .filter(value =>
      ALLOWED_BUDGET_VALUES.includes(value)
    );

  return [...new Set(result)].sort((a, b) => a - b);
}

function normalizeExchangeId(exchange) {
  if (typeof exchange === 'string') return exchange;

  return exchange?.id ||
    exchange?.exchangeId ||
    exchange?.name ||
    null;
}

function normalizeTickerSymbol(ticker, key) {
  return ticker?.symbol || key || null;
}

function normalizeFeePercent(exchangeId, exchange, market) {
  const configuredFees =
    ARB.EXCHANGE_TAKER_FEES_PERCENT || {};

  const configured = configuredFees[exchangeId];

  if (configured !== undefined) {
    return Math.max(0, number(configured));
  }

  const marketFee = number(market?.taker, -1);

  if (marketFee >= 0) {
    return marketFee * 100;
  }

  const exchangeFee = number(exchange?.fees?.trading?.taker, -1);

  if (exchangeFee >= 0) {
    return exchangeFee * 100;
  }

  return Math.max(
    0,
    number(ARB.TRADING_FEE_PERCENT, 0.10)
  );
}

function getTickerPrices(ticker) {
  const ask = number(ticker?.ask, 0);
  const bid = number(ticker?.bid, 0);

  if (ask <= 0 || bid <= 0) return null;

  if (bid >= ask) return null;

  return { ask, bid };
}

function getTickerTimestamp(ticker) {
  const value = number(ticker?.timestamp, 0);

  if (!value) return null;

  return value < 1e12 ? value * 1000 : value;
}

// ==========================================
// CONCORRÊNCIA
// ==========================================

async function mapWithConcurrency(
  items,
  concurrency,
  callback
) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(number(concurrency, 1)));

  const results = new Array(list.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index++;

      if (current >= list.length) return;

      try {
        results[current] = await callback(
          list[current],
          current
        );
      } catch (error) {
        results[current] = {
          error: error.message || String(error)
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, list.length) },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

// ==========================================
// CORRETORAS E MERCADOS
// ==========================================

async function loadMarketsSafe(exchange) {
  if (!exchange) {
    throw new Error('Instância de corretora ausente.');
  }

  if (
    exchange.markets &&
    Object.keys(exchange.markets).length
  ) {
    return exchange.markets;
  }

  return exchange.loadMarkets();
}

async function fetchExchangePrices(
  exchangeId,
  sharedExchange = null
) {
  const exchange = sharedExchange ||
    await createExchange(exchangeId);

  if (!exchange) {
    throw new Error(
      'Não foi possível criar a corretora ' + exchangeId
    );
  }

  try {
    const markets = await loadMarketsSafe(exchange);

    if (typeof exchange.fetchTickers !== 'function') {
      throw new Error(
        exchangeId + ' não oferece consulta de tickers.'
      );
    }

    // Limita a quantidade de símbolos enviada à API.
    // Carregar todos os tickers de todas as corretoras simultaneamente
    // era uma das principais fontes de pressão de memória.
    const maxMarkets = Math.max(
      1,
      number(config.MAX_MARKETS_PER_EXCHANGE, 300)
    );

    const symbols = Object.values(markets)
      .filter(market =>
        market &&
        market.symbol &&
        market.active !== false &&
        market.spot !== false &&
        QUOTE_CURRENCIES.includes(market.quote)
      )
      .slice(0, maxMarkets)
      .map(market => market.symbol);

    if (!symbols.length) {
      return {
        exchangeId,
        prices: [],
        marketsAnalyzed: 0,
        fetchedAt: Date.now(),
        connected: true
      };
    }

    const tickers = await exchange.fetchTickers(symbols);

    const prices = [];

    for (const [key, ticker] of Object.entries(tickers || {})) {
      const symbol = normalizeTickerSymbol(ticker, key);
      const market = markets[symbol];

      if (!symbol || !market) continue;
      if (market.active === false) continue;
      if (market.spot === false) continue;

      const [base, quote] = symbol.split('/');

      if (!base || !quote) continue;
      if (!QUOTE_CURRENCIES.includes(quote)) continue;

      const values = getTickerPrices(ticker);

      if (!values) continue;

      const timestamp = getTickerTimestamp(ticker);

      prices.push({
        exchangeId,
        symbol,
        base,
        quote,

        ask: values.ask,
        bid: values.bid,

        last: number(ticker.last, 0),
        baseVolume: number(ticker.baseVolume, 0),
        quoteVolume: number(ticker.quoteVolume, 0),

        timestamp,

        feePercent: normalizeFeePercent(
          exchangeId,
          exchange,
          market
        ),

        info: {
          active: market.active !== false,
          spot: market.spot !== false
        }
      });
    }

    return {
      exchangeId,
      prices,
      marketsAnalyzed: symbols.length,
      fetchedAt: Date.now(),
      connected: true
    };
  } finally {
    if (!sharedExchange) {
      await closeExchange(exchange);
    }
  }
}

// ==========================================
// GRAFO DE CONVERSÃO
// ==========================================

function addConversionEdge(graph, from, to, rate, metadata = {}) {
  if (!from || !to || rate <= 0) return;

  if (!graph.has(from)) graph.set(from, []);

  graph.get(from).push({
    to,
    rate,
    estimated: metadata.estimated === true,
    source: metadata.source || 'market'
  });
}

function buildConversionGraph(priceCollections) {
  const graph = new Map();

  for (const collection of priceCollections || []) {
    const prices = collection?.prices || collection || [];

    for (const item of prices) {
      const bid = number(item.bid);
      const ask = number(item.ask);

      if (bid <= 0 || ask <= 0) continue;

      // Venda de BASE recebe QUOTE pelo bid.
      addConversionEdge(
        graph,
        item.base,
        item.quote,
        bid,
        { source: item.exchangeId }
      );

      // Compra de BASE usando QUOTE custa o ask.
      addConversionEdge(
        graph,
        item.quote,
        item.base,
        1 / ask,
        { source: item.exchangeId }
      );
    }
  }

  // Paridade de stablecoins: estimativa, nunca cotação garantida.
  const stablePairs = [
    ['USD', 'USDT'],
    ['USD', 'USDC'],
    ['USDT', 'USDC']
  ];

  for (const [a, b] of stablePairs) {
    addConversionEdge(
      graph,
      a,
      b,
      1,
      { estimated: true, source: 'stablecoin-parity' }
    );

    addConversionEdge(
      graph,
      b,
      a,
      1,
      { estimated: true, source: 'stablecoin-parity' }
    );
  }

  return graph;
}

// ==========================================
// BUSCA DE CONVERSÃO
// ==========================================

function findConversionRate(
  graph,
  from,
  to,
  maxHops = 4
) {
  if (!from || !to || !(graph instanceof Map)) return null;

  if (from === to) {
    return {
      rate: 1,
      estimated: false,
      path: [from]
    };
  }

  const queue = [{
    currency: from,
    rate: 1,
    hops: 0,
    path: [from],
    estimated: false
  }];

  const results = [];

  while (queue.length) {
    const current = queue.shift();

    if (current.hops >= maxHops) continue;

    const edges = graph.get(current.currency) || [];

    for (const edge of edges) {
      if (current.path.includes(edge.to)) continue;

      const rate = current.rate * edge.rate;

      const next = {
        currency: edge.to,
        rate,
        hops: current.hops + 1,
        path: [...current.path, edge.to],
        estimated: current.estimated || edge.estimated
      };

      if (edge.to === to) {
        results.push(next);
      } else {
        queue.push(next);
      }
    }
  }

  if (!results.length) return null;

  // Prefere caminhos curtos e não estimados.
  results.sort((a, b) => {
    if (a.estimated !== b.estimated) {
      return a.estimated ? 1 : -1;
    }

    if (a.hops !== b.hops) {
      return a.hops - b.hops;
    }

    return a.rate - b.rate;
  });

  const best = results[0];

  return {
    rate: best.rate,
    estimated: best.estimated,
    path: best.path
  };
}

function findConversionWithStableBridge(graph, from, to) {
  const direct = findConversionRate(graph, from, to);

  if (direct) return direct;

  if (
    STABLE_CURRENCIES.includes(from) &&
    STABLE_CURRENCIES.includes(to)
  ) {
    return {
      rate: 1,
      estimated: true,
      path: [from, to]
    };
  }

  return null;
}

function findBudgetConversionRate(
  graph,
  budgetCurrency,
  quote
) {
  const result = findConversionWithStableBridge(
    graph,
    budgetCurrency,
    quote
  );

  return result;
}

function findQuoteToBRL(graph, quote) {
  return findConversionWithStableBridge(
    graph,
    quote,
    'BRL'
  );
}

function findUSDToBRL(graph) {
  return findConversionWithStableBridge(
    graph,
    'USD',
    'BRL'
  );
}

// ==========================================
// CANDIDATOS DE ARBITRAGEM
// ==========================================

function calculateGrossSpreadPercent(buyAsk, sellBid) {
  if (buyAsk <= 0) return 0;

  return ((sellBid - buyAsk) / buyAsk) * 100;
}

function calculateEstimatedNetPercent(
  buyAsk,
  sellBid,
  buyFeePercent,
  sellFeePercent
) {
  if (buyAsk <= 0 || sellBid <= 0) return -Infinity;

  const buyCost = buyAsk * (
    1 + buyFeePercent / 100
  );

  const sellRevenue = sellBid * (
    1 - sellFeePercent / 100
  );

  return ((sellRevenue - buyCost) / buyCost) * 100;
}

function calculateOpportunities(priceCollections) {
  const markets = new Map();

  for (const collection of priceCollections || []) {
    for (const item of collection?.prices || []) {
      if (!markets.has(item.symbol)) {
        markets.set(item.symbol, []);
      }

      markets.get(item.symbol).push(item);
    }
  }

  const opportunities = [];

  for (const [symbol, entries] of markets.entries()) {
    if (entries.length < 2) continue;

    for (let i = 0; i < entries.length; i++) {
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;

        const buy = entries[i];
        const sell = entries[j];

        if (buy.exchangeId === sell.exchangeId) continue;

        const grossSpreadPercent = calculateGrossSpreadPercent(
          buy.ask,
          sell.bid
        );

        if (grossSpreadPercent <= 0) continue;
        if (grossSpreadPercent > MAX_SPREAD_PERCENT) continue;

        const estimatedNetPercent = calculateEstimatedNetPercent(
          buy.ask,
          sell.bid,
          buy.feePercent,
          sell.feePercent
        );

        if (estimatedNetPercent < MIN_PROFIT_PERCENT) continue;

        opportunities.push({
          symbol,
          base: buy.base,
          quote: buy.quote,

          buyExchangeId: buy.exchangeId,
          sellExchangeId: sell.exchangeId,

          buyExchange: buy.exchangeId,
          sellExchange: sell.exchangeId,

          buyPrice: buy.ask,
          sellPrice: sell.bid,

          buyFeePercent: buy.feePercent,
          sellFeePercent: sell.feePercent,

          grossSpreadPercent,
          estimatedNetPercent,

          buyTimestamp: buy.timestamp,
          sellTimestamp: sell.timestamp,

          status: 'candidate',
          simulations: [],
          validatedBudgets: [],
          validatedBudgetsUSD: [],
          validatedBudgetsBRL: []
        });
      }
    }
  }

  opportunities.sort(
    (a, b) => b.estimatedNetPercent - a.estimatedNetPercent
  );

  return opportunities;
}

// ==========================================
// LIVRO DE OFERTAS
// ==========================================

async function fetchOrderBook(exchange, symbol) {
  if (!exchange || typeof exchange.fetchOrderBook !== 'function') {
    throw new Error('Corretora não oferece livro de ofertas.');
  }

  const depth = SIM.ORDERBOOK_DEPTH || undefined;

  return exchange.fetchOrderBook(symbol, depth);
}

// ==========================================
// SIMULAÇÃO DE CADA CAPITAL
// ==========================================

function createBudgetSimulation(
  opportunity,
  currency,
  amount,
  buyOrderBook,
  sellOrderBook,
  conversionGraph
) {
  const budgetConversion = findBudgetConversionRate(
    conversionGraph,
    currency,
    opportunity.quote
  );

  if (!budgetConversion || budgetConversion.rate <= 0) {
    return {
      validated: false,
      approved: false,
      status: 'rejected',
      budgetCurrency: currency,
      budgetAmount: amount,
      reason: 'Não foi possível converter o capital para ' +
        opportunity.quote + '.'
    };
  }

  const quoteToBRLResult = findQuoteToBRL(
    conversionGraph,
    opportunity.quote
  );

  const usdToBRLResult = findUSDToBRL(
    conversionGraph
  );

  const quoteToBRL = quoteToBRLResult?.rate || null;
  const usdToBRL = usdToBRLResult?.rate || null;

  const simulation = simulateBudget({
    budgetCurrency: currency,
    budgetAmount: amount,
    budgetQuote: amount * budgetConversion.rate,

    buyOrderBook,
    sellOrderBook,

    buyFeePercent: opportunity.buyFeePercent,
    sellFeePercent: opportunity.sellFeePercent,

    quoteToBRL,
    usdToBRL,

    maxSlippagePercent: SIM.MAX_SLIPPAGE_PERCENT,
    minFillRatio: SIM.MIN_BUDGET_FILL_RATIO,
    minNetProfitBRL: SIM.MIN_NET_PROFIT_BRL
  });

  return {
    ...simulation,

    budgetCurrency: currency,
    budgetAmount: amount,

    conversionRate: budgetConversion.rate,
    conversionPath: budgetConversion.path,

    conversionEstimated:
      budgetConversion.estimated ||
      quoteToBRLResult?.estimated === true ||
      usdToBRLResult?.estimated === true,

    conversionQuoteToBRLEstimated:
      quoteToBRLResult?.estimated === true,

    conversionUSDToBRLEstimated:
      usdToBRLResult?.estimated === true
  };
}

// ==========================================
// VALIDAÇÃO DE UMA OPORTUNIDADE
// ==========================================

async function evaluateCandidate(
  opportunity,
  conversionGraph,
  exchangeInstances = null
) {
  if (!(exchangeInstances instanceof Map)) {
    throw new Error(
      'Instâncias de corretoras indisponíveis para validação.'
    );
  }

  const buyExchange = exchangeInstances.get(
    opportunity.buyExchangeId
  );

  const sellExchange = exchangeInstances.get(
    opportunity.sellExchangeId
  );

  if (!buyExchange || !sellExchange) {
    throw new Error(
      'Uma das corretoras não está disponível.'
    );
  }

  const [buyOrderBook, sellOrderBook] = await Promise.all([
    fetchOrderBook(buyExchange, opportunity.symbol),
    fetchOrderBook(sellExchange, opportunity.symbol)
  ]);

  const buyValidation = validateOrderBook(buyOrderBook);
  const sellValidation = validateOrderBook(sellOrderBook);

  if (!buyValidation.valid) {
    throw new Error('Livro de compra inválido: ' + buyValidation.reason);
  }

  if (!sellValidation.valid) {
    throw new Error('Livro de venda inválido: ' + sellValidation.reason);
  }

  const freshSpread = calculateGrossSpreadPercent(
    buyValidation.bestAsk,
    sellValidation.bestBid
  );

  if (freshSpread <= 0) {
    throw new Error('A diferença de preços desapareceu.');
  }

  if (freshSpread > MAX_SPREAD_PERCENT) {
    throw new Error('Spread acima do limite permitido.');
  }

  const freshNet = calculateEstimatedNetPercent(
    buyValidation.bestAsk,
    sellValidation.bestBid,
    opportunity.buyFeePercent,
    opportunity.sellFeePercent
  );

  if (freshNet < MIN_PROFIT_PERCENT) {
    throw new Error(
      'A margem estimada não cobre o lucro mínimo após taxas.'
    );
  }

  const freshOpportunity = {
    ...opportunity,
    buyPrice: buyValidation.bestAsk,
    sellPrice: sellValidation.bestBid,
    grossSpreadPercent: freshSpread,
    estimatedNetPercent: freshNet
  };

  const simulations = [];

  for (const budget of BUDGETS_USD) {
    const result = createBudgetSimulation(
      freshOpportunity,
      'USD',
      budget,
      buyOrderBook,
      sellOrderBook,
      conversionGraph
    );

    simulations.push(result);
  }

  for (const budget of BUDGETS_BRL) {
    const result = createBudgetSimulation(
      freshOpportunity,
      'BRL',
      budget,
      buyOrderBook,
      sellOrderBook,
      conversionGraph
    );

    simulations.push(result);
  }

  const validatedBudgetsUSD = simulations
    .filter(item =>
      item.budgetCurrency === 'USD' &&
      item.validated === true
    );

  const validatedBudgetsBRL = simulations
    .filter(item =>
      item.budgetCurrency === 'BRL' &&
      item.validated === true
    );

  const validatedBudgets = validatedBudgetsUSD;

  return {
    ...freshOpportunity,

    status:
      validatedBudgetsUSD.length ||
      validatedBudgetsBRL.length
        ? 'validated'
        : 'not_validated',

    simulations,

    validatedBudgets,
    validatedBudgetsUSD,
    validatedBudgetsBRL,

    validatedCountUSD: validatedBudgetsUSD.length,
    validatedCountBRL: validatedBudgetsBRL.length,

    buyOrderBookTimestamp: buyOrderBook.timestamp || null,
    sellOrderBookTimestamp: sellOrderBook.timestamp || null,

    validatedAt: new Date().toISOString()
  };
}

// ==========================================
// FECHAMENTO DAS CONEXÕES
// ==========================================

async function closeExchangeMap(exchangeInstances) {
  if (!(exchangeInstances instanceof Map)) return;

  const instances = [...exchangeInstances.values()];

  await mapWithConcurrency(
    instances,
    3,
    async exchange => closeExchange(exchange)
  );

  exchangeInstances.clear();
}

// ==========================================
// SCANNER PRINCIPAL
// ==========================================

async function scanMarket() {
  const startedAt = Date.now();

  const enabled = getEnabledExchanges() || [];

  const exchangeIds = enabled
    .map(normalizeExchangeId)
    .filter(Boolean);

  const priceCollections = [];
  const exchangeResults = [];

  let marketsAnalyzed = 0;

  // Consulta uma corretora por vez. Cada instância CCXT é fechada
  // assim que seus preços compactos são extraídos.
  const fetched = await mapWithConcurrency(
    exchangeIds,
    1,
    async exchangeId => fetchExchangePrices(exchangeId)
  );

  for (let i = 0; i < fetched.length; i++) {
    const result = fetched[i];

    if (result?.error) {
      exchangeResults.push({
        id: exchangeIds[i],
        name: exchangeIds[i],
        enabled: true,
        connected: false,
        status: 'error',
        error: result.error,
        markets: 0
      });
      continue;
    }

    if (!result) continue;

    priceCollections.push(result);
    marketsAnalyzed += number(result.marketsAnalyzed);

    exchangeResults.push({
      id: result.exchangeId,
      name: result.exchangeId,
      enabled: true,
      connected: true,
      status: 'connected',
      markets: result.marketsAnalyzed
    });
  }

  try {

    const conversionGraph = buildConversionGraph(
      priceCollections
    );

    const candidates = calculateOpportunities(
      priceCollections
    );

    const selectedCandidates = candidates.slice(
      0,
      MAX_CANDIDATES
    );

    // Valida por par de corretoras: no máximo duas instâncias CCXT
    // permanecem carregadas ao mesmo tempo. Reutiliza o par para todos
    // os candidatos correspondentes e fecha as conexões ao terminar.
    const candidateGroups = new Map();

    for (const opportunity of selectedCandidates) {
      const key = [
        opportunity.buyExchangeId,
        opportunity.sellExchangeId
      ].join('::');

      if (!candidateGroups.has(key)) {
        candidateGroups.set(key, []);
      }

      candidateGroups.get(key).push(opportunity);
    }

    const evaluated = [];

    for (const group of candidateGroups.values()) {
      const pairInstances = new Map();

      try {
        const ids = [
          group[0].buyExchangeId,
          group[0].sellExchangeId
        ];

        for (const exchangeId of ids) {
          const exchange = await createExchange(exchangeId);
          if (!exchange) {
            throw new Error('Falha ao criar instância: ' + exchangeId);
          }
          pairInstances.set(exchangeId, exchange);
        }

        for (const opportunity of group) {
          try {
            evaluated.push(await evaluateCandidate(
              opportunity,
              conversionGraph,
              pairInstances
            ));
          } catch (error) {
            evaluated.push({
              error: error.message || String(error),
              symbol: opportunity.symbol,
              buyExchangeId: opportunity.buyExchangeId,
              sellExchangeId: opportunity.sellExchangeId
            });
          }
        }
      } catch (error) {
        for (const opportunity of group) {
          evaluated.push({
            error: error.message || String(error),
            symbol: opportunity.symbol,
            buyExchangeId: opportunity.buyExchangeId,
            sellExchangeId: opportunity.sellExchangeId
          });
        }
      } finally {
        await closeExchangeMap(pairInstances);
      }
    }

    const opportunities = evaluated
      .filter(item => item && !item.error)
      .sort((a, b) =>
        number(b.estimatedNetPercent) -
        number(a.estimatedNetPercent)
      );

    const rejected = evaluated
      .filter(item => item?.error)
      .map(item => ({
        reason: item.error
      }));

    const validatedCount = opportunities.filter(
      item => item.status === 'validated'
    ).length;

    return {
      success: true,
      market: 'spot',
      version: '6.2.4',

      timestamp: Date.now(),
      lastUpdated: Date.now(),

      exchanges: exchangeResults,
      exchangesConnected: exchangeResults.filter(
        item => item.connected
      ).length,

      marketsAnalyzed,

      candidatesFound: candidates.length,
      candidatesValidated: opportunities.length,
      validatedOpportunities: validatedCount,

      opportunities,

      diagnostics: {
        enabledExchanges: exchangeIds.length,
        connectedExchanges: exchangeResults.filter(
          item => item.connected
        ).length,

        candidateCount: candidates.length,
        candidatesChecked: selectedCandidates.length,

        validationErrors: rejected.length,
        validationConcurrency: VALIDATION_CONCURRENCY,

        budgetsUSD: BUDGETS_USD,
        budgetsBRL: BUDGETS_BRL,

        simulationsPerOpportunity:
          BUDGETS_USD.length + BUDGETS_BRL.length,

        rejected
      },

      durationMs: Date.now() - startedAt
    };
  } finally {
    await closeExchangeMap(exchangeInstances);
  }
}

// ==========================================
// EXPORTAÇÕES
// ==========================================

module.exports = {
  scanMarket,
  fetchExchangePrices,
  mapWithConcurrency,

  buildConversionGraph,
  findConversionRate,
  findBudgetConversionRate,
  findUSDToBRL,

  calculateOpportunities,
  evaluateCandidate
};
