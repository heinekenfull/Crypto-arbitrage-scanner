
const config = require('./config');

// ==========================================
// CRYPTO ARBITRAGE SCANNER 6.2.2
// MOTOR DE SIMULAÇÃO FINANCEIRA
// SPOT - SEM ORDENS REAIS
// ORÇAMENTO USD + BRL
// ==========================================

const SIM = config.SIMULATION || {};

const MAX_SLIPPAGE_PERCENT = Math.max(
  0,
  Number(SIM.MAX_SLIPPAGE_PERCENT ?? 1)
);

const MIN_FILL_RATIO = Math.min(
  1,
  Math.max(0, Number(SIM.MIN_BUDGET_FILL_RATIO ?? 0.90))
);

const MIN_NET_PROFIT_BRL = Number(
  SIM.MIN_NET_PROFIT_BRL ?? 0.10
);


// ==========================================
// CONVERSÃO NUMÉRICA
// ==========================================

function number(value, fallback = 0) {
  const result = Number(value);

  return Number.isFinite(result)
    ? result
    : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const result = Number(value);

  return Number.isFinite(result) ? result : null;
}

function feeRate(percent) {
  const value = number(percent, 0);

  if (value < 0 || value >= 100) {
    throw new Error('Taxa de corretagem inválida.');
  }

  return value / 100;
}


// ==========================================
// NORMALIZAÇÃO DO LIVRO
// ==========================================

function normalizeLevels(levels, descending = false) {
  if (!Array.isArray(levels)) return [];

  return levels
    .filter(level =>
      Array.isArray(level) &&
      Number.isFinite(Number(level[0])) &&
      Number.isFinite(Number(level[1])) &&
      Number(level[0]) > 0 &&
      Number(level[1]) > 0
    )
    .map(level => [
      Number(level[0]),
      Number(level[1])
    ])
    .sort((a, b) =>
      descending
        ? b[0] - a[0]
        : a[0] - b[0]
    );
}


// ==========================================
// VALIDAR LIVRO DE OFERTAS
// ==========================================

function validateOrderBook(book) {
  if (!book || typeof book !== 'object') {
    return {
      valid: false,
      reason: 'Livro de ofertas inexistente.'
    };
  }

  const asks = normalizeLevels(book.asks, false);
  const bids = normalizeLevels(book.bids, true);

  if (asks.length === 0) {
    return {
      valid: false,
      reason: 'Livro de compras sem ofertas de venda.'
    };
  }

  if (bids.length === 0) {
    return {
      valid: false,
      reason: 'Livro de vendas sem ofertas de compra.'
    };
  }

  const bestAsk = asks[0][0];
  const bestBid = bids[0][0];

  if (bestBid >= bestAsk) {
    return {
      valid: false,
      reason:
        'Livro inconsistente: melhor compra maior ou igual à melhor venda.'
    };
  }

  return {
    valid: true,
    bestAsk,
    bestBid,
    spreadPercent:
      ((bestAsk - bestBid) / bestAsk) * 100,
    asks,
    bids
  };
}


// ==========================================
// CUSTO DE COMPRA POR QUANTIDADE
// ==========================================

function calculateBuyCost(asks, targetQuantity) {
  const levels = normalizeLevels(asks, false);
  const quantity = number(targetQuantity);

  if (quantity <= 0 || levels.length === 0) {
    return {
      filled: 0,
      remaining: Math.max(0, quantity),
      cost: 0,
      quantity: 0,
      vwap: 0,
      complete: false
    };
  }

  let remaining = quantity;
  let filled = 0;
  let cost = 0;

  for (const [price, available] of levels) {
    if (remaining <= 0) break;

    const take = Math.min(remaining, available);

    filled += take;
    cost += take * price;
    remaining -= take;
  }

  return {
    filled,
    remaining,
    cost,
    quantity: filled,
    vwap: filled > 0 ? cost / filled : 0,
    complete: remaining <= 1e-12
  };
}


// ==========================================
// RECEITA DE VENDA POR QUANTIDADE
// ==========================================

function calculateSellRevenue(bids, targetQuantity) {
  const levels = normalizeLevels(bids, true);
  const quantity = number(targetQuantity);

  if (quantity <= 0 || levels.length === 0) {
    return {
      filled: 0,
      remaining: Math.max(0, quantity),
      revenue: 0,
      quantity: 0,
      vwap: 0,
      complete: false
    };
  }

  let remaining = quantity;
  let filled = 0;
  let revenue = 0;

  for (const [price, available] of levels) {
    if (remaining <= 0) break;

    const take = Math.min(remaining, available);

    filled += take;
    revenue += take * price;
    remaining -= take;
  }

  return {
    filled,
    remaining,
    revenue,
    quantity: filled,
    vwap: filled > 0 ? revenue / filled : 0,
    complete: remaining <= 1e-12
  };
}


