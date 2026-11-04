
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');

const {
  scanMarket,
  fetchExchangePrices,
  mapWithConcurrency,
  buildConversionGraph,
  evaluateCandidate
} = require('./scanner');

const {
  getSupportedExchanges,
  getEnabledExchanges
} = require('./exchanges');

const app = express();

// ==========================================
// CONFIGURAÇÃO
// ==========================================

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = config.PORT || 3000;

const LIVE_TRADING_ENABLED = false;
const REAL_ORDERS_ENABLED = false;

// ==========================================
// ESTADO DO SCANNER
// ==========================================

let lastScan = null;

let scanning = false;
let scannerRunning = true;
let diagnosticRunning = false;

let currentScanPromise = null;

let lastScanError = null;

let scanStartedAt = null;
let scanCompletedAt = null;

let nextScanTimer = null;

// ==========================================
// HISTÓRICO DE SIMULAÇÕES
// ==========================================

const simulationHistory = [];

const MAX_SIMULATION_HISTORY = 100;

const ALLOWED_BUDGETS =
  config.SIMULATION?.TRADE_BUDGETS_USD ||
  [50, 100, 150, 250, 500, 1000];

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================

function exchangeName(id) {
  return config.EXCHANGES[id]?.name || id;
}

function saveSimulation(operation) {

  simulationHistory.unshift(operation);

  if (simulationHistory.length > MAX_SIMULATION_HISTORY) {
    simulationHistory.length = MAX_SIMULATION_HISTORY;
  }

  return operation;
}

function findOpportunity(symbol, buyExchangeId, sellExchangeId) {

  if (!lastScan || !Array.isArray(lastScan.opportunities)) {
    return null;
  }

  return lastScan.opportunities.find(item =>
    item.symbol === symbol &&
    item.buyExchangeId === buyExchangeId &&
    item.sellExchangeId === sellExchangeId
  ) || null;
}

// ==========================================
// IDENTIFICAR CRITÉRIOS REPROVADOS
// ==========================================

function getFailedChecks(checks = {}) {

  const descriptions = {

    sufficientFill:
      'Liquidez insuficiente para preencher o capital escolhido.',

    acceptableSlippage:
      'Slippage acima do limite permitido.',

    positiveProfit:
      'Lucro líquido negativo ou igual a zero.',

    minimumProfit:
      'Lucro líquido abaixo do mínimo configurado.',

    fullBuy:
      'Não foi possível preencher toda a quantidade na compra.',

    fullSell:
      'Não foi possível preencher toda a quantidade na venda.'

  };

  return Object.entries(checks)

    .filter(([key, passed]) =>
      passed === false
    )

    .map(([key]) => ({

      code: key,

      description:
        descriptions[key] || key

    }));

}

// ==========================================
// CRIAR OPERAÇÃO REJEITADA
// ==========================================

function createRejectedOperation(
  data,
  reason,
  diagnostics = {}
) {

  const operation = {

    id: crypto.randomUUID(),

    createdAt: new Date().toISOString(),

    status: 'REJECTED',

    mode: 'SPOT',

    realOrderSent: false,

    symbol: data.symbol,

    buyExchangeId: data.buyExchangeId,

    sellExchangeId: data.sellExchangeId,

    buyExchange: exchangeName(data.buyExchangeId),

    sellExchange: exchangeName(data.sellExchangeId),

    budgetUSD: Number(data.budgetUSD) || null,

    approved: false,

    reason,

    failedChecks: diagnostics.failedChecks || [],

    checks: diagnostics.checks || null,

    netProfitBRL:
      diagnostics.netProfitBRL ?? null,

    simulation:
      diagnostics.simulation || null

  };

  return saveSimulation(operation);

}

// ==========================================
// EXECUÇÃO CONTROLADA DO SCANNER
// ==========================================

async function executeScan() {

  if (scanning && currentScanPromise) {
    return currentScanPromise;
  }

  if (diagnosticRunning) {
    throw new Error(
      'Diagnóstico das corretoras em andamento.'
    );
  }

  scanning = true;

  scanStartedAt = Date.now();

  lastScanError = null;

  currentScanPromise = (async () => {

    try {

      console.log('[SCANNER] Iniciando análise Spot...');

      const result = await scanMarket();

      lastScan = result;

      scanCompletedAt = Date.now();

      console.log(
        '[SCANNER] Análise concluída:',
        result.marketsAnalyzed,
        'mercados;',
        result.validatedCount,
        'oportunidades aprovadas.'
      );

      return result;

    } catch (error) {

      lastScanError = error.message || String(error);

      console.error('[SCANNER] Erro:', lastScanError);

      throw error;

    } finally {

      scanning = false;

      currentScanPromise = null;

    }

  })();

  return currentScanPromise;

}

