
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');

const {
  scanMarket,
  fetchExchangePrices,
  mapWithConcurrency,
  buildConversionGraph,
  evaluateCandidate
} = require('./scanner');

const {
  createExchange,
  closeExchange,
  getSupportedExchanges,
  getEnabledExchanges
} = require('./exchanges');

// ==========================================
// CRYPTO ARBITRAGE SCANNER 6.0.0 MOBILE TEST
// SPOT — SIMULAÇÃO USD / BRL
// SEM ENVIO DE ORDENS REAIS
// ==========================================

const app = express();

const PORT = Number(process.env.PORT || config.PORT || 3000);

const VERSION = '6.0.0';

const ALLOWED_CURRENCIES = ['USD'];

const ALLOWED_BUDGETS = [50, 100, 150, 250, 500];

const SIM = config.SIMULATION || {};

const BUDGETS = {
  USD: normalizeBudgets(SIM.TRADE_BUDGETS_USD)
};

const HISTORY_LIMIT = 100;

let scannerRunning = false;
let simulationRunning = false;
let scheduledScan = null;

let lastScanResult = null;
let lastScanAt = null;

const simulationHistory = [];

// ==========================================
// CONFIGURAÇÃO EXPRESS
// ==========================================

app.use(cors());

app.use(express.json({ limit: '1mb' }));

app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// UTILITÁRIOS
// ==========================================

