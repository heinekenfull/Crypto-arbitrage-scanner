
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

const MAX_PRICE_AGE = 30000;

const SIM = config.SIMULATION || {};
const ARB = config.ARBITRAGE || {};

const TRADE_BUDGETS_USD = (
  Array.isArray(SIM.TRADE_BUDGETS_USD) &&
  SIM.TRADE_BUDGETS_USD.length
    ? SIM.TRADE_BUDGETS_USD
    : [50, 100, 150, 250, 500, 1000]
)
  .map(Number)
  .filter(value => Number.isFinite(value) && value > 0);

const DEFAULT_BUDGET_USD =
  TRADE_BUDGETS_USD.includes(
    Number(SIM.DEFAULT_TRADE_BUDGET_USD)
  )
    ? Number(SIM.DEFAULT_TRADE_BUDGET_USD)
    : TRADE_BUDGETS_USD[0];

const ORDERBOOK_MAX_AGE =
  Number(SIM.ORDERBOOK_MAX_AGE_MS) || 15000;

const MAX_VALIDATIONS =
  Number(SIM.MAX_CANDIDATES_TO_VALIDATE) || 100;

const VALIDATION_CONCURRENCY =
  Number(SIM.VALIDATION_CONCURRENCY) || 2;

const MAX_SLIPPAGE =
  Number(SIM.MAX_SLIPPAGE_PERCENT) || 1;

const MIN_FILL_RATIO =
  Number(SIM.MIN_BUDGET_FILL_RATIO) || 0.98;

const MIN_NET_BRL =
  Number(SIM.MIN_NET_PROFIT_BRL) || 0.10;

const MAX_SPREAD =
  Number(ARB.MAX_SPREAD_PERCENT) || 10;

const MIN_PROFIT_PERCENT =
  Number(ARB.MIN_PROFIT_PERCENT) || 0.30;