// ==========================================
// AGENDAMENTO AUTOMÁTICO
// ==========================================

function scheduleNextScan() {

  if (!scannerRunning) return;

  if (nextScanTimer) {
    clearTimeout(nextScanTimer);
  }

  nextScanTimer = setTimeout(async () => {

    nextScanTimer = null;

    if (!scanning && !diagnosticRunning) {

      try {

        await executeScan();

      } catch (error) {

        console.error(
          '[SCANNER] Falha no ciclo:',
          error.message
        );

      }

    }

    scheduleNextScan();

  }, Math.max(
    1000,
    Number(config.SCAN_INTERVAL) || 5000
  ));

}

// ==========================================
// INICIAR SCANNER
// ==========================================

async function startScanner() {

  if (scannerRunning && nextScanTimer) {
    return;
  }

  scannerRunning = true;

  console.log(
    '[SCANNER] Inicializando scanner automático...'
  );

  if (diagnosticRunning) {

    scheduleNextScan();

    return;

  }

  try {

    await executeScan();

  } catch (error) {

    console.error(
      '[SCANNER] Primeira consulta falhou:',
      error.message
    );

  }

  scheduleNextScan();

}

// ==========================================
// PAUSAR SCANNER
// ==========================================

function stopScanner() {

  scannerRunning = false;

  if (nextScanTimer) {

    clearTimeout(nextScanTimer);

    nextScanTimer = null;

  }

  console.log('[SCANNER] Scanner pausado.');

}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', (req, res) => {

  res.json({

    status: 'ok',

    servidor: 'Crypto Arbitrage Scanner',

    versao: '6.2',

    mode: 'SPOT',

    scannerRunning,

    scanning,

    diagnosticRunning,

    simulationEnabled: true,

    realOrdersEnabled: false,

    timestamp: Date.now()

  });

});

// ==========================================
// STATUS GERAL
// ==========================================

app.get('/api/status', (req, res) => {

  const now = Date.now();

  res.json({

    server: 'online',

    scannerRunning,

    scanning,

    diagnosticRunning,

    mode: 'SPOT',

    lastScan: scanCompletedAt,

    scanStartedAt,

    scanCompletedAt,

    scanAgeMs: scanCompletedAt
      ? now - scanCompletedAt
      : null,

    lastScanError,

    nextInterval: config.SCAN_INTERVAL,

    opportunities: lastScan
      ? lastScan.validatedCount
      : 0,

    marketsAnalyzed: lastScan
      ? lastScan.marketsAnalyzed
      : 0,

    simulationsRegistered: simulationHistory.length,

    realOrdersEnabled: false

  });

});

// ==========================================
// OPORTUNIDADES
// ==========================================

app.get('/api/opportunities', async (req, res) => {

  try {

    let result;

    if (scanning && currentScanPromise) {

      result = await currentScanPromise;

    } else if (!lastScan) {

      result = await executeScan();

    } else {

      result = lastScan;

    }

    res.json({

      ...result,

      scannerRunning,

      scanning,

      lastUpdated: scanCompletedAt,

      scanAgeMs: scanCompletedAt
        ? Date.now() - scanCompletedAt
        : null,

      lastScanError

    });

  } catch (error) {

    res.status(503).json({

      error: 'Falha ao consultar oportunidades',

      message: error.message,

      opportunities: [],

      scannerRunning,

      scanning,

      lastScanError

    });

  }

});

// ==========================================
// FORÇAR NOVA ANÁLISE
// ==========================================

app.post('/api/scanner/scan', async (req, res) => {

  try {

    const result = await executeScan();

    res.json({

      ...result,

      scannerRunning,

      scanning,

      lastUpdated: scanCompletedAt,

      lastScanError

    });

  } catch (error) {

    res.status(503).json({

      error: 'Falha ao executar nova análise',

      message: error.message,

      opportunities: [],

      scannerRunning,

      scanning,

      lastScanError

    });

  }

});

