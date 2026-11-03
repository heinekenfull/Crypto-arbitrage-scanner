
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

const SIM = config.SIMULATION || {};
const ARB = config.ARBITRAGE || {};

const TRADE_BUDGET_BRL =
  Number(SIM.TRADE_BUDGET_BRL) || 100;

const ORDERBOOK_DEPTH =
  Number(SIM.ORDERBOOK_DEPTH) || 50;

const ORDERBOOK_MAX_AGE =
  Number(SIM.ORDERBOOK_MAX_AGE_MS) || 15000;

const MAX_VALIDATIONS =
  Number(SIM.MAX_CANDIDATES_TO_VALIDATE) || 30;

const MAX_SLIPPAGE =
  Number(SIM.MAX_SLIPPAGE_PERCENT) || 1;

const MIN_FILL_RATIO =
  Number(SIM.MIN_BUDGET_FILL_RATIO) || 0.98;

const MIN_NET_BRL =
  Number(SIM.MIN_NET_PROFIT_BRL) || 0.10;

const MAX_SPREAD =
  Number(ARB.MAX_SPREAD_PERCENT) || 10;

// ==========================================
// CONEXÃO COM CORRETORAS
// ==========================================

function createExchange(id) {
  if (exchangeCache[id]) {
    return exchangeCache[id];
  }

  if (!ccxt[id]) {
    throw new Error(
      `Corretora não suportada: ${id}`
    );
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

// ==========================================
// CONCORRÊNCIA
// ==========================================

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
    {
      length: Math.min(limit, items.length)
    },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

// ==========================================
// TAXAS INDIVIDUAIS
// ==========================================

function getMarketFee(market, exchangeId) {
  const overrides =
    ARB.EXCHANGE_TAKER_FEES_PERCENT || {};

  const override = overrides[exchangeId];

  if (
    override !== undefined &&
    override !== null &&
    override !== '' &&
    Number.isFinite(Number(override)) &&
    Number(override) >= 0
  ) {
    return {
      percent: Number(override),
      source: 'CONFIG'
    };
  }

  if (
    market &&
    market.taker !== undefined &&
    market.taker !== null &&
    market.taker !== '' &&
    Number.isFinite(Number(market.taker)) &&
    Number(market.taker) >= 0
  ) {
    return {
      percent: Number(market.taker) * 100,
      source: 'CCXT'
    };
  }

  return {
    percent:
      Number(ARB.TRADING_FEE_PERCENT) || 0.10,
    source: 'FALLBACK'
  };
}

// ==========================================
// SELEÇÃO DE MERCADOS
// ==========================================

function getEligibleMarkets(exchange) {
  const markets = Object.values(
    exchange.markets || {}
  );

  const eligible = markets.filter(market => {
    return (
      market &&
      market.symbol &&
      market.active !== false &&
      market.contract !== true &&
      market.spot !== false &&
      QUOTE_PRIORITY.includes(market.quote)
    );
  });

  eligible.sort((a, b) => {
    return (
      QUOTE_PRIORITY.indexOf(a.quote) -
      QUOTE_PRIORITY.indexOf(b.quote)
    );
  });

  const conversionMarkets = eligible.filter(market => {
    return (
      market.quote === 'BRL' ||
      (
        ['USDT', 'USDC', 'FDUSD'].includes(market.base) &&
        ['USDT', 'USDC', 'FDUSD'].includes(market.quote)
      ) ||
      (
        ['BTC', 'ETH'].includes(market.base) &&
        ['BRL', 'USDT', 'USDC', 'FDUSD'].includes(market.quote)
      )
    );
  });

  const conversionSymbols = new Set(
    conversionMarkets.map(m => m.symbol)
  );

  const others = eligible.filter(
    market => !conversionSymbols.has(market.symbol)
  );

  const limit =
    Number(config.MAX_MARKETS_PER_EXCHANGE) ||
    MAX_MARKETS;

  return [
    ...conversionMarkets,
    ...others.slice(
      0,
      Math.max(0, limit - conversionMarkets.length)
    )
  ];
}

// ==========================================
// CAPTURA DE COTAÇÕES
// ==========================================

async function fetchExchangePrices(exchangeId) {
  const exchange = createExchange(exchangeId);

  await exchange.loadMarkets();

  const markets = getEligibleMarkets(exchange);

  if (!markets.length) {
    throw new Error(
      'Nenhum mercado Spot compatível'
    );
  }

  if (!exchange.has.fetchTickers) {
    throw new Error(
      'Corretora não oferece fetchTickers'
    );
  }

  const symbols = markets.map(
    market => market.symbol
  );

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

    const timestamp =
      sourceTimestamp || receivedAt;

    if (
      receivedAt - timestamp >
      MAX_PRICE_AGE
    ) {
      continue;
    }

    const fee = getMarketFee(
      market,
      exchangeId
    );

    prices[market.symbol] = {
      bid,
      ask,

      last: Number(ticker.last) || null,

      timestamp,

      timestampEstimated: !sourceTimestamp,

      takerFeePercent: fee.percent,
      feeSource: fee.source,

      base: market.base,
      quote: market.quote,

      volume:
        Number(ticker.quoteVolume) || null
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

// ==========================================
// CONVERSÃO DE MOEDAS PARA BRL
// ==========================================

function buildConversionGraph(exchangeData) {
  const graph = {};

  const allowed = new Set([
    'BRL',
    'USDT',
    'USDC',
    'FDUSD',
    'BTC',
    'ETH'
  ]);

  function addEdge(from, to, rate) {
    if (!graph[from]) {
      graph[from] = [];
    }

    graph[from].push({
      currency: to,
      rate
    });
  }

  for (const exchange of exchangeData) {
    for (const [symbol, price] of Object.entries(
      exchange.prices || {}
    )) {
      const parts = symbol.split('/');

      if (parts.length !== 2) continue;

      const [base, quote] = parts;

      if (
        !allowed.has(base) ||
        !allowed.has(quote)
      ) {
        continue;
      }

      const mid = (price.bid + price.ask) / 2;

      if (!Number.isFinite(mid) || mid <= 0) {
        continue;
      }

      addEdge(base, quote, mid);
      addEdge(quote, base, 1 / mid);
    }
  }

  return graph;
}

function findConversionRate(from, to, graph) {
  if (from === to) return 1;

  const queue = [{
    currency: from,
    rate: 1,
    visited: [from]
  }];

  while (queue.length) {
    const current = queue.shift();

    if (current.visited.length > 4) {
      continue;
    }

    for (const edge of graph[current.currency] || []) {
      if (current.visited.includes(edge.currency)) {
        continue;
      }

      const rate = current.rate * edge.rate;

      if (edge.currency === to) {
        return rate;
      }

      queue.push({
        currency: edge.currency,
        rate,
        visited: [
          ...current.visited,
          edge.currency
        ]
      });
    }
  }

  return null;
}

// ==========================================
// COMPARAÇÃO INICIAL DE PREÇOS
// ==========================================

function calculateAllCandidates(exchangeData) {
  const candidates = [];

  const symbols = new Set();

  for (const exchange of exchangeData) {
    Object.keys(exchange.prices || {}).forEach(
      symbol => symbols.add(symbol)
    );
  }

  let comparisons = 0;

  for (const symbol of symbols) {
    const markets = [];

    for (const exchange of exchangeData) {
      const price = exchange.prices[symbol];

      if (!price) continue;

      markets.push({
        exchange: exchange.exchange,

        bid: price.bid,
        ask: price.ask,

        timestamp: price.timestamp,

        timestampEstimated:
          price.timestampEstimated,

        fee: price.takerFeePercent,
        feeSource: price.feeSource,

        base: price.base,
        quote: price.quote,

        volume: price.volume
      });
    }

    if (markets.length < 2) continue;

    for (const buy of markets) {
      for (const sell of markets) {
        if (buy.exchange === sell.exchange) {
          continue;
        }

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

        candidates.push({
          symbol,

          buyExchange: buy.exchange,
          sellExchange: sell.exchange,

          buyPrice: buy.ask,
          sellPrice: sell.bid,

          buyFeePercent: buy.fee,
          sellFeePercent: sell.fee,

          buyFeeSource: buy.feeSource,
          sellFeeSource: sell.feeSource,

          estimatedFeesPercent: Number(
            estimatedFees.toFixed(4)
          ),

          grossProfitPercent: Number(
            grossProfit.toFixed(4)
          ),

          netProfitPercent: Number(
            netProfit.toFixed(4)
          ),

          base: buy.base,
          quote: buy.quote,

          buyTimestamp: buy.timestamp,
          sellTimestamp: sell.timestamp,

          timestampEstimated:
            buy.timestampEstimated ||
            sell.timestampEstimated,

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

// ==========================================
// LEITURA DO LIVRO DE OFERTAS
// ==========================================

async function fetchOrderBookSnapshot(
  exchangeId,
  symbol
) {
  const exchange = createExchange(exchangeId);

  if (!exchange.has.fetchOrderBook) {
    throw new Error(
      `${exchangeId} não oferece consulta ao livro`
    );
  }

  const book = await exchange.fetchOrderBook(
    symbol,
    ORDERBOOK_DEPTH
  );

  const receivedAt = Date.now();

  if (
    book.timestamp &&
    receivedAt - book.timestamp >
    ORDERBOOK_MAX_AGE
  ) {
    throw new Error(
      'Livro de ofertas desatualizado'
    );
  }

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

  if (!asks.length || !bids.length) {
    throw new Error(
      'Livro de ofertas sem liquidez'
    );
  }

  return {
    asks,
    bids,
    timestamp: book.timestamp || receivedAt,
    timestampEstimated: !book.timestamp
  };
}

// ==========================================
// QUANTIDADE COMPRÁVEL COM O ORÇAMENTO
// ==========================================

function calculateBuyQuantity(
  asks,
  budget,
  feeRate
) {
  let remaining = budget;
  let quantity = 0;

  for (const [price, available] of asks) {
    const costPerUnit =
      price * (1 + feeRate);

    const possible =
      remaining / costPerUnit;

    const amount = Math.min(
      available,
      possible
    );

    if (amount <= 0) continue;

    quantity += amount;

    remaining -=
      amount * price * (1 + feeRate);

    if (remaining <= 0.0000000001) {
      break;
    }
  }

  return quantity;
}

// ==========================================
// CUSTO DE COMPRA POR QUANTIDADE
// ==========================================

function calculateBuyCost(asks, quantity) {
  let remaining = quantity;
  let cost = 0;
  let levelsUsed = 0;

  for (const [price, available] of asks) {
    const amount = Math.min(
      remaining,
      available
    );

    if (amount <= 0) continue;

    cost += amount * price;
    remaining -= amount;

    levelsUsed++;

    if (remaining <= 0.0000000001) {
      break;
    }
  }

  if (remaining > 0.0000000001) {
    return null;
  }

  return {
    quantity,
    cost,
    vwap: cost / quantity,
    levelsUsed
  };
}

// ==========================================
// RECEITA DE VENDA POR QUANTIDADE
// ==========================================

function calculateSellRevenue(bids, quantity) {
  let remaining = quantity;
  let revenue = 0;
  let levelsUsed = 0;

  for (const [price, available] of bids) {
    const amount = Math.min(
      remaining,
      available
    );

    if (amount <= 0) continue;

    revenue += amount * price;
    remaining -= amount;

    levelsUsed++;

    if (remaining <= 0.0000000001) {
      break;
    }
  }

  if (remaining > 0.0000000001) {
    return null;
  }

  return {
    quantity,
    revenue,
    vwap: revenue / quantity,
    levelsUsed
  };
}

// ==========================================
// VALIDAÇÃO FINANCEIRA DE UMA OPORTUNIDADE
// ==========================================

async function evaluateCandidate(
  candidate,
  conversionGraph
) {
  const quoteToBRL = findConversionRate(
    candidate.quote,
    'BRL',
    conversionGraph
  );

  if (
    !quoteToBRL ||
    !Number.isFinite(quoteToBRL)
  ) {
    throw new Error(
      `Não foi possível converter ${candidate.quote} para BRL`
    );
  }

  const [buyBook, sellBook] = await Promise.all([
    fetchOrderBookSnapshot(
      candidate.buyExchange,
      candidate.symbol
    ),

    fetchOrderBookSnapshot(
      candidate.sellExchange,
      candidate.symbol
    )
  ]);

  const bestAsk = buyBook.asks[0][0];
  const bestBid = sellBook.bids[0][0];

  const buyFeeRate =
    candidate.buyFeePercent / 100;

  const sellFeeRate =
    candidate.sellFeePercent / 100;

  const budgetQuote =
    TRADE_BUDGET_BRL / quoteToBRL;

  // Quanto conseguimos comprar com o orçamento?
  const affordableQuantity = calculateBuyQuantity(
    buyBook.asks,
    budgetQuote,
    buyFeeRate
  );

  // Quanto conseguimos vender no livro da outra corretora?
  const sellCapacity = sellBook.bids.reduce(
    (total, level) => total + level[1],
    0
  );

  const quantity = Math.min(
    affordableQuantity,
    sellCapacity
  );

  if (
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    throw new Error(
      'Liquidez insuficiente para simular a operação'
    );
  }

  const buy = calculateBuyCost(
    buyBook.asks,
    quantity
  );

  const sell = calculateSellRevenue(
    sellBook.bids,
    quantity
  );

  if (!buy || !sell) {
    throw new Error(
      'Não foi possível preencher a quantidade nos livros'
    );
  }

  // Taxas calculadas sobre o valor negociado.
  // Modelo estimado conservador em moeda de cotação.
  const buyFee = buy.cost * buyFeeRate;
  const sellFee = sell.revenue * sellFeeRate;

  const totalBuyCost = buy.cost + buyFee;

  const netSaleRevenue =
    sell.revenue - sellFee;

  const netProfitQuote =
    netSaleRevenue - totalBuyCost;

  const investedBRL =
    totalBuyCost * quoteToBRL;

  const revenueBRL =
    netSaleRevenue * quoteToBRL;

  const netProfitBRL =
    netProfitQuote * quoteToBRL;

  const netProfitPercent =
    totalBuyCost > 0
      ? (netProfitQuote / totalBuyCost) * 100
      : 0;

  // Slippage em relação ao melhor preço disponível.
  const buySlippage =
    ((buy.vwap - bestAsk) / bestAsk) * 100;

  const sellSlippage =
    ((bestBid - sell.vwap) / bestBid) * 100;

  const crossSpread =
    ((bestBid - bestAsk) / bestAsk) * 100;

  const effectiveSpread =
    ((sell.vwap - buy.vwap) / buy.vwap) * 100;

  const fillRatio =
    investedBRL / TRADE_BUDGET_BRL;

  const totalSlippage =
    buySlippage + sellSlippage;

  let rejectionReason = null;

  if (fillRatio < MIN_FILL_RATIO) {
    rejectionReason =
      'Liquidez insuficiente para preencher 98% do orçamento';
  } else if (
    buySlippage > MAX_SLIPPAGE ||
    sellSlippage > MAX_SLIPPAGE
  ) {
    rejectionReason =
      'Slippage acima do limite configurado';
  }

  let status = 'validated';

  if (rejectionReason) {
    status = 'rejected';
  } else if (netProfitBRL <= 0) {
    status = 'not_profitable';
  }

  return {
    ...candidate,

    status,
    rejectionReason,

    simulationBudgetBRL: TRADE_BUDGET_BRL,

    quoteToBRL: Number(
      quoteToBRL.toFixed(8)
    ),

    quantity: Number(quantity.toFixed(8)),

    buyPrice: Number(buy.vwap.toFixed(10)),
    sellPrice: Number(sell.vwap.toFixed(10)),

    bestBuyPrice: bestAsk,
    bestSellPrice: bestBid,

    buyLevelsConsumed: buy.levelsUsed,
    sellLevelsConsumed: sell.levelsUsed,

    buyMarketSpreadPercent: Number(
      buySlippage.toFixed(4)
    ),

    sellMarketSpreadPercent: Number(
      sellSlippage.toFixed(4)
    ),

    crossSpreadPercent: Number(
      crossSpread.toFixed(4)
    ),

    effectiveSpreadPercent: Number(
      effectiveSpread.toFixed(4)
    ),

    buySlippagePercent: Number(
      buySlippage.toFixed(4)
    ),

    sellSlippagePercent: Number(
      sellSlippage.toFixed(4)
    ),

    totalSlippagePercent: Number(
      totalSlippage.toFixed(4)
    ),

    buyFeeAmount: Number(
      buyFee.toFixed(8)
    ),

    sellFeeAmount: Number(
      sellFee.toFixed(8)
    ),

    estimatedFeesPercent: Number(
      (candidate.buyFeePercent +
       candidate.sellFeePercent).toFixed(4)
    ),

    investedBRL: Number(
      investedBRL.toFixed(4)
    ),

    estimatedRevenueBRL: Number(
      revenueBRL.toFixed(4)
    ),

    estimatedGrossProfitBRL: Number(
      ((sell.revenue - buy.cost) *
       quoteToBRL).toFixed(4)
    ),

    netProfitBRL: Number(
      netProfitBRL.toFixed(4)
    ),

    netProfitPercent: Number(
      netProfitPercent.toFixed(4)
    ),

    budgetFillPercent: Number(
      (fillRatio * 100).toFixed(2)
    ),

    buyBookTimestamp: buyBook.timestamp,
    sellBookTimestamp: sellBook.timestamp,

    orderBookTimestampEstimated:
      buyBook.timestampEstimated ||
      sellBook.timestampEstimated,

    timestamp: Date.now(),

    mode: 'SIMULATION'
  };
}

// ==========================================
// OPORTUNIDADES PRELIMINARES
// ==========================================

function calculateOpportunities(exchangeData) {
  const result = calculateAllCandidates(exchangeData);

  return result.candidates.filter(item => {
    return (
      item.netProfitPercent >=
      Number(ARB.MIN_PROFIT_PERCENT)
    );
  });
}

// ==========================================
// SCANNER PRINCIPAL
// ==========================================

async function scanMarket() {
  const exchangeIds = Object.entries(
    config.EXCHANGES
  )
    .filter(([id, settings]) => {
      return settings.enabled && Boolean(ccxt[id]);
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

  const analysis =
    calculateAllCandidates(exchangeData);

  const conversionGraph =
    buildConversionGraph(exchangeData);

  // Só as melhores candidatas passam para
  // a validação mais pesada do livro de ofertas.
  const toValidate = analysis.candidates
    .filter(item => item.netProfitPercent > 0)
    .slice(0, MAX_VALIDATIONS);

  const validationResults = await mapWithConcurrency(
    toValidate,
    2,
    candidate =>
      evaluateCandidate(candidate, conversionGraph)
  );

  const validatedCandidates = validationResults.map(
    (result, index) => {
      if (result && !result.error) {
        return result;
      }

      return {
        ...toValidate[index],
        status: 'validation_failed',
        rejectionReason:
          result?.error || 'Falha na validação',
        mode: 'SIMULATION'
      };
    }
  );

  const minProfit =
    Number(ARB.MIN_PROFIT_PERCENT) || 0;

  const opportunities = validatedCandidates.filter(
    item => {
      return (
        item.status === 'validated' &&
        item.netProfitPercent >= minProfit &&
        item.netProfitBRL >= MIN_NET_BRL
      );
    }
  );

  const marketSignals = analysis.candidates
    .filter(item => item.netProfitPercent > 0)
    .slice(0, 100);

  return {
    timestamp: Date.now(),

    mode: 'SIMULATION',

    simulationBudgetBRL: TRADE_BUDGET_BRL,

    exchangesConnected: exchangeData.length,

    exchangesConfigured: exchangeIds.length,

    failedExchanges,

    exchanges: exchangeData.map(exchange => ({
      name: exchange.exchange,
      marketsDiscovered: exchange.marketsDiscovered,
      markets: exchange.marketsReceived
    })),

    totalMarkets: exchangeData.reduce(
      (total, exchange) =>
        total + exchange.marketsReceived,
      0
    ),

    symbolsCompared: analysis.symbolsCompared,

    totalComparisons: analysis.comparisons,

    // Sinais preliminares, ainda sem validação
    marketSignals,

    totalMarketSignals: marketSignals.length,

    // Resultado dos testes com livros de ofertas
    validatedCandidates,

    totalValidated: validatedCandidates.length,

    validationLimit: MAX_VALIDATIONS,

    unvalidatedCandidates:
      Math.max(
        0,
        marketSignals.length -
        validatedCandidates.length
      ),

    // Apenas operações que passaram na validação
    opportunities,

    totalOpportunities: opportunities.length,

    minProfitPercent: minProfit,

    minProfitBRL: MIN_NET_BRL
  };
}

module.exports = {
  scanMarket,
  calculateOpportunities,
  calculateAllCandidates,
  fetchExchangePrices,
  fetchOrderBookSnapshot,
  evaluateCandidate,
  mapWithConcurrency,
  createExchange
};