// ==========================================
// CALCULAR QUANTIDADE MÁXIMA COM ORÇAMENTO
// ==========================================

function calculateAffordableQuantity(
  asks,
  budget,
  buyFeePercent = 0
) {
  const levels = normalizeLevels(asks, false);
  const availableBudget = number(budget);

  if (availableBudget <= 0 || levels.length === 0) {
    return 0;
  }

  const fee = feeRate(buyFeePercent);

  let remainingBudget = availableBudget;
  let quantity = 0;

  for (const [price, available] of levels) {
    if (remainingBudget <= 0) break;

    const costPerUnit = price * (1 + fee);
    const affordable = remainingBudget / costPerUnit;

    const take = Math.min(available, affordable);

    if (take <= 0) continue;

    quantity += take;
    remainingBudget -= take * costPerUnit;
  }

  return quantity;
}


// ==========================================
// LIQUIDEZ DISPONÍVEL
// ==========================================

function getAvailableQuantity(levels) {
  return normalizeLevels(levels).reduce(
    (total, level) => total + level[1],
    0
  );
}


// ==========================================
// NORMALIZAR CAPITAL USD / BRL
// ==========================================

function normalizeBudget(params = {}) {
  const currency = String(
    params.budgetCurrency || 'USD'
  ).toUpperCase();

  if (!['USD', 'BRL'].includes(currency)) {
    throw new Error('Moeda de orçamento inválida. Use USD ou BRL.');
  }

  const legacyUSD = optionalNumber(params.budgetUSD);

  const amount = optionalNumber(params.budgetAmount) ??
    (currency === 'USD' ? legacyUSD : null);

  if (amount === null || amount <= 0) {
    throw new Error('Valor do orçamento inválido.');
  }

  const usdToBRL = optionalNumber(params.usdToBRL);

  let budgetUSD = null;
  let budgetBRL = null;

  if (currency === 'USD') {
    budgetUSD = amount;

    if (usdToBRL !== null && usdToBRL > 0) {
      budgetBRL = amount * usdToBRL;
    }
  } else {
    budgetBRL = amount;

    if (usdToBRL !== null && usdToBRL > 0) {
      budgetUSD = amount / usdToBRL;
    }
  }

  return {
    budgetCurrency: currency,
    budgetAmount: amount,
    budgetUSD,
    budgetBRL,
    usdToBRL
  };
}


// ==========================================
// SIMULAR OPERAÇÃO
// ==========================================

