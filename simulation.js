
const config = require('./config');

// ==========================================
// CRYPTO ARBITRAGE SCANNER 6.3.2
// MOTOR DE SIMULAÇÃO FINANCEIRA
// SPOT — SEM ORDENS REAIS
// ==========================================

const SIM = config.SIMULATION || {};
const ARB = config.ARBITRAGE || {};

const MAX_SLIPPAGE_PERCENT = Math.max(
  0,
  Number(SIM.MAX_SLIPPAGE_PERCENT ?? 1)
);

const MIN_FILL_RATIO = Math.min(
  1,
  Math.max(0, Number(SIM.MIN_BUDGET_FILL_RATIO ?? 0.90))
);

const MAX_BOOK_AGE_MS = Math.max(
  1000,
  Number(SIM.ORDERBOOK_MAX_AGE_MS ?? 15000)
);

const MIN_NET_PROFIT_BRL = Math.max(
  0,
  Number(SIM.MIN_NET_PROFIT_BRL ?? 0.10)
);

// ==========================================
// NORMALIZAÇÃO
// ==========================================

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function feeRate(value) {
  const n = Math.max(0, number(value, 0));

  // Taxas recebidas em percentual: 0.10 = 0,10%.
  return n / 100;
}

function normalizeBudget(params = {}) {
  const currency = String(
    params.budgetCurrency ||
    params.currency ||
    'USD'
  ).toUpperCase();

  const legacyUSD = number(params.budgetUSD, 0);

  const amount = number(
    params.budgetAmount,
    legacyUSD
  );

  if (currency !== 'USD') {
    throw new Error('O orçamento de simulação deve ser informado em USD.');
  }

  if (amount <= 0) {
    throw new Error('Capital de simulação inválido.');
  }

  const usdToBRL = number(params.usdToBRL, 0);

  let budgetBRL = null;
  let budgetUSD = null;

  budgetUSD = amount;

  if (usdToBRL > 0) {
    budgetBRL = amount * usdToBRL;
  }

  return {
    currency,
    amount,
    budgetUSD,
    budgetBRL
  };
}

// ==========================================
// LIVRO DE OFERTAS
// ==========================================

function normalizeLevel(level) {
  if (Array.isArray(level)) {
    return {
      price: number(level[0]),
      amount: number(level[1])
    };
  }

  if (level && typeof level === 'object') {
    return {
      price: number(
        level.price ?? level.rate ?? level[0]
      ),
      amount: number(
        level.amount ?? level.quantity ?? level.size ?? level[1]
      )
    };
  }

  return { price: 0, amount: 0 };
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];

  return levels
    .map(normalizeLevel)
    .filter(level =>
      level.price > 0 &&
      level.amount > 0
    );
}

