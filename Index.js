
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const config = require('./config');

const {
  scanMarket
} = require('./scanner');

const app = express();

app.use(cors());
app.use(express.json());

let lastScan = null;
let scanning = false;

app.get('/', (req, res) => {
  res.json({
    name: 'Crypto Arbitrage Scanner',
    version: '1.0.0',
    status: 'online',
    modes: {
      spot: true,
      futures: true,
      dex: true,
      simulation: true,
      liveTrading: false
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'Crypto Arbitrage Scanner',
    timestamp: Date.now()
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    scanning,
    lastScan
  });
});

app.get('/api/opportunities', async (req, res) => {
  try {
    if (scanning) {
      if (lastScan) {
        return res.json(lastScan);
      }

      return res.status(503).json({
        error: 'Primeira leitura em andamento'
      });
    }

    scanning = true;

    try {
      lastScan = await scanMarket();
      res.json(lastScan);
    } finally {
      scanning = false;
    }

  } catch (error) {
    scanning = false;

    res.status(500).json({
      error: 'Erro ao analisar o mercado',
      message: error.message
    });
  }
});

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

app.get('/api/config', (req, res) => {
  res.json({
    scanInterval: config.SCAN_INTERVAL,
    minimumProfit: config.ARBITRAGE.MIN_PROFIT_PERCENT,
    modes: config.MODES
  });
});

app.listen(config.PORT, () => {
  console.log(
    `Crypto Arbitrage Scanner rodando na porta ${config.PORT}`
  );
});