function number(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function normalizeBudgets(values) {
  const source = Array.isArray(values)
    ? values
    : ALLOWED_BUDGETS;

  return [...new Set(
    source
      .map(Number)
      .filter(value => ALLOWED_BUDGETS.includes(value))
  )].sort((a, b) => a - b);
}

function normalizeExchangeId(item) {
  if (typeof item === 'string') {
    return item;
  }

  return item?.id ||
    item?.exchangeId ||
    item?.name ||
    null;
}

function getEnabledExchangeIds() {
  return (getEnabledExchanges() || [])
    .map(normalizeExchangeId)
    .filter(Boolean);
}

function findOpportunity(symbol, buyExchangeId, sellExchangeId) {
  const opportunities = lastScanResult?.opportunities || [];

  return opportunities.find(item =>
    item.symbol === symbol &&
    item.buyExchangeId === buyExchangeId &&
    item.sellExchangeId === sellExchangeId
  );
}

function getFreshPrice(collections, exchangeId, symbol) {
  for (const collection of collections || []) {
    if (collection.exchangeId !== exchangeId) continue;

    const item = (collection.prices || []).find(
      price => price.symbol === symbol
    );

    if (item) return item;
  }

  return null;
}

function saveSimulation(record) {
  simulationHistory.unshift(record);

  if (simulationHistory.length > HISTORY_LIMIT) {
    simulationHistory.length = HISTORY_LIMIT;
  }

  return record;
}

function sendError(res, status, message, details = null) {
  return res.status(status).json({
    success: false,
    error: message,
    details
  });
}

async function closeExchangeInstances(instances) {
  const exchanges = [...instances.values()];

  await mapWithConcurrency(
    exchanges,
    3,
    async exchange => {
      try {
        await closeExchange(exchange);
      } catch (error) {
        // O fechamento não deve ocultar o resultado da simulação.
      }
    }
  );

  instances.clear();
}

// ==========================================
// ESTADO DO SERVIDOR
// ==========================================

function getServerStatus() {
  return {
    success: true,
    status: 'ok',
    servidor: 'Crypto Arbitrage Scanner',
    version: VERSION,
    market: 'spot',
    modes: { spot: true, dex: false, futures: false },

    scannerRunning,
    simulationRunning,

    operacoesReais: false,
    simulationOnly: true,

    lastScanAt,

    currencies: ALLOWED_CURRENCIES,

    budgets: {
      USD: BUDGETS.USD,
    }
  };
}

// ==========================================
// EXECUÇÃO DO SCANNER
// ==========================================

async function executeScan() {
  if (scannerRunning || simulationRunning) {
    return {
      success: false,
      busy: true,
      message: 'Já existe uma operação de consulta em andamento.'
    };
  }

  scannerRunning = true;

  try {
    const result = await scanMarket();

    lastScanResult = result;
    lastScanAt = new Date().toISOString();

    return result;
  } catch (error) {
    console.error('[SCANNER]', error);

    return {
      success: false,
      error: error.message || 'Falha ao executar scanner.',
      timestamp: Date.now()
    };
  } finally {
    scannerRunning = false;
  }
}

// ==========================================
// AGENDAMENTO AUTOMÁTICO
// ==========================================

function stopScheduledScan() {
  if (scheduledScan) {
    clearInterval(scheduledScan);
    scheduledScan = null;
  }
}

function startScheduledScan() {
  stopScheduledScan();

  const interval = Math.max(
    3000,
    number(config.SCAN_INTERVAL, 5000)
  );

  scheduledScan = setInterval(async () => {
    if (scannerRunning || simulationRunning) return;

    await executeScan();
  }, interval);

  return interval;
}

// ==========================================
// SIMULAÇÃO MANUAL
// ==========================================

async function handleSimulation(req, res) {
  if (scannerRunning || simulationRunning) {
    return sendError(
      res,
      409,
      'Scanner ocupado. Aguarde a consulta atual terminar.'
    );
  }

  const body = req.body || {};

  const symbol = String(body.symbol || '').trim();

  const buyExchangeId = String(
    body.buyExchangeId ||
    body.buyExchange ||
    ''
  ).trim().toLowerCase();

  const sellExchangeId = String(
    body.sellExchangeId ||
    body.sellExchange ||
    ''
  ).trim().toLowerCase();

  const budgetCurrency = String(
    body.budgetCurrency ||
    body.currency ||
    'USD'
  ).trim().toUpperCase();

  const budgetAmount = number(
    body.budgetAmount ??
    body.budget ??
    body.budgetUSD,
    NaN
  );

  if (!symbol || !buyExchangeId || !sellExchangeId) {
    return sendError(
      res,
      400,
      'Informe moeda, corretora de compra e corretora de venda.'
    );
  }

  if (buyExchangeId === sellExchangeId) {
    return sendError(
      res,
      400,
      'Compra e venda precisam ocorrer em corretoras diferentes.'
    );
  }

  if (!ALLOWED_CURRENCIES.includes(budgetCurrency)) {
    return sendError(
      res,
      400,
      'Moeda de orçamento inválida. Use somente USD.'
    );
  }

  if (!BUDGETS[budgetCurrency].includes(budgetAmount)) {
    return sendError(
      res,
      400,
      'Valor de orçamento inválido.',
      {
        currency: budgetCurrency,
        allowedValues: BUDGETS[budgetCurrency]
      }
    );
  }

  const enabledIds = getEnabledExchangeIds();

  if (
    !enabledIds.includes(buyExchangeId) ||
    !enabledIds.includes(sellExchangeId)
  ) {
    return sendError(
      res,
      400,
      'Uma ou ambas as corretoras não estão habilitadas.'
    );
  }

  // Uma simulação só precisa consultar as duas corretoras
  // escolhidas. Evita abrir todas as conexões a cada clique.
  const selectedIds = [...new Set([
    buyExchangeId,
    sellExchangeId
  ])];

  simulationRunning = true;

  const exchangeInstances = new Map();

  try {
    const creationResults = await mapWithConcurrency(
      selectedIds,
      2,
      async exchangeId => {
        const exchange = await createExchange(exchangeId);

        if (!exchange) {
          throw new Error(
            'Não foi possível conectar à ' + exchangeId
          );
        }

        exchangeInstances.set(exchangeId, exchange);

        return exchangeId;
      }
    );

    const connectedIds = creationResults.filter(
      item => typeof item === 'string'
    );

    if (
      !connectedIds.includes(buyExchangeId) ||
      !connectedIds.includes(sellExchangeId)
    ) {
      throw new Error(
        'Não foi possível conectar às duas corretoras selecionadas.'
      );
    }

    const priceResults = await mapWithConcurrency(
      connectedIds,
      2,
      async exchangeId => {
        const exchange = exchangeInstances.get(exchangeId);

        return fetchExchangePrices(exchangeId, exchange);
      }
    );

    const priceCollections = priceResults.filter(
      item => item && !item.error
    );

    const buyPrice = getFreshPrice(
      priceCollections,
      buyExchangeId,
      symbol
    );

    const sellPrice = getFreshPrice(
      priceCollections,
      sellExchangeId,
      symbol
    );

    if (!buyPrice || !sellPrice) {
      throw new Error(
        'Não foi possível obter cotações atuais para ' + symbol +
        ' nas duas corretoras.'
      );
    }

    if (buyPrice.ask <= 0 || sellPrice.bid <= 0) {
      throw new Error('Cotação inválida recebida das corretoras.');
    }

    // Atualiza o grafo de conversão com os preços recentes.

    const conversionGraph = buildConversionGraph(
      priceCollections
    );

    // Reconstrói a oportunidade com os preços atuais.

    const freshOpportunity = {
      symbol,

      base: buyPrice.base,
      quote: buyPrice.quote,

      buyExchangeId,
      sellExchangeId,

      buyExchange: buyExchangeId,
      sellExchange: sellExchangeId,

      buyPrice: buyPrice.ask,
      sellPrice: sellPrice.bid,

      buyFeePercent: number(buyPrice.feePercent),
      sellFeePercent: number(sellPrice.feePercent),

      status: 'candidate',

      simulations: [],
      validatedBudgets: [],
      validatedBudgetsUSD: [],
      validatedBudgetsBRL: []
    };

    if (buyPrice.quote !== sellPrice.quote) {
      throw new Error(
        'As duas corretoras estão usando moedas de cotação diferentes.'
      );
    }

    // A validação busca livros de ofertas novos e calcula
    // taxas, slippage, liquidez e lucro líquido.

    const evaluated = await evaluateCandidate(
      freshOpportunity,
      conversionGraph,
      exchangeInstances
    );

    const selectedSimulation = (
      evaluated.simulations || []
    ).find(item =>
      String(item.budgetCurrency || '').toUpperCase() ===
        budgetCurrency &&
      Math.abs(
        number(item.budgetAmount, -1) - budgetAmount
      ) < 0.001
    );

    if (!selectedSimulation) {
      throw new Error(
        'A simulação para esse orçamento não foi gerada.'
      );
    }

    const approved =
      selectedSimulation.validated === true ||
      selectedSimulation.approved === true;

    const record = {
      id: Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8),

      timestamp: new Date().toISOString(),

      symbol,

      buyExchangeId,
      sellExchangeId,

      budgetCurrency,
      budgetAmount,

      buyPrice: evaluated.buyPrice,
      sellPrice: evaluated.sellPrice,

      grossSpreadPercent: evaluated.grossSpreadPercent,
      estimatedNetPercent: evaluated.estimatedNetPercent,

      simulation: selectedSimulation,

      validated: approved,
      approved,

      realOrderSent: false,
      simulationOnly: true
    };

    saveSimulation(record);

    return res.json({
      success: true,
      version: VERSION,

      message: approved
        ? 'Simulação validada com os livros de ofertas atuais.'
        : 'Simulação calculada, mas não aprovada pelos critérios de segurança.',

      validated: approved,
      approved,

      realOrderSent: false,

      opportunity: evaluated,

      simulation: selectedSimulation,

      budgetCurrency,
      budgetAmount,

      netProfit: selectedSimulation.netProfit ?? null,
      netProfitUSD: selectedSimulation.netProfitUSD ?? null,
      netProfitBRL: selectedSimulation.netProfitBRL ?? null,

      profitPercent: selectedSimulation.profitPercent ?? null,

      historyId: record.id
    });
  } catch (error) {
    console.error('[SIMULATION]', error);

    return sendError(
      res,
      422,
      error.message || 'Não foi possível concluir a simulação.'
    );
  } finally {
    await closeExchangeInstances(exchangeInstances);

    simulationRunning = false;
  }
}