// ==========================================
// MOTOR DE SIMULAÇÃO
// ==========================================

async function handleSimulation(req, res) {

  const {

    symbol,

    buyExchangeId,

    sellExchangeId,

    budgetUSD

  } = req.body || {};

  const budget = Number(budgetUSD);

  const requestData = {

    symbol,

    buyExchangeId,

    sellExchangeId,

    budgetUSD: budget

  };

  try {

    // ======================================
    // PROTEÇÃO CONTRA ORDENS REAIS
    // ======================================

    if (
      LIVE_TRADING_ENABLED ||
      REAL_ORDERS_ENABLED ||
      config.MODES?.LIVE_TRADING === true
    ) {

      return res.status(403).json({

        success: false,

        error: 'Modo de operação não permitido',

        realOrdersEnabled: false

      });

    }

    // ======================================
    // VALIDAR MODO SPOT
    // ======================================

    if (
      config.MODES?.SPOT === false ||
      config.MODES?.SIMULATION === false
    ) {

      return res.status(403).json({

        success: false,

        error: 'Simulação Spot indisponível',

        realOrdersEnabled: false

      });

    }

    // ======================================
    // VALIDAR REQUISIÇÃO
    // ======================================

    if (
      typeof symbol !== 'string' ||
      !symbol.trim() ||
      typeof buyExchangeId !== 'string' ||
      typeof sellExchangeId !== 'string' ||
      !Number.isFinite(budget)
    ) {

      return res.status(400).json({

        success: false,

        error: 'Dados incompletos',

        message: 'Informe moeda, corretoras e capital.'

      });

    }

    if (buyExchangeId === sellExchangeId) {

      return res.status(400).json({

        success: false,

        error: 'Corretoras iguais',

        message:
          'Compra e venda devem ocorrer em corretoras diferentes.'

      });

    }

    if (!ALLOWED_BUDGETS.some(
      value => Number(value) === budget
    )) {

      return res.status(400).json({

        success: false,

        error: 'Capital não permitido',

        allowedBudgets: ALLOWED_BUDGETS

      });

    }

    // ======================================
    // VALIDAR CORRETORAS
    // ======================================

    const enabled = getEnabledExchanges();

    if (
      !enabled.includes(buyExchangeId) ||
      !enabled.includes(sellExchangeId)
    ) {

      return res.status(403).json({

        success: false,

        error: 'Corretora indisponível',

        message:
          'Uma das corretoras não está habilitada.'

      });

    }

    // ======================================
    // VALIDAR SCANNER
    // ======================================

    if (
      !lastScan ||
      !Array.isArray(lastScan.opportunities)
    ) {

      return res.status(409).json({

        success: false,

        error: 'Nenhuma análise disponível',

        message:
          'Aguarde o scanner encontrar oportunidades.'

      });

    }

    const opportunity = findOpportunity(
      symbol,
      buyExchangeId,
      sellExchangeId
    );

    if (!opportunity) {

      return res.status(404).json({

        success: false,

        error: 'Oportunidade não encontrada',

        message:
          'Atualize o scanner e tente novamente.'

      });

    }

    // ======================================
    // VERIFICAR IDADE DA ANÁLISE
    // ======================================

    const scanAge = Date.now() -
      Number(lastScan.timestamp || 0);

    if (
      !lastScan.timestamp ||
      scanAge > 60000
    ) {

      return res.status(409).json({

        success: false,

        error: 'Análise desatualizada',

        message:
          'Atualize as oportunidades antes de simular.'

      });

    }

    console.log(
      '[SIMULAÇÃO] Atualizando mercado:',
      symbol,
      buyExchangeId,
      '->',
      sellExchangeId,
      '| Capital:',
      budget,
      'USD'
    );

    // ======================================
    // ATUALIZAR TICKERS
    // ======================================

    const freshExchangeResults = await Promise.all([

      fetchExchangePrices(buyExchangeId),

      fetchExchangePrices(sellExchangeId)

    ]);

    const freshPrices = freshExchangeResults.flatMap(
      result => result.prices || []
    );

    // ======================================
    // VERIFICAR DISPONIBILIDADE DOS PARES
    // ======================================

    const buyMarketExists = freshPrices.some(item =>

      item.exchangeId === buyExchangeId &&
      item.symbol === symbol

    );

    const sellMarketExists = freshPrices.some(item =>

      item.exchangeId === sellExchangeId &&
      item.symbol === symbol

    );

    if (!buyMarketExists || !sellMarketExists) {

      const operation = createRejectedOperation(

        requestData,

        'Par Spot indisponível em uma das corretoras.',

        {

          failedChecks: [{

            code: 'MARKET_UNAVAILABLE',

            description:
              'O par não está disponível nos dois mercados.'

          }]

        }

      );

      return res.status(422).json({

        success: false,

        error: 'Mercado indisponível',

        operation,

        realOrderSent: false

      });

    }

    // ======================================
    // GRAFO DE CONVERSÃO ATUALIZADO
    // ======================================

    const freshConversionGraph =
      buildConversionGraph(freshPrices);

    // ======================================
    // NOVA AVALIAÇÃO DA OPORTUNIDADE
    // ======================================

    const freshOpportunity = {

      ...opportunity,

      simulations: [],

      conversion: null,

      validatedBudgets: [],

      validatedCount: 0

    };

    const evaluated = await evaluateCandidate(

      freshOpportunity,

      freshConversionGraph

    );

    if (!evaluated) {

      const operation = createRejectedOperation(

        requestData,

        'Não foi possível reavaliar a oportunidade com os dados atualizados.',

        {

          failedChecks: [{

            code: 'REEVALUATION_FAILED',

            description:
              'A avaliação atualizada não retornou resultado.'

          }]

        }

      );

      return res.status(422).json({

        success: false,

        error: 'Falha na reavaliação',

        operation,

        realOrderSent: false

      });

    }

    // ======================================
    // LOCALIZAR CAPITAL ESCOLHIDO
    // ======================================

    const simulation = (

      evaluated.simulations || []

    ).find(item =>

      Math.abs(
        Number(item.budgetUSD) - budget
      ) < 0.001

    );

    if (!simulation) {

      const operation = createRejectedOperation(

        requestData,

        evaluated.reason ||
          'Não foi possível calcular a simulação para o capital escolhido.',

        {

          failedChecks: [{

            code: 'SIMULATION_UNAVAILABLE',

            description:
              'O motor não retornou resultado para o capital solicitado.'

          }]

        }

      );

      return res.status(422).json({

        success: false,

        error: 'Simulação indisponível',

        operation,

        realOrderSent: false

      });

    }

    // ======================================
    // ANALISAR CRITÉRIOS
    // ======================================

    const approved =
      simulation.validated === true;

    const failedChecks =
      getFailedChecks(simulation.checks);

    let reason;

    if (approved) {

      reason = 'Simulação aprovada';

    } else if (failedChecks.length > 0) {

      reason = failedChecks
        .map(item => item.description)
        .join(' ');

    } else {

      reason =
        simulation.reason ||
        'Operação não passou nos critérios de aprovação.';

    }

    // ======================================
    // REGISTRAR OPERAÇÃO
    // ======================================

    const operation = {

      id: crypto.randomUUID(),

      createdAt: new Date().toISOString(),

      status: approved
        ? 'SIMULATED'
        : 'REJECTED',

      mode: 'SPOT',

      realOrderSent: false,

      approved,

      symbol: evaluated.symbol,

      base: evaluated.base,

      quote: evaluated.quote,

      buyExchange: evaluated.buyExchange,

      sellExchange: evaluated.sellExchange,

      buyExchangeId,

      sellExchangeId,

      buyPrice: simulation.buyPrice ?? null,

      sellPrice: simulation.sellPrice ?? null,

      bestBuyPrice:
        simulation.bestBuyPrice ?? null,

      bestSellPrice:
        simulation.bestSellPrice ?? null,

      buyFeePercent:
        evaluated.buyFeePercent,

      sellFeePercent:
        evaluated.sellFeePercent,

      budgetUSD: budget,

      quoteCurrency: evaluated.quote,

      quantity: simulation.quantity ?? 0,

      investedBRL:
        simulation.investedBRL ?? null,

      netProfitBRL:
        simulation.netProfitBRL ?? null,

      netProfitQuote:
        simulation.netProfitQuote ?? null,

      profitPercent:
        simulation.profitPercent ?? null,

      fillRatio:
        simulation.fillRatio ?? null,

      slippagePercent:
        simulation.slippagePercent ?? null,

      buySlippagePercent:
        simulation.buySlippagePercent ?? null,

      sellSlippagePercent:
        simulation.sellSlippagePercent ?? null,

      buyFee:
        simulation.buyFee ?? null,

      sellFee:
        simulation.sellFee ?? null,

      totalBuyCost:
        simulation.totalBuyCost ?? null,

      totalSellRevenue:
        simulation.totalSellRevenue ?? null,

      reason,

      failedChecks,

      checks: simulation.checks || null,

      simulation: {

        ...simulation,

        reason,

        failedChecks

      },

      bookTimestamp:
        evaluated.bookTimestamp ?? null,

      bookTimestampEstimated:
        evaluated.bookTimestampEstimated ?? null,

      scanTimestamp: lastScan.timestamp,

      freshMarketCheck: true

    };

    saveSimulation(operation);

    // ======================================
    // LOG DO RESULTADO
    // ======================================

    console.log(

      approved
        ? '[SIMULAÇÃO] APROVADA:'
        : '[SIMULAÇÃO] REJEITADA:',

      symbol,

      '|',

      exchangeName(buyExchangeId),

      '->',

      exchangeName(sellExchangeId),

      '| Capital:',

      budget,

      'USD',

      '| Resultado:',

      operation.netProfitBRL,

      'BRL',

      '| Motivo:',

      reason

    );

    // ======================================
    // RESPOSTA DA API
    // ======================================

    return res.status(approved ? 201 : 422).json({

      success: approved,

      message: approved

        ? 'Compra e venda simuladas com sucesso.'

        : 'A simulação foi rejeitada pelos critérios de validação.',

      operation,

      diagnostics: {

        approved,

        failedChecks,

        checks: simulation.checks || null,

        reason

      },

      realOrderSent: false,

      realOrdersEnabled: false

    });

  } catch (error) {

    console.error('[SIMULAÇÃO]', error);

    let operation = null;

    if (
      requestData.symbol &&
      requestData.buyExchangeId &&
      requestData.sellExchangeId
    ) {

      operation = createRejectedOperation(

        requestData,

        error.message ||
          'Falha ao atualizar o mercado.',

        {

          failedChecks: [{

            code: 'SIMULATION_ERROR',

            description:
              error.message || 'Erro interno de simulação.'

          }]

        }

      );

    }

    return res.status(502).json({

      success: false,

      error: 'Falha ao executar simulação',

      message: error.message,

      operation,

      realOrderSent: false,

      realOrdersEnabled: false

    });

  }

}