// ==========================================
// CONEXÃO COM CORRETORAS
// ==========================================

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
          error: error.message || String(error)
        };
      }
    }
  }

  const workerCount = Math.max(
    1,
    Math.min(
      Number(limit) || 1,
      items.length
    )
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker()
    )
  );

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

  const fallback =
    ARB.TRADING_FEE_PERCENT !== undefined &&
    Number.isFinite(Number(ARB.TRADING_FEE_PERCENT))
      ? Number(ARB.TRADING_FEE_PERCENT)
      : 0.10;

  return {
    percent: fallback,
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
    conversionMarkets.map(market => market.symbol)
  );

  const others = eligible.filter(
    market => !conversionSymbols.has(market.symbol)
  );

  const limit =
    Number(config.MAX_MARKETS_PER_EXCHANGE) || 500;

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
    throw new Error('Nenhum mercado Spot compatível');
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
      receivedAt - timestamp > MAX_PRICE_AGE ||
      timestamp - receivedAt > 5000
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
        timestampEstimated: price.timestampEstimated,

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
    (a, b) => b.netProfitPercent - a.netProfitPercent
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

  // Não enviamos um limite universal.
  // Cada corretora utiliza seu limite padrão.
  // Isso evita erros como o limite 50 na HTX.
  const book = await exchange.fetchOrderBook(symbol);

  const receivedAt = Date.now();

  if (
    book.timestamp &&
    (
      receivedAt - book.timestamp > ORDERBOOK_MAX_AGE ||
      book.timestamp - receivedAt > 5000
    )
  ) {
    throw new Error(
      'Livro de ofertas desatualizado ou com horário inválido'
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
// SIMULAÇÃO DE UM VALOR ESPECÍFICO
// ==========================================

function simulateBudget(
  candidate,
  buyBook,
  sellBook,
  quoteToBRL,
  budgetUSD,
  usdToBRL
) {
  const budgetBRL = budgetUSD * usdToBRL;
  const budgetQuote = budgetBRL / quoteToBRL;

  const buyFeeRate =
    candidate.buyFeePercent / 100;

  const sellFeeRate =
    candidate.sellFeePercent / 100;

  const affordableQuantity = calculateBuyQuantity(
    buyBook.asks,
    budgetQuote,
    buyFeeRate
  );

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
    return {
      budgetUSD,
      budgetBRL: Number(budgetBRL.toFixed(2)),
      status: 'rejected',
      rejectionReason: 'Liquidez insuficiente',
      mode: 'SIMULATION'
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

  if (!buy || !sell) {
    return {
      budgetUSD,
      budgetBRL: Number(budgetBRL.toFixed(2)),
      status: 'rejected',
      rejectionReason:
        'Não foi possível preencher a quantidade nos livros',
      mode: 'SIMULATION'
    };
  }

  const buyFee = buy.cost * buyFeeRate;
  const sellFee = sell.revenue * sellFeeRate;

  const totalBuyCost = buy.cost + buyFee;
  const netSaleRevenue = sell.revenue - sellFee;

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

  const bestAsk = buyBook.asks[0][0];
  const bestBid = sellBook.bids[0][0];

  const buySlippage =
    ((buy.vwap - bestAsk) / bestAsk) * 100;

  const sellSlippage =
    ((bestBid - sell.vwap) / bestBid) * 100;

  const crossSpread =
    ((bestBid - bestAsk) / bestAsk) * 100;

  const effectiveSpread =
    ((sell.vwap - buy.vwap) / buy.vwap) * 100;

  const fillRatio =
    budgetBRL > 0
      ? investedBRL / budgetBRL
      : 0;

  let rejectionReason = null;

  if (fillRatio < MIN_FILL_RATIO) {
    rejectionReason =
      `Liquidez insuficiente: preenchimento de ${(fillRatio * 100).toFixed(2)}%`;
  } else if (
    buySlippage > MAX_SLIPPAGE ||
    sellSlippage > MAX_SLIPPAGE
  ) {
    rejectionReason =
      'Slippage acima do limite configurado';
  } else if (netProfitBRL <= 0) {
    rejectionReason =
      'Resultado líquido negativo ou igual a zero';
  } else if (netProfitPercent < MIN_PROFIT_PERCENT) {
    rejectionReason =
      'Lucro percentual abaixo do mínimo configurado';
  } else if (netProfitBRL < MIN_NET_BRL) {
    rejectionReason =
      'Lucro líquido em reais abaixo do mínimo configurado';
  }

  const status = rejectionReason
    ? (
        netProfitBRL <= 0 ||
        netProfitPercent < MIN_PROFIT_PERCENT ||
        netProfitBRL < MIN_NET_BRL
          ? 'not_profitable'
          : 'rejected'
      )
    : 'validated';

  return {
    budgetUSD,
    budgetBRL: Number(budgetBRL.toFixed(2)),

    status,
    rejectionReason,

    quoteToBRL: Number(quoteToBRL.toFixed(8)),
    usdToBRL: Number(usdToBRL.toFixed(8)),

    quantity: Number(quantity.toFixed(10)),

    buyPrice: Number(buy.vwap.toFixed(10)),
    sellPrice: Number(sell.vwap.toFixed(10)),

    bestBuyPrice: bestAsk,
    bestSellPrice: bestBid,

    buyLevelsConsumed: buy.levelsUsed,
    sellLevelsConsumed: sell.levelsUsed,

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
      (buySlippage + sellSlippage).toFixed(4)
    ),

    buyFeePercent: candidate.buyFeePercent,
    sellFeePercent: candidate.sellFeePercent,

    buyFeeAmount: Number(buyFee.toFixed(10)),
    sellFeeAmount: Number(sellFee.toFixed(10)),

    investedBRL: Number(investedBRL.toFixed(4)),
    estimatedRevenueBRL: Number(revenueBRL.toFixed(4)),

    estimatedGrossProfitBRL: Number(
      ((sell.revenue - buy.cost) * quoteToBRL).toFixed(4)
    ),

    netProfitBRL: Number(netProfitBRL.toFixed(4)),
    netProfitPercent: Number(netProfitPercent.toFixed(4)),

    budgetFillPercent: Number(
      (fillRatio * 100).toFixed(2)
    ),

    mode: 'SIMULATION'
  };
}

// ==========================================
// VALIDAÇÃO COMPLETA DA CANDIDATA
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

  // USDT é usado como referência aproximada do dólar.
  // Não representa uma cotação cambial USD/BRL exata.
  const usdToBRL =
    findConversionRate('USDT', 'BRL', conversionGraph);

  if (
    !usdToBRL ||
    !Number.isFinite(usdToBRL)
  ) {
    throw new Error(
      'Não foi possível estimar USD para BRL usando USDT'
    );
  }

  // Cada livro é consultado uma única vez.
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

  // Os mesmos livros são reutilizados em todos os valores.
  const simulations = TRADE_BUDGETS_USD.map(budgetUSD => {
    return simulateBudget(
      candidate,
      buyBook,
      sellBook,
      quoteToBRL,
      budgetUSD,
      usdToBRL
    );
  });

  const defaultSimulation =
    simulations.find(
      item => item.budgetUSD === DEFAULT_BUDGET_USD
    ) || simulations[0];

  if (!defaultSimulation) {
    throw new Error(
      'Nenhuma faixa de simulação configurada'
    );
  }

  const approvedBudgets = simulations
    .filter(item => item.status === 'validated')
    .map(item => item.budgetUSD);

  return {
    ...candidate,

    // Resultado principal usa o capital padrão.
    ...defaultSimulation,

    status: defaultSimulation.status,
    rejectionReason: defaultSimulation.rejectionReason,

    defaultBudgetUSD: DEFAULT_BUDGET_USD,

    availableBudgetsUSD: TRADE_BUDGETS_USD,

    approvedBudgetsUSD: approvedBudgets,

    simulations,

    buyBookTimestamp: buyBook.timestamp,
    sellBookTimestamp: sellBook.timestamp,

    orderBookTimestampEstimated:
      buyBook.timestampEstimated ||
      sellBook.timestampEstimated,

    orderBooksFetchedOnce: true,

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
      item.netProfitPercent >= MIN_PROFIT_PERCENT
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
    config.EXCHANGE_SCAN_CONCURRENCY || 2,
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

  // Primeiro filtramos sinais com lucro preliminar positivo.
  const preliminaryCandidates =
    analysis.candidates.filter(
      item => item.netProfitPercent > 0
    );

  // Depois validamos até 100 candidatas.
  const toValidate = preliminaryCandidates.slice(
    0,
    MAX_VALIDATIONS
  );

  const validationResults = await mapWithConcurrency(
    toValidate,
    VALIDATION_CONCURRENCY,
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

        status: 'validation_error',

        rejectionReason:
          result?.error || 'Falha técnica na validação',

        mode: 'SIMULATION'
      };
    }
  );

  // Uma candidata aparece como oportunidade se pelo menos
  // um dos seis tamanhos de operação passar na validação.
  const opportunities = validatedCandidates
    .filter(candidate => {
      return (
        Array.isArray(candidate.simulations) &&
        candidate.simulations.some(simulation => {
          return (
            simulation.status === 'validated' &&
            simulation.netProfitPercent >= MIN_PROFIT_PERCENT &&
            simulation.netProfitBRL >= MIN_NET_BRL
          );
        })
      );
    })
    .map(candidate => ({
      ...candidate,

      profitableBudgetsUSD:
        candidate.simulations
          .filter(simulation => {
            return simulation.status === 'validated';
          })
          .map(simulation => simulation.budgetUSD)
    }));

  const marketSignals =
    preliminaryCandidates.slice(0, 100);

  const validationErrors =
    validatedCandidates.filter(
      item => item.status === 'validation_error'
    ).length;

  const rejectedCandidates =
    validatedCandidates.filter(
      item => item.status === 'rejected'
    ).length;

  const notProfitableCandidates =
    validatedCandidates.filter(
      item => item.status === 'not_profitable'
    ).length;

  const validatedCount =
    validatedCandidates.filter(
      item => item.status === 'validated'
    ).length;

  return {
    timestamp: Date.now(),

    mode: 'SIMULATION',

    simulationCurrency: 'USD',

    defaultBudgetUSD: DEFAULT_BUDGET_USD,

    availableBudgetsUSD: TRADE_BUDGETS_USD,

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

    totalPreliminaryCandidates:
      preliminaryCandidates.length,

    marketSignals,

    totalMarketSignals:
      preliminaryCandidates.length,

    validatedCandidates,

    totalValidated:
      validatedCandidates.length,

    validationLimit: MAX_VALIDATIONS,

    validationConcurrency:
      VALIDATION_CONCURRENCY,

    validationErrors,

    rejectedCandidates,

    notProfitableCandidates,

    validatedCount,

    unvalidatedCandidates: Math.max(
      0,
      preliminaryCandidates.length -
      validatedCandidates.length
    ),

    opportunities,

    totalOpportunities: opportunities.length,

    minProfitPercent: MIN_PROFIT_PERCENT,

    minProfitBRL: MIN_NET_BRL,

    simulationInfo: {
      budgetsUSD: TRADE_BUDGETS_USD,
      defaultBudgetUSD: DEFAULT_BUDGET_USD,
      orderBooksPerCandidate: 2,
      booksReusedAcrossBudgets: true,
      liveTrading: false
    }
  };
}

// ==========================================
// EXPORTAÇÕES
// ==========================================

module.exports = {
  scanMarket,
  calculateOpportunities,
  calculateAllCandidates,
  fetchExchangePrices,
  fetchOrderBookSnapshot,
  evaluateCandidate,
  simulateBudget,
  buildConversionGraph,
  findConversionRate,
  mapWithConcurrency,
  createExchange
};
