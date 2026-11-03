
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');

const {
  scanMarket,
  fetchExchangePrices,
  mapWithConcurrency
} = require('./scanner');

const {
  getSupportedExchanges,
  getEnabledExchanges
} = require('./exchanges');

const app = express();

// ==========================================
// CONFIGURAÇÃO DO SERVIDOR
// ==========================================

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const PORT = config.PORT || 3000;

// ==========================================
// ESTADO DO SERVIDOR E SCANNER
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
// EXECUTAR ANÁLISE
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

      console.log(
        '[SCANNER] Iniciando análise Spot...'
      );

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

      lastScanError =
        error.message || String(error);

      console.error(
        '[SCANNER] Erro:',
        lastScanError
      );

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

  console.log(
    '[SCANNER] Scanner pausado.'
  );

}


// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', (req, res) => {

  res.json({

    status: 'ok',

    servidor: 'Crypto Arbitrage Scanner',

    versao: '6.0',

    mode: 'SPOT',

    scannerRunning,

    scanning,

    diagnosticRunning,

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
      : 0

  });

});


// ==========================================
// OPORTUNIDADES
// ==========================================

app.get('/api/opportunities', async (req, res) => {

  try {

    let result;

    if (scanning && currentScanPromise) {

      // Aguarda a análise em andamento.

      result = await currentScanPromise;

    } else if (!lastScan) {

      // Primeira consulta.

      result = await executeScan();

    } else {

      // Retorna o último resultado completo.

      result = lastScan;

    }

    const now = Date.now();

    res.json({

      ...result,

      scannerRunning,

      scanning,

      lastUpdated: scanCompletedAt,

      scanAgeMs: scanCompletedAt
        ? now - scanCompletedAt
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
// DIAGNÓSTICO DAS CORRETORAS
// ==========================================

app.get('/api/diagnostico', async (req, res) => {

  // Impede diagnóstico simultâneo.

  if (diagnosticRunning) {

    return res.status(409).json({

      status: 'busy',

      message: 'Diagnóstico já está em execução.'

    });

  }

  // Não disputa requisições com o scanner.

  if (scanning) {

    return res.status(409).json({

      status: 'busy',

      message:
        'Aguarde o ciclo atual do scanner terminar.'

    });

  }

  diagnosticRunning = true;

  try {

    const enabledExchanges =
      getEnabledExchanges();

    const results = await mapWithConcurrency(

      enabledExchanges,

      config.EXCHANGE_SCAN_CONCURRENCY || 2,

      async exchangeId => {

        try {

          const result = await fetchExchangePrices(
            exchangeId
          );

          return {

            id: exchangeId,

            name:
              config.EXCHANGES[exchangeId]?.name ||
              exchangeId,

            status: 'connected',

            connected: true,

            markets: result.markets,

            error: null

          };

        } catch (error) {

          return {

            id: exchangeId,

            name:
              config.EXCHANGES[exchangeId]?.name ||
              exchangeId,

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

    maximumMarkets:
      config.MAX_MARKETS_PER_EXCHANGE,

    minimumProfit:
      config.ARBITRAGE.MIN_PROFIT_PERCENT,

    budgets:
      config.SIMULATION.TRADE_BUDGETS_USD,

    defaultBudget:
      config.SIMULATION.DEFAULT_TRADE_BUDGET_USD,

    modes: {

      SPOT: true,

      FUTURES: false,

      DEX: false,

      SIMULATION: true,

      LIVE_TRADING: false

    }

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

  console.log(
    '===================================='
  );

  console.log(
    'CRYPTO ARBITRAGE SCANNER'
  );

  console.log(
    'Versão: 6.0'
  );

  console.log(
    'Porta:',
    PORT
  );

  console.log(
    'Modo: SPOT'
  );

  console.log(
    'Simulação: ATIVA'
  );

  console.log(
    'Ordens reais: DESATIVADAS'
  );

  console.log(
    '===================================='
  );

  startScanner();

});