// ==========================================
// ROTAS DE SIMULAÇÃO
// ==========================================

// Compatibilidade com os dois endereços.
// O aplicativo pode utilizar singular ou plural.

app.post(
  ['/api/simulation', '/api/simulations'],
  handleSimulation
);

// ==========================================
// HISTÓRICO DE SIMULAÇÕES
// ==========================================

app.get(
  ['/api/simulations', '/api/simulation/history'],
  (req, res) => {

    res.json({

      success: true,

      total: simulationHistory.length,

      persistent: false,

      realOrdersEnabled: false,

      simulations: simulationHistory

    });

  }
);

// ==========================================
// DIAGNÓSTICO DAS CORRETORAS
// ==========================================

app.get('/api/diagnostico', async (req, res) => {

  if (diagnosticRunning) {

    return res.status(409).json({

      status: 'busy',

      message:
        'Diagnóstico já está em execução.'

    });

  }

  if (scanning) {

    return res.status(409).json({

      status: 'busy',

      message:
        'Aguarde o ciclo atual do scanner terminar.'

    });

  }

  diagnosticRunning = true;

  try {

    const enabledExchanges = getEnabledExchanges();

    const results = await mapWithConcurrency(

      enabledExchanges,

      config.EXCHANGE_SCAN_CONCURRENCY || 2,

      async exchangeId => {

        try {

          const result =
            await fetchExchangePrices(exchangeId);

          return {

            id: exchangeId,

            name: exchangeName(exchangeId),

            status: 'connected',

            connected: true,

            markets: result.markets,

            error: null

          };

        } catch (error) {

          return {

            id: exchangeId,

            name: exchangeName(exchangeId),

            status: 'error',

            connected: false,

            markets: 0,

            error: error.message

          };

        }

      }

    );

    const connected = results.filter(
      item => item.connected
    );

    const totalMarkets = results.reduce(

      (total, item) =>
        total + Number(item.markets || 0),

      0

    );

    res.json({

      timestamp: Date.now(),

      totalExchanges: results.length,

      exchangesConnected: connected.length,

      exchangesFailed:
        results.length - connected.length,

      totalMarkets,

      exchanges: results

    });

  } catch (error) {

    res.status(500).json({

      error: error.message

    });

  } finally {

    diagnosticRunning = false;

  }

});

