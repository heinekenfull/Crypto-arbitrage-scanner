
const config = require('./config');

// ==========================================
// CRYPTO ARBITRAGE SCANNER
// SIMULATION ENGINE
// ==========================================

const SIM = config.SIMULATION || {};

const MAX_SLIPPAGE_PERCENT =
  Number(SIM.MAX_SLIPPAGE_PERCENT ?? 1);

const MIN_FILL_RATIO =
  Number(SIM.MIN_BUDGET_FILL_RATIO ?? 0.98);

const MIN_NET_PROFIT_BRL =
  Number(SIM.MIN_NET_PROFIT_BRL ?? 0.10);


// ==========================================
// NORMALIZAR NÚMEROS
// ==========================================

function number(value, fallback = 0) {

  const result = Number(value);

  return Number.isFinite(result)
    ? result
    : fallback;

}


// ==========================================
// VALIDAR LIVRO DE OFERTAS
// ==========================================

function validateOrderBook(orderBook) {

  if (!orderBook) {
    return {
      valid: false,
      reason: 'Livro de ofertas ausente'
    };
  }

  const asks = Array.isArray(orderBook.asks)
    ? orderBook.asks
    : [];

  const bids = Array.isArray(orderBook.bids)
    ? orderBook.bids
    : [];

  if (!asks.length || !bids.length) {
    return {
      valid: false,
      reason: 'Livro sem ofertas suficientes'
    };
  }

  const validAsks = asks.every(level =>
    number(level[0]) > 0 &&
    number(level[1]) > 0
  );

  const validBids = bids.every(level =>
    number(level[0]) > 0 &&
    number(level[1]) > 0
  );

  if (!validAsks || !validBids) {
    return {
      valid: false,
      reason: 'Livro contém preços ou quantidades inválidos'
    };
  }

  const bestAsk = Math.min(
    ...asks.map(level => number(level[0]))
  );

  const bestBid = Math.max(
    ...bids.map(level => number(level[0]))
  );

  if (bestAsk <= 0 || bestBid <= 0) {
    return {
      valid: false,
      reason: 'Melhores preços inválidos'
    };
  }

  if (bestBid >= bestAsk) {
    return {
      valid: false,
      reason: 'Livro cruzado ou inconsistente'
    };
  }

  return {
    valid: true,
    asks,
    bids,
    bestAsk,
    bestBid
  };

}


// ==========================================
// CUSTO DE COMPRA PELO LIVRO
// ==========================================

function calculateBuyCost(orderBook, quantity) {

  const validation = validateOrderBook(orderBook);

  if (!validation.valid) {
    return {
      valid: false,
      reason: validation.reason,
      filled: 0,
      cost: 0,
      vwap: 0
    };
  }

  let remaining = number(quantity);
  let filled = 0;
  let cost = 0;

  for (const level of validation.asks) {

    if (remaining <= 0) break;

    const price = number(level[0]);
    const available = number(level[1]);

    const take = Math.min(
      remaining,
      available
    );

    filled += take;
    cost += take * price;
    remaining -= take;

  }

  return {

    valid: filled > 0,

    filled,

    unfilled: Math.max(0, remaining),

    cost,

    vwap: filled > 0
      ? cost / filled
      : 0,

    bestPrice: validation.bestAsk

  };

}


// ==========================================
// RECEITA DE VENDA PELO LIVRO
// ==========================================

function calculateSellRevenue(orderBook, quantity) {

  const validation = validateOrderBook(orderBook);

  if (!validation.valid) {
    return {
      valid: false,
      reason: validation.reason,
      filled: 0,
      revenue: 0,
      vwap: 0
    };
  }

  let remaining = number(quantity);
  let filled = 0;
  let revenue = 0;

  for (const level of validation.bids) {

    if (remaining <= 0) break;

    const price = number(level[0]);
    const available = number(level[1]);

    const take = Math.min(
      remaining,
      available
    );

    filled += take;
    revenue += take * price;
    remaining -= take;

  }

  return {

    valid: filled > 0,

    filled,

    unfilled: Math.max(0, remaining),

    revenue,

    vwap: filled > 0
      ? revenue / filled
      : 0,

    bestPrice: validation.bestBid

  };

}


// ==========================================
// CALCULAR QUANTIDADE COM ORÇAMENTO
// ==========================================

function calculateAffordableQuantity(
  asks,
  budget,
  feePercent
) {

  let remainingBudget = number(budget);
  let quantity = 0;

  const feeMultiplier =
    1 + (number(feePercent) / 100);

  for (const level of asks) {

    if (remainingBudget <= 0) break;

    const price = number(level[0]);
    const available = number(level[1]);

    if (price <= 0 || available <= 0) continue;

    const costPerUnit =
      price * feeMultiplier;

    const affordable =
      remainingBudget / costPerUnit;

    const take = Math.min(
      available,
      affordable
    );

    quantity += take;

    remainingBudget -=
      take * costPerUnit;

  }

  return quantity;

}


// ==========================================
// SIMULAR UMA OPERAÇÃO
// ==========================================