// ==========================================
// ROTAS DE SAÚDE
// ==========================================

app.get('/health', (req, res) => {
  res.json(getServerStatus());
});

app.get('/api/health', (req, res) => {
  res.json(getServerStatus());
});

// ==========================================
// ROTAS DE STATUS E CONFIGURAÇÃO
// ==========================================

app.get('/api/status', (req, res) => {
  res.json({
    ...getServerStatus(),
    opportunities:
      lastScanResult?.opportunities?.length || 0
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    version: VERSION,

    market: 'spot',
    modes: { spot: true, dex: false, futures: false },
    currencies: ALLOWED_CURRENCIES,

    budgets: {
      USD: BUDGETS.USD
    },

    simulationOnly: true,
    realTradingEnabled: false,

    simulation: {
      maxSlippagePercent: SIM.MAX_SLIPPAGE_PERCENT,
      minBudgetFillRatio: SIM.MIN_BUDGET_FILL_RATIO,
      minNetProfitBRL: SIM.MIN_NET_PROFIT_BRL,
      orderBookMaxAgeMs: SIM.ORDERBOOK_MAX_AGE_MS
    }
  });
});

// ==========================================
// ROTAS DE CORRETORAS
// ==========================================

app.get('/api/exchanges', (req, res) => {
  const supported = getSupportedExchanges() || [];
  const enabled = getEnabledExchangeIds();

  const exchanges = supported.map(item => {
    const id = normalizeExchangeId(item);

    return {
      id,
      name: item?.name || id,
      enabled: enabled.includes(id),
      market: 'spot'
    };
  });

  res.json({
    success: true,
    exchanges,
    total: exchanges.length
  });
});