// ==========================================
// LISTA DE CORRETORAS
// ==========================================

app.get('/api/exchanges', (req, res) => {

  const configuredExchanges =
    getSupportedExchanges();

  const exchanges = configuredExchanges.map(
    exchange => {

      const scanInfo = lastScan?.exchanges?.find(
        item => item.id === exchange.id
      );

      return {

        id: exchange.id,

        name: exchange.name,

        enabled: exchange.enabled,

        supported: exchange.supported,

        connected: scanInfo
          ? scanInfo.connected
          : false,

        status: scanInfo
          ? scanInfo.status
          : exchange.status,

        markets: scanInfo
          ? scanInfo.markets
          : 0,

        error: scanInfo?.error || null

      };

    }

  );

  res.json({

    total: exchanges.length,

    enabled: exchanges.filter(
      item => item.enabled
    ).length,

    supported: exchanges.filter(
      item => item.supported
    ).length,

    connected: exchanges.filter(
      item => item.connected
    ).length,

    exchanges

  });

});

// ==========================================
// CONFIGURAÇÕES PÚBLICAS
// ==========================================

app.get('/api/config', (req, res) => {

  res.json({

    scanInterval: config.SCAN_INTERVAL,

    maximumMarkets: config.MAX_MARKETS_PER_EXCHANGE,

    minimumProfit:
      config.ARBITRAGE.MIN_PROFIT_PERCENT,

    budgets: ALLOWED_BUDGETS,

    defaultBudget:
      config.SIMULATION.DEFAULT_TRADE_BUDGET_USD,

    modes: {

      SPOT: true,

      FUTURES: false,

      DEX: false,

      SIMULATION: true,

      LIVE_TRADING: false

    },

    realOrdersEnabled: false

  });

});