function simulateBudget(params = {}) {
  const {
    budgetQuote,
    budgetUSD,

    buyOrderBook,
    sellOrderBook,

    buyFeePercent = 0,
    sellFeePercent = 0,

    quoteToBRL,

    buyMarketLimits,
    sellMarketLimits
  } = params;

  let capital;

  try {
    capital = normalizeBudget({
      ...params,
      budgetUSD
    });
  } catch (error) {
    return rejectedResult(error.message, params);
  }

  const budget = number(budgetQuote);
  const conversion = number(quoteToBRL);

  const buyFee = feeRate(buyFeePercent);
  const sellFee = feeRate(sellFeePercent);

  // ========================================
  // VALIDAÇÕES INICIAIS
  // ========================================

  if (budget <= 0) {
    return rejectedResult(
      'Orçamento convertido para a moeda do par inválido.',
      params
    );
  }

  if (conversion <= 0) {
    return rejectedResult(
      'Cotação de conversão para BRL inválida.',
      params
    );
  }

  const buyValidation = validateOrderBook(buyOrderBook);

  if (!buyValidation.valid) {
    return rejectedResult(
      `Livro de compra inválido: ${buyValidation.reason}`,
      params
    );
  }

  const sellValidation = validateOrderBook(sellOrderBook);

  if (!sellValidation.valid) {
    return rejectedResult(
      `Livro de venda inválido: ${sellValidation.reason}`,
      params
    );
  }

  const asks = buyValidation.asks;
  const bids = sellValidation.bids;

  const bestAsk = asks[0][0];
  const bestBid = bids[0][0];

  // ========================================
  // CALCULAR QUANTIDADE DISPONÍVEL
  // ========================================

  const affordableQuantity = calculateAffordableQuantity(
    asks,
    budget,
    buyFeePercent
  );

  const sellAvailableQuantity = getAvailableQuantity(bids);

  const targetQuantity = Math.min(
    affordableQuantity,
    sellAvailableQuantity
  );

  if (
    !Number.isFinite(targetQuantity) ||
    targetQuantity <= 0
  ) {
    return rejectedResult(
      'Liquidez insuficiente para executar a simulação.',
      params
    );
  }

  // ========================================
  // VALIDAR LIMITES MÍNIMOS
  // ========================================

  const minBuyAmount = number(
    buyMarketLimits?.amount?.min
  );

  const minSellAmount = number(
    sellMarketLimits?.amount?.min
  );

  const minBuyCost = number(
    buyMarketLimits?.cost?.min
  );

  const minSellCost = number(
    sellMarketLimits?.cost?.min
  );

  if (
    minBuyAmount > 0 &&
    targetQuantity < minBuyAmount
  ) {
    return rejectedResult(
      'Quantidade abaixo do mínimo de compra da corretora.',
      params
    );
  }

  if (
    minSellAmount > 0 &&
    targetQuantity < minSellAmount
  ) {
    return rejectedResult(
      'Quantidade abaixo do mínimo de venda da corretora.',
      params
    );
  }

  // ========================================
  // EXECUÇÃO SIMULADA DA COMPRA
  // ========================================

  const buy = calculateBuyCost(asks, targetQuantity);

  if (!buy.complete || buy.filled <= 0) {
    return rejectedResult(
      'Não foi possível preencher toda a compra.',
      params
    );
  }

  const buyFeeAmount = buy.cost * buyFee;
  const totalBuyCost = buy.cost + buyFeeAmount;

  // ========================================
  // EXECUÇÃO SIMULADA DA VENDA
  // ========================================

  const sell = calculateSellRevenue(bids, buy.filled);

  if (!sell.complete || sell.filled <= 0) {
    return rejectedResult(
      'Não foi possível vender toda a quantidade comprada.',
      params
    );
  }

  const sellFeeAmount = sell.revenue * sellFee;
  const netSellRevenue = sell.revenue - sellFeeAmount;

  // ========================================
  // RESULTADO FINANCEIRO NA MOEDA DO PAR
  // ========================================

  const netProfit = netSellRevenue - totalBuyCost;

  const profitPercent = totalBuyCost > 0
    ? (netProfit / totalBuyCost) * 100
    : 0;

  const netProfitBRL = netProfit * conversion;
  const totalBuyCostBRL = totalBuyCost * conversion;
  const netSellRevenueBRL = netSellRevenue * conversion;

  // ========================================
  // EQUIVALÊNCIA EM USD
  // ========================================

  const quoteToUSD = capital.usdToBRL !== null &&
    capital.usdToBRL > 0
      ? conversion / capital.usdToBRL
      : null;

  const netProfitUSD = quoteToUSD !== null
    ? netProfit * quoteToUSD
    : null;

  const totalBuyCostUSD = quoteToUSD !== null
    ? totalBuyCost * quoteToUSD
    : null;

  const netSellRevenueUSD = quoteToUSD !== null
    ? netSellRevenue * quoteToUSD
    : null;

  // ========================================
  // SLIPPAGE
  // ========================================

  const buySlippagePercent = bestAsk > 0
    ? ((buy.vwap - bestAsk) / bestAsk) * 100
    : Infinity;

  const sellSlippagePercent = bestBid > 0
    ? ((bestBid - sell.vwap) / bestBid) * 100
    : Infinity;

  const maximumObservedSlippage = Math.max(
    buySlippagePercent,
    sellSlippagePercent
  );

  // ========================================
  // PREENCHIMENTO DO ORÇAMENTO
  // ========================================

  const fillRatio = Math.min(
    1,
    totalBuyCost / budget
  );

  const remainingBudget = Math.max(
    0,
    budget - totalBuyCost
  );

  // ========================================
  // LIMITES MÍNIMOS DE CUSTO
  // ========================================

  const minimumBuyCostValid =
    minBuyCost <= 0 || buy.cost >= minBuyCost;

  const minimumSellCostValid =
    minSellCost <= 0 || sell.revenue >= minSellCost;

  // ========================================
  // CRITÉRIOS DE APROVAÇÃO
  // ========================================

  const sufficientFill = fillRatio >= MIN_FILL_RATIO;

  const acceptableSlippage =
    maximumObservedSlippage <= MAX_SLIPPAGE_PERCENT;

  const positiveProfit = netProfit > 0;

  const minimumProfit = netProfitBRL >= MIN_NET_PROFIT_BRL;

  const fullBuy = buy.complete;
  const fullSell = sell.complete;

  const minimumOrderLimitsValid =
    minimumBuyCostValid && minimumSellCostValid;

  const checks = {
    sufficientFill,
    acceptableSlippage,
    positiveProfit,
    minimumProfit,
    fullBuy,
    fullSell,
    minimumOrderLimitsValid
  };

  const validated = Object.values(checks).every(
    value => value === true
  );

  // ========================================
  // RESULTADO FINAL
  // ========================================

  return {
    validated,

    status: validated ? 'validated' : 'rejected',

    reason: validated ? null : getFailureReason(checks),

    // Capital selecionado
    budgetCurrency: capital.budgetCurrency,
    budgetAmount: capital.budgetAmount,

    // Equivalências do capital
    budgetUSD: capital.budgetUSD,
    budgetBRL: capital.budgetBRL,
    budgetUSDEquivalent: capital.budgetUSD,
    budgetBRLEquivalent: capital.budgetBRL,

    // Capital convertido para a moeda do par
    budgetQuote: budget,

    usedBudget: totalBuyCost,
    remainingBudget,

    fillRatio,

    quantity: buy.filled,
    buyQuantity: buy.filled,
    sellQuantity: sell.filled,

    buyPrice: buy.vwap,
    sellPrice: sell.vwap,

    bestAsk,
    bestBid,

    buyVWAP: buy.vwap,
    sellVWAP: sell.vwap,

    buyCost: buy.cost,
    buyFeeAmount,
    totalBuyCost,

    sellRevenue: sell.revenue,
    sellFeeAmount,
    netSellRevenue,

    buyFeePercent: number(buyFeePercent),
    sellFeePercent: number(sellFeePercent),

    grossProfit: sell.revenue - buy.cost,

    netProfit,
    netProfitBRL,
    netProfitUSD,

    totalBuyCostBRL,
    netSellRevenueBRL,

    totalBuyCostUSD,
    netSellRevenueUSD,

    profitPercent,

    buySlippagePercent,
    sellSlippagePercent,

    slippagePercent: maximumObservedSlippage,

    maximumAllowedSlippage: MAX_SLIPPAGE_PERCENT,

    buyAvailableQuantity: getAvailableQuantity(asks),
    sellAvailableQuantity,

    minimumFillRatio: MIN_FILL_RATIO,
    minimumNetProfitBRL: MIN_NET_PROFIT_BRL,

    quoteToBRL: conversion,
    quoteToUSD,

    usdToBRL: capital.usdToBRL,

    checks
  };
}