function simulateBudget(params = {}) {

  const {

    budgetQuote,

    buyOrderBook,

    sellOrderBook,

    buyFeePercent = 0.10,

    sellFeePercent = 0.10,

    quoteToBRL = 1,

    budgetUSD = null,

    budgetBRL = null

  } = params;

  const budget = number(budgetQuote);

  const conversion = number(quoteToBRL);

  if (budget <= 0) {
    return {
      valid: false,
      status: 'invalid',
      reason: 'Orçamento inválido'
    };
  }

  if (conversion <= 0) {
    return {
      valid: false,
      status: 'invalid',
      reason: 'Conversão para BRL indisponível'
    };
  }

  const buyValidation =
    validateOrderBook(buyOrderBook);

  const sellValidation =
    validateOrderBook(sellOrderBook);

  if (!buyValidation.valid) {
    return {
      valid: false,
      status: 'invalid',
      reason: buyValidation.reason
    };
  }

  if (!sellValidation.valid) {
    return {
      valid: false,
      status: 'invalid',
      reason: sellValidation.reason
    };
  }

  // Primeiro calcula o máximo que o orçamento compra.
  const affordableQuantity =
    calculateAffordableQuantity(
      buyValidation.asks,
      budget,
      buyFeePercent
    );

  // Depois limita pela liquidez disponível na venda.
  const sellDepth = sellValidation.bids.reduce(
    (total, level) => total + number(level[1]),
    0
  );

  const quantity = Math.min(
    affordableQuantity,
    sellDepth
  );

  if (quantity <= 0) {
    return {
      valid: false,
      status: 'rejected',
      reason: 'Liquidez insuficiente'
    };
  }

  const buy = calculateBuyCost(
    buyOrderBook,
    quantity
  );

  const sell = calculateSellRevenue(
    sellOrderBook,
    quantity
  );

  if (!buy.valid || !sell.valid) {
    return {
      valid: false,
      status: 'rejected',
      reason: 'Não foi possível preencher os livros'
    };
  }

  const actualQuantity = Math.min(
    buy.filled,
    sell.filled
  );

  if (actualQuantity <= 0) {
    return {
      valid: false,
      status: 'rejected',
      reason: 'Quantidade executável igual a zero'
    };
  }

  // Recalcula os dois lados para a mesma quantidade.
  const finalBuy = calculateBuyCost(
    buyOrderBook,
    actualQuantity
  );

  const finalSell = calculateSellRevenue(
    sellOrderBook,
    actualQuantity
  );

  const buyFee =
    finalBuy.cost * number(buyFeePercent) / 100;

  const sellFee =
    finalSell.revenue * number(sellFeePercent) / 100;

  const totalBuyCost =
    finalBuy.cost + buyFee;

  const totalSellRevenue =
    finalSell.revenue - sellFee;

  const netProfitQuote =
    totalSellRevenue - totalBuyCost;

  const netProfitBRL =
    netProfitQuote * conversion;

  const investedBRL =
    totalBuyCost * conversion;

  const profitPercent =
    investedBRL > 0
      ? (netProfitBRL / investedBRL) * 100
      : 0;

  const fillRatio = Math.min(
    1,
    totalBuyCost / budget
  );

  const buySlippage =
    finalBuy.bestPrice > 0
      ? (
          (finalBuy.vwap - finalBuy.bestPrice) /
          finalBuy.bestPrice
        ) * 100
      : 0;

  const sellSlippage =
    finalSell.bestPrice > 0
      ? (
          (finalSell.bestPrice - finalSell.vwap) /
          finalSell.bestPrice
        ) * 100
      : 0;

  const worstSlippage = Math.max(
    0,
    buySlippage,
    sellSlippage
  );

  const checks = {

    sufficientFill:
      fillRatio >= MIN_FILL_RATIO,

    acceptableSlippage:
      worstSlippage <= MAX_SLIPPAGE_PERCENT,

    positiveProfit:
      netProfitQuote > 0,

    minimumProfit:
      netProfitBRL >= MIN_NET_PROFIT_BRL,

    fullBuy:
      finalBuy.filled >= actualQuantity,

    fullSell:
      finalSell.filled >= actualQuantity

  };

  const validated =
    Object.values(checks).every(Boolean);

  return {

    valid: true,

    status: validated
      ? 'validated'
      : 'rejected',

    validated,

    reason: validated
      ? 'Simulação aprovada'
      : 'Operação não passou em todos os critérios',

    budgetQuote: budget,

    budgetUSD:
      budgetUSD === null
        ? null
        : number(budgetUSD),

    budgetBRL:
      budgetBRL === null
        ? budget * conversion
        : number(budgetBRL),

    quantity: actualQuantity,

    buyPrice: finalBuy.vwap,

    sellPrice: finalSell.vwap,

    bestBuyPrice: finalBuy.bestPrice,

    bestSellPrice: finalSell.bestPrice,

    buyCost: finalBuy.cost,

    sellRevenue: finalSell.revenue,

    buyFee,

    sellFee,

    totalBuyCost,

    totalSellRevenue,

    netProfitQuote,

    netProfitBRL,

    investedBRL,

    profitPercent,

    fillRatio,

    slippagePercent: worstSlippage,

    buySlippagePercent: buySlippage,

    sellSlippagePercent: sellSlippage,

    checks

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