// ==========================================
// INICIAR SCANNER PELA API
// ==========================================

app.post('/api/scanner/start', (req, res) => {

  if (scannerRunning) {

    return res.json({

      success: true,

      message: 'Scanner já está ativo.'

    });

  }

  scannerRunning = true;

  res.json({

    success: true,

    message: 'Scanner iniciado.'

  });

  if (!scanning && !diagnosticRunning) {

    executeScan()

      .catch(error => {

        console.error(
          '[SCANNER]',
          error.message
        );

      })

      .finally(scheduleNextScan);

  } else {

    scheduleNextScan();

  }

});

// ==========================================
// PAUSAR SCANNER PELA API
// ==========================================

app.post('/api/scanner/stop', (req, res) => {

  stopScanner();

  res.json({

    success: true,

    message: 'Scanner pausado.'

  });

});

// ==========================================
// ÚLTIMO RESULTADO
// ==========================================

app.get('/api/scanner/last', (req, res) => {

  res.json({

    timestamp: scanCompletedAt,

    scanning,

    scannerRunning,

    diagnosticRunning,

    lastScanError,

    data: lastScan

  });

});

// ==========================================
// ROTA NÃO ENCONTRADA
// ==========================================

app.use((req, res) => {

  res.status(404).json({

    error: 'Rota não encontrada',

    path: req.path

  });

});

// ==========================================
// TRATAMENTO DE ERROS
// ==========================================

app.use((error, req, res, next) => {

  console.error('[SERVER]', error);

  res.status(500).json({

    error: 'Erro interno do servidor',

    message:
      config.NODE_ENV === 'development'
        ? error.message
        : 'Erro interno'

  });

});

// ==========================================
// INICIALIZAÇÃO
// ==========================================

app.listen(PORT, '0.0.0.0', () => {

  console.log('====================================');

  console.log('CRYPTO ARBITRAGE SCANNER');

  console.log('Versão: 6.2');

  console.log('Porta:', PORT);

  console.log('Modo: SPOT');

  console.log('Simulação: ATIVA');

  console.log('Ordens reais: DESATIVADAS');

  console.log('====================================');

  startScanner();

});