// ==========================================
// ROTAS DO SCANNER
// ==========================================

app.get('/api/scan', async (req, res) => {
  const market = String(
    req.query.market || 'spot'
  ).toLowerCase();

  if (market !== 'spot') {
    return sendError(
      res,
      400,
      'Somente o mercado SPOT está habilitado.'
    );
  }

  const result = await executeScan();

  if (!result.success && result.busy) {
    return res.status(409).json(result);
  }

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
});

app.post('/api/scan', async (req, res) => {
  const result = await executeScan();

  if (!result.success && result.busy) {
    return res.status(409).json(result);
  }

  if (!result.success) {
    return res.status(500).json(result);
  }

  res.json(result);
});

app.get('/api/opportunities', (req, res) => {
  res.json({
    success: true,
    timestamp: lastScanAt,
    opportunities: lastScanResult?.opportunities || []
  });
});

app.get('/api/last-scan', (req, res) => {
  res.json({
    success: true,
    result: lastScanResult,
    lastScanAt
  });
});

// ==========================================
// ROTAS DE SIMULAÇÃO
// ==========================================

app.post('/api/simulation', handleSimulation);

// Compatibilidade com versões anteriores do HTML.
app.post('/api/simulations', handleSimulation);

// ==========================================
// HISTÓRICO DE SIMULAÇÕES
// ==========================================

app.get('/api/simulations', (req, res) => {
  res.json({
    success: true,
    simulations: simulationHistory,
    history: simulationHistory,
    total: simulationHistory.length
  });
});

app.get('/api/simulation/history', (req, res) => {
  res.json({
    success: true,
    simulations: simulationHistory,
    history: simulationHistory,
    total: simulationHistory.length
  });
});

app.delete('/api/simulations', (req, res) => {
  simulationHistory.length = 0;

  res.json({
    success: true,
    message: 'Histórico de simulações limpo.',
    total: 0
  });
});

// ==========================================
// CONTROLE DO SCANNER
// ==========================================

app.post('/api/scanner/start', (req, res) => {
  const interval = startScheduledScan();

  res.json({
    success: true,
    running: true,
    intervalMs: interval
  });
});

app.post('/api/scanner/stop', (req, res) => {
  stopScheduledScan();

  res.json({
    success: true,
    running: false
  });
});

// ==========================================
// DIAGNÓSTICO
// ==========================================

app.get('/api/diagnostics', (req, res) => {
  res.json({
    success: true,
    version: VERSION,

    server: getServerStatus(),

    exchanges: {
      enabled: getEnabledExchangeIds(),
      supported: getSupportedExchanges()
    },

    scanner: {
      running: scannerRunning,
      lastScanAt,
      opportunities:
        lastScanResult?.opportunities?.length || 0
    },

    simulation: {
      running: simulationRunning,
      historyCount: simulationHistory.length,
      currencies: ALLOWED_CURRENCIES,
      budgets: BUDGETS
    },

    realOrders: false
  });
});

// ROTA INEXISTENTE
// ==========================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Rota não encontrada',
    path: req.originalUrl,
    version: VERSION
  });
});

// ==========================================
// TRATAMENTO GLOBAL DE ERROS
// ==========================================

app.use((error, req, res, next) => {
  console.error('[SERVER ERROR]', error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error: 'Erro interno do servidor.',
    details:
      process.env.NODE_ENV === 'development'
        ? error.message
        : undefined
  });
});

// ==========================================
// INICIALIZAÇÃO
// ==========================================

const server = app.listen(PORT, () => {
  console.log('======================================');
  console.log('CRYPTO ARBITRAGE SCANNER ' + VERSION);
  console.log('Servidor iniciado na porta ' + PORT);
  console.log('Mercado: SPOT');
  console.log('Moedas: USD / BRL');
  console.log('Orçamentos USD:', BUDGETS.USD.join(', '));
  console.log('Ordens reais: DESABILITADAS');
  console.log('======================================');

  // Primeira consulta após iniciar o servidor.
  setTimeout(() => {
    if (!scannerRunning && !simulationRunning) {
      executeScan();
    }
  }, 5000);

  startScheduledScan();
});

// ==========================================
// ENCERRAMENTO SEGURO
// ==========================================

async function shutdown(signal) {
  console.log('[SERVER] Encerrando por', signal);

  stopScheduledScan();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ==========================================
// EXPORTAÇÃO
// ==========================================

module.exports = {
  app,
  server,
  executeScan,
  getServerStatus
};