function validateOrderBook(orderBook, options = {}) {
  if (!orderBook || typeof orderBook !== 'object') {
    return {
      valid: false,
      reason: 'Livro de ofertas ausente.'
    };
  }

  const asks = normalizeLevels(orderBook.asks);
  const bids = normalizeLevels(orderBook.bids);

  if (!asks.length || !bids.length) {
    return {
      valid: false,
      reason: 'Livro sem ofertas suficientes.'
    };
  }

  asks.sort((a, b) => a.price - b.price);
  bids.sort((a, b) => b.price - a.price);

  const bestAsk = asks[0].price;
  const bestBid = bids[0].price;

  if (bestAsk <= 0 || bestBid <= 0) {
    return {
      valid: false,
      reason: 'Preço inválido no livro de ofertas.'
    };
  }

  if (bestBid >= bestAsk) {
    return {
      valid: false,
      reason: 'Livro inconsistente: bid igual ou superior ao ask.'
    };
  }

  const rawTimestamp = orderBook.timestamp ??
    orderBook.datetimeTimestamp ??
    orderBook.info?.timestamp ??
    (orderBook.datetime ? Date.parse(orderBook.datetime) : 0);

  const timestamp = number(rawTimestamp, 0);
  const normalizedTimestamp = timestamp > 0
    ? (timestamp < 1e12 ? timestamp * 1000 : timestamp)
    : 0;
  const receivedAt = number(orderBook._receivedAt, 0);
  const freshnessTimestamp = normalizedTimestamp || receivedAt;
  const now = Date.now();
  const maxAge = number(options.maxAgeMs, MAX_BOOK_AGE_MS);

  if (!freshnessTimestamp) {
    return {
      valid: false,
      reason: 'Livro sem horário verificável de captura.'
    };
  }

  const ageMs = now - freshnessTimestamp;
  if (ageMs < -2000 || ageMs > maxAge) {
    return {
      valid: false,
      reason: ageMs < -2000
        ? 'Horário do livro está no futuro ou inconsistente.'
        : 'Livro de ofertas desatualizado.'
    };
  }

  const spreadPercent =
    ((bestAsk - bestBid) / bestAsk) * 100;

  const maxSpread = number(
    options.maxSpreadPercent,
    number(ARB.MAX_SPREAD_PERCENT, 10)
  );

  if (spreadPercent > maxSpread) {
    return {
      valid: false,
      reason: 'Spread do livro acima do limite.'
    };
  }

  return {
    valid: true,
    reason: null,
    asks,
    bids,
    bestAsk,
    bestBid,
    spreadPercent,
    timestamp: normalizedTimestamp || null,
    receivedAt: receivedAt || null,
    ageMs,
    timestampSource: normalizedTimestamp ? 'exchange' : 'local_capture',
    asksDepthQuote: asks.reduce((sum, level) => sum + level.price * level.amount, 0),
    bidsDepthQuote: bids.reduce((sum, level) => sum + level.price * level.amount, 0),
    asksLevels: asks.length,
    bidsLevels: bids.length
  };
}

// ==========================================
// CONSUMO DE LIQUIDEZ
// ==========================================

function consumeLevels(levels, requestedQuantity) {
  let remaining = Math.max(0, number(requestedQuantity));
  let quantity = 0;
  let total = 0;

  for (const level of levels) {
    if (remaining <= 0) break;

    const available = Math.max(0, number(level.amount));
    const price = Math.max(0, number(level.price));

    if (!available || !price) continue;

    const used = Math.min(remaining, available);

    quantity += used;
    total += used * price;
    remaining -= used;
  }

  return {
    quantity,
    total,
    remaining,
    vwap: quantity > 0 ? total / quantity : 0
  };
}

function calculateBuyCost(orderBook, quantity, fee = 0) {
  const asks = normalizeLevels(orderBook?.asks)
    .sort((a, b) => a.price - b.price);

  const execution = consumeLevels(asks, quantity);
  const rate = fee > 1 ? feeRate(fee) : Math.max(0, fee);

  const feeAmount = execution.total * rate;

  return {
    quantity: execution.quantity,
    vwap: execution.vwap,
    grossCost: execution.total,
    fee: feeAmount,
    totalCost: execution.total + feeAmount,
    remaining: execution.remaining,
    complete: execution.remaining <= 1e-12
  };
}

function calculateSellRevenue(orderBook, quantity, fee = 0) {
  const bids = normalizeLevels(orderBook?.bids)
    .sort((a, b) => b.price - a.price);

  const execution = consumeLevels(bids, quantity);
  const rate = fee > 1 ? feeRate(fee) : Math.max(0, fee);

  const feeAmount = execution.total * rate;

  return {
    quantity: execution.quantity,
    vwap: execution.vwap,
    grossRevenue: execution.total,
    fee: feeAmount,
    netRevenue: execution.total - feeAmount,
    remaining: execution.remaining,
    complete: execution.remaining <= 1e-12
  };
}

function calculateAffordableQuantity(
  orderBook,
  budget,
  fee = 0
) {
  const asks = normalizeLevels(orderBook?.asks)
    .sort((a, b) => a.price - b.price);

  const availableBudget = Math.max(0, number(budget));
  const rate = fee > 1 ? feeRate(fee) : Math.max(0, fee);

  if (!availableBudget || !asks.length) return 0;

  let remainingBudget = availableBudget;
  let quantity = 0;

  for (const level of asks) {
    const unitCost = level.price * (1 + rate);

    if (unitCost <= 0) continue;

    const affordable = remainingBudget / unitCost;
    const used = Math.min(level.amount, affordable);

    quantity += used;
    remainingBudget -= used * unitCost;

    if (remainingBudget <= 1e-10) break;
  }

  return quantity;
}

