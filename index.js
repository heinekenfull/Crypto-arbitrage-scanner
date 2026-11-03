
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

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

let lastScan = null;
let scanning = false;
let diagnosticRunning = false;

// STATUS DO SERVIDOR
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'Crypto Arbitrage Scanner',
    timestamp: Date.now()
  });
});

// STATUS DO SISTEMA
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    scanning,
    lastScan
  });
});

// OPORTUNIDADES
app.get('/api/opportunities', async (req, res) => {
  if (scanning) {
    if (lastScan) return res.json(lastScan);

    return res.status(503).json({
      error: 'Primeira consulta em andamento'
    });
  }

  scanning = true;

  try {
    lastScan = await scanMarket();
    res.json(lastScan);
  } catch (error) {
    console.error('Erro no scanner:', error);

    res.status(500).json({
      error: 'Erro ao analisar mercado',
      message: error.message
    });
  } finally {
    scanning = false;
  }
});

// DIAGNÓSTICO INDIVIDUAL DAS CORRETORAS
app.get('/api/diagnostico', async (req, res) => {
  if (diagnosticRunning) {
    return res.status(503).json({
      error: 'Diagnóstico já está em andamento'
    });
  }

  diagnosticRunning = true;

  try {
    const exchanges = Object.entries(config.EXCHANGES)
      .filter(([id, settings]) => settings.enabled)
      .map(([id, settings]) => ({
        id,
        name: settings.name,
        supported: Boolean(ccxt[id])
      }));

    const supported = exchanges.filter(item => item.supported);

    const results = await mapWithConcurrency(
      supported,
      2,
      async item => {
        const result = await fetchExchangePrices(item.id);

        return {
          id: item.id,
          name: item.name,
          status: 'connected',
          marketsDiscovered: result.marketsDiscovered,
          marketsReceived: result.marketsReceived
        };
      }
    );

    const report = results.map((result, index) => {
      if (result && !result.error) return result;

      return {
        id: supported[index].id,
        name: supported[index].name,
        status: 'failed',
        error: result?.error || 'Erro desconhecido'
      };
    });

    for (const item of exchanges.filter(item => !item.supported)) {
      report.push({
        id: item.id,
        name: item.name,
        status: 'unsupported',
        error: 'Corretora não encontrada na versão instalada do CCXT'
      });
    }

    res.json({
      timestamp: Date.now(),
      totalConfigured: exchanges.length,
      totalConnected: report.filter(item => item.status === 'connected').length,
      exchanges: report
    });

  } catch (error) {
    console.error('Erro no diagnóstico:', error);

    res.status(500).json({
      error: 'Falha no diagnóstico',
      message: error.message
    });
  } finally {
    diagnosticRunning = false;
  }
});

// CORRETORAS CONFIGURADAS
app.get('/api/exchanges', (req, res) => {
  res.json({
    exchanges: Object.entries(config.EXCHANGES).map(([id, exchange]) => ({
      id,
      name: exchange.name,
      enabled: exchange.enabled
    }))
  });
});

// CONFIGURAÇÕES
app.get('/api/config', (req, res) => {
  res.json({
    scanInterval: config.SCAN_INTERVAL,
    minimumProfit: config.ARBITRAGE.MIN_PROFIT_PERCENT,
    modes: config.MODES
  });
});

// INICIALIZAÇÃO
app.listen(config.PORT, '0.0.0.0', () => {
  console.log(
    `Crypto Arbitrage Scanner online na porta ${config.PORT}`
  );
});