// ==========================================
// MOTIVO DA REJEIÇÃO
// ==========================================

function getFailureReason(checks) {
  const reasons = [];

  if (!checks.sufficientFill) {
    reasons.push('Preenchimento insuficiente do orçamento');
  }

  if (!checks.acceptableSlippage) {
    reasons.push('Slippage acima do limite permitido');
  }

  if (!checks.positiveProfit) {
    reasons.push('Lucro líquido não positivo');
  }

  if (!checks.minimumProfit) {
    reasons.push('Lucro líquido abaixo do mínimo em BRL');
  }

  if (!checks.fullBuy) {
    reasons.push('Compra incompleta');
  }

  if (!checks.fullSell) {
    reasons.push('Venda incompleta');
  }

  if (!checks.minimumOrderLimitsValid) {
    reasons.push('Valor abaixo do mínimo de ordem');
  }

  return reasons.join('; ');
}


// ==========================================
// RESULTADO REJEITADO
// ==========================================

function rejectedResult(reason, params = {}) {
  const currency = ['USD', 'BRL'].includes(
    String(params.budgetCurrency || 'USD').toUpperCase()
  )
    ? String(params.budgetCurrency || 'USD').toUpperCase()
    : 'USD';

  const amount = optionalNumber(params.budgetAmount) ??
    optionalNumber(params.budgetUSD);

  const usdToBRL = optionalNumber(params.usdToBRL);

  let budgetUSD = null;
  let budgetBRL = null;

  if (amount !== null && amount > 0) {
    if (currency === 'USD') {
      budgetUSD = amount;
      budgetBRL = usdToBRL !== null
        ? amount * usdToBRL
        : null;
    } else {
      budgetBRL = amount;
      budgetUSD = usdToBRL !== null && usdToBRL > 0
        ? amount / usdToBRL
        : null;
    }
  }

  return {
    validated: false,
    status: 'rejected',
    reason,

    budgetCurrency: currency,
    budgetAmount: amount,

    budgetUSD,
    budgetBRL,
    budgetUSDEquivalent: budgetUSD,
    budgetBRLEquivalent: budgetBRL,

    budgetQuote: number(params.budgetQuote),

    quantity: 0,
    buyQuantity: 0,
    sellQuantity: 0,

    buyCost: 0,
    totalBuyCost: 0,

    sellRevenue: 0,
    netSellRevenue: 0,

    netProfit: 0,
    netProfitBRL: 0,
    netProfitUSD: null,

    profitPercent: 0,
    fillRatio: 0,

    slippagePercent: null,

    checks: {
      sufficientFill: false,
      acceptableSlippage: false,
      positiveProfit: false,
      minimumProfit: false,
      fullBuy: false,
      fullSell: false,
      minimumOrderLimitsValid: false
    }
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
