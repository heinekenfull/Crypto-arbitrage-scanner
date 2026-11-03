
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const ccxt = require('ccxt');

const config = require('./config');

const {
  scanMarket,
  fetchExchangePrices,
  mapWithConcurrency
} = require('./scanner');

const app = express();

// ==========================================
// CONFIGURAÇÃO DO SERVIDOR
// ==========================================

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const PORT = config.PORT || 3000;

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
// EXECUÇÃO CONTROLADA DO SCANNER
// ==========================================

async function executeScan() {

  if (scanning && currentScanPromise) {
    return currentScanPromise;
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

      lastScanError = error.message;

      console.error(
        '[SCANNER] Erro:',
        error.message
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

    if (!scanning) {

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

  }, config.SCAN_INTERVAL || 5000);

}


async function startScanner() {

  if (scannerRunning && nextScanTimer) {
    return;
  }

  scannerRunning = true;

  console.log('[SCANNER] Inicializando scanner automático...');

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

    versao: '6.0',

    mode: 'SPOT',

    scannerRunning,

    scanning,

    timestamp: Date.now()

  });

});


// ==========================================
// STATUS GERAL
// ==========================================

app.get('/api/status', (req, res) => {

  res.json({

    server: 'online',

    scannerRunning,

    scanning,

    diagnosticRunning,

    mode: 'SPOT',

    lastScan: scanCompletedAt,

    scanStartedAt,

    scanCompletedAt,

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

      lastScanError

    });

  } catch (error) {

    res.status(500).json({

      error: 'Falha ao consultar oportunidades',

      message: error.message,

      opportunities: [],

      scannerRunning,

      scanning

    });

  }

});


// ==========================================
// DIAGNÓSTICO DAS CORRETORAS
// ==========================================

app.get('/api/diagnostico', async (req, res) => {

  if (diagnosticRunning) {

    return res.status(409).json({

      status: 'busy',

      message: 'Diagnóstico já está em execução.'

    });

  }

  diagnosticRunning = true;

  try {

    const enabledExchanges = Object.entries(
      config.EXCHANGES
    )
      .filter(([id, settings]) =>
        settings.enabled && ccxt[id]
      )
      .map(([id]) => id);

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
              config.EXCHANGES[exchangeId].name,

            status: 'connected',

            connected: true,

            markets: result.markets,

            error: null

          };

        } catch (error) {

          return {

            id: exchangeId,

            name:
              config.EXCHANGES[exchangeId].name,

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
      (total, item) => total + item.markets,
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

  const exchanges = Object.entries(
    config.EXCHANGES
  ).map(([id, settings]) => {

    const supported = Boolean(ccxt[id]);

    const scanInfo = lastScan?.exchanges?.find(
      item => item.id === id
    );

    return {

      id,

      name: settings.name,

      enabled: settings.enabled,

      supported,

      connected: scanInfo
        ? scanInfo.connected
        : false,

      status: scanInfo
        ? scanInfo.status
        : 'not_checked',

      markets: scanInfo
        ? scanInfo.markets
        : 0

    };

  });

  res.json({

    total: exchanges.length,

    enabled: exchanges.filter(
      item => item.enabled
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
// CONTROLE DO SCANNER
// ==========================================

app.post('/api/scanner/start', async (req, res) => {

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

  if (!scanning) {

    executeScan()
      .catch(error => console.error(error.message))
      .finally(scheduleNextScan);

  } else {

    scheduleNextScan();

  }

});


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

  console.log('Versão: 6.0');

  console.log('Porta:', PORT);

  console.log('Modo: SPOT');

  console.log('Simulação: ATIVA');

  console.log('Ordens reais: DESATIVADAS');

  console.log('====================================');

  startScanner();

});
