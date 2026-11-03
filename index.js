
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const config = require('./config');

const {
  scanMarket
} = require('./scanner');

const app = express();

app.use(cors());
app.use(express.json());

// ======================================
// INTERFACE DO SITE
// ======================================

app.use(express.static(path.join(__dirname, 'public')));

// ======================================
// CONTROLE DO SCANNER
// ======================================

let lastScan = null;
let scanning = false;

// ======================================
// STATUS DO SERVIDOR
// ======================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'Crypto Arbitrage Scanner',
    timestamp: Date.now()
  });
});

// ======================================
// STATUS DO SISTEMA
// ======================================

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    scanning,
    lastScan
  });
});

// ======================================
// OPORTUNIDADES
// ======================================

app.get('/api/opportunities', async (req, res) => {
  if (scanning) {
    if (lastScan) {
      return res.json(lastScan);
    }

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

// ======================================
// CORRETORAS
// ======================================

app.get('/api/exchanges', (req, res) => {
  res.json({
    exchanges: Object.entries(config.EXCHANGES)
      .map(([id, exchange]) => ({
        id,
        name: exchange.name,
        enabled: exchange.enabled
      }))
  });
});

// ======================================
// CONFIGURAÇÕES
// ======================================

app.get('/api/config', (req, res) => {
  res.json({
    scanInterval: config.SCAN_INTERVAL,
    minimumProfit: config.ARBITRAGE.MIN_PROFIT_PERCENT,
    modes: config.MODES
  });
});

// ======================================
// INICIALIZAÇÃO
// ======================================

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(
    `Crypto Arbitrage Scanner online na porta ${config.PORT}`
  );
});