// ==========================================
// SIMULAÇÃO COMPLETA
// ==========================================

function simulateBudget(params = {}) {
  const capital = normalizeBudget(params);

  const buyBook = params.buyOrderBook ||
    params.buyBook ||
    params.orderBookBuy;

  const sellBook = params.sellOrderBook ||
    params.sellBook ||
    params.orderBookSell;

  const buyValidation = validateOrderBook(buyBook);
  const sellValidation = validateOrderBook(sellBook);

  if (!buyValidation.valid) {
    return {
      validated: false,
      approved: false,
      status: 'rejected',
      reason: 'Compra: ' + buyValidation.reason
    };
  }

  if (!sellValidation.valid) {
    return {
      validated: false,
      approved: false,
      status: 'rejected',
      reason: 'Venda: ' + sellValidation.reason
    };
  }

  const budgetQuote = number(
    params.budgetQuote,
    capital.amount
  );

  if (budgetQuote <= 0) {
    return {
      validated: false,
      approved: false,
      status: 'rejected',
      reason: 'Não foi possível converter o capital para a moeda do mercado.'
    };
  }

  const buyFeePercent = number(
    params.buyFeePercent,
    number(params.feePercent, number(ARB.TRADING_FEE_PERCENT, 0.10))
  );

  const sellFeePercent = number(
    params.sellFeePercent,
    number(params.feePercent, number(ARB.TRADING_FEE_PERCENT, 0.10))
  );

  const buyRate = feeRate(buyFeePercent);
  const sellRate = feeRate(sellFeePercent);

  const requestedQuantity = calculateAffordableQuantity(
    buyBook,
    budgetQuote,
    buyRate
  );

  if (requestedQuantity <= 0) {
    return {
      validated: false,
      approved: false,
      status: 'rejected',
      reason: 'Capital insuficiente ou liquidez indisponível.'
    };
  }

  const buy = calculateBuyCost(
    buyBook,
    requestedQuantity,
    buyRate
  );

  if (buy.quantity <= 0 || buy.totalCost <= 0) {
    return {
      validated: false,
      approved: false,
      status: 'rejected',
      reason: 'Não foi possível executar a compra simulada.'
    };
  }

  const sell = calculateSellRevenue(
    sellBook,
    buy.quantity,
    sellRate
  );

  const executableQuantity = Math.min(
    buy.quantity,
    sell.quantity
  );

  if (executableQuantity <= 0) {
    return {
      validated: false,
      approved: false,
      status: 'rejected',
      reason: 'Liquidez insuficiente para a venda.'
    };
  }

  // Recalcula ambos os lados com a quantidade realmente executável.
  const finalBuy = calculateBuyCost(
    buyBook,
    executableQuantity,
    buyRate
  );

  const finalSell = calculateSellRevenue(
    sellBook,
    executableQuantity,
    sellRate
  );

  const investedAmount = finalBuy.totalCost;
  const netRevenue = finalSell.netRevenue;

  const netProfit = netRevenue - investedAmount;

  const profitPercent = investedAmount > 0
    ? (netProfit / investedAmount) * 100
    : 0;

  const fillRatio = Math.min(
    1,
    investedAmount / budgetQuote
  );

  const fillPercent = fillRatio * 100;

  const buySlippage = buyValidation.bestAsk > 0
    ? ((finalBuy.vwap - buyValidation.bestAsk) /
       buyValidation.bestAsk) * 100
    : 0;

  const sellSlippage = sellValidation.bestBid > 0
    ? ((sellValidation.bestBid - finalSell.vwap) /
       sellValidation.bestBid) * 100
    : 0;

  const totalSlippage = Math.max(0, buySlippage) +
    Math.max(0, sellSlippage);

  const maxSlippage = number(
    params.maxSlippagePercent,
    MAX_SLIPPAGE_PERCENT
  );

  const minFillRatio = number(
    params.minFillRatio,
    MIN_FILL_RATIO
  );

  const quoteToBRL = number(params.quoteToBRL, 0);
  const usdToBRL = number(params.usdToBRL, 0);

  let netProfitBRL = null;
  let netProfitUSD = null;

  if (quoteToBRL > 0) {
    netProfitBRL = netProfit * quoteToBRL;
  }

  if (netProfitBRL !== null && usdToBRL > 0) {
    netProfitUSD = netProfitBRL / usdToBRL;
  } else {
    netProfitUSD = netProfit;
  }

  const minimumProfitBRL = number(
    params.minNetProfitBRL,
    MIN_NET_PROFIT_BRL
  );

  const profitCheck = netProfit > 0 &&
    (
      netProfitBRL === null ||
      netProfitBRL >= minimumProfitBRL
    );

  const slippageCheck = totalSlippage <= maxSlippage;
  const fillCheck = fillRatio >= minFillRatio;

  const approved =
    profitCheck &&
    slippageCheck &&
    fillCheck;

  let reason = 'Simulação aprovada.';

  if (!profitCheck) {
    reason = 'Lucro líquido insuficiente após taxas.';
  } else if (!slippageCheck) {
    reason = 'Slippage acima do limite permitido.';
  } else if (!fillCheck) {
    reason = 'Liquidez insuficiente para preencher o capital mínimo.';
  }

  return {
    validated: approved,
    approved,
    status: approved ? 'validated' : 'rejected',
    reason,

    budgetCurrency: capital.currency,
    budgetAmount: capital.amount,
    budgetQuote,

    budgetUSD: capital.budgetUSD,
    budgetBRL: capital.budgetBRL,

    investedAmount,
    totalBuyCost: investedAmount,
    totalSellRevenue: finalSell.grossRevenue,
    netRevenue,

    filledQuantity: executableQuantity,
    quantity: executableQuantity,
    fillRatio,
    budgetFillRatio: fillRatio,

    buyPrice: finalBuy.vwap,
    sellPrice: finalSell.vwap,
    buyVWAP: finalBuy.vwap,
    sellVWAP: finalSell.vwap,

    buyFee: finalBuy.fee,
    sellFee: finalSell.fee,
    buyFeePercent,
    sellFeePercent,

    netProfit,
    profit: netProfit,
    profitPercent,
    netProfitPercent: profitPercent,

    netProfitUSD,
    netProfitBRL,

    buySlippagePercent: buySlippage,
    sellSlippagePercent: sellSlippage,
    slippagePercent: totalSlippage,

    bestBuyPrice: buyValidation.bestAsk,
    bestSellPrice: sellValidation.bestBid,

    buyBookTimestamp: buyValidation.timestamp,
    sellBookTimestamp: sellValidation.timestamp,

    orderBookValidation: {
      buy: {
        valid: true,
        ageMs: buyValidation.ageMs,
        timestampSource: buyValidation.timestampSource,
        asksLevels: buyValidation.asksLevels,
        bidsLevels: buyValidation.bidsLevels,
        asksDepthQuote: buyValidation.asksDepthQuote,
        bidsDepthQuote: buyValidation.bidsDepthQuote,
        bestAsk: buyValidation.bestAsk,
        bestBid: buyValidation.bestBid
      },
      sell: {
        valid: true,
        ageMs: sellValidation.ageMs,
        timestampSource: sellValidation.timestampSource,
        asksLevels: sellValidation.asksLevels,
        bidsLevels: sellValidation.bidsLevels,
        asksDepthQuote: sellValidation.asksDepthQuote,
        bidsDepthQuote: sellValidation.bidsDepthQuote,
        bestAsk: sellValidation.bestAsk,
        bestBid: sellValidation.bestBid
      },
      synchronized: true
    },

    checks: {
      profit: profitCheck,
      slippage: slippageCheck,
      liquidity: fillCheck,
      buyBookValid: true,
      sellBookValid: true
    },

    realOrderSent: false,
    simulatedAt: new Date().toISOString()
  };
}

// ==========================================
// EXPORTAÇÕES
// ==========================================

module.exports = {
  validateOrderBook,
  calculateBuyCost,
  calculateSellRevenue,
  calculateAffordableQuantity,
  simulateBudget
};
