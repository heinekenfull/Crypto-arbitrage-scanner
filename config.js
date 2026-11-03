
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // ======================================
  // DESEMPENHO DO SCANNER
  // ======================================

  SCAN_INTERVAL: 3000,
  REQUEST_TIMEOUT: 15000,

  MAX_MARKETS_PER_EXCHANGE: 500,

  EXCHANGE_SCAN_CONCURRENCY: 2,

  // ======================================
  // CORRETORAS
  // ======================================

  EXCHANGES: {
    okx: { enabled: true, name: 'OKX' },
    kucoin: { enabled: true, name: 'KuCoin' },
    gateio: { enabled: true, name: 'Gate.io' },
    mexc: { enabled: true, name: 'MEXC' },
    bitget: { enabled: true, name: 'Bitget' },
    coinex: { enabled: true, name: 'CoinEx' },
    htx: { enabled: true, name: 'HTX' },
    bitmart: { enabled: true, name: 'BitMart' },
    bingx: { enabled: true, name: 'BingX' },

    binance: { enabled: false, name: 'Binance' },
    bybit: { enabled: false, name: 'Bybit' }
  },

  // ======================================
  // ARBITRAGEM
  // ======================================

  ARBITRAGE: {
    MIN_PROFIT_PERCENT: 0.30,
    MAX_SPREAD_PERCENT: 10,

    TRADING_FEE_PERCENT: 0.10,

    // Taxas taker efetivas por corretora.
    // Valores em porcentagem.
    EXCHANGE_TAKER_FEES_PERCENT: {},

    INITIAL_BALANCE: 1000
  },

  // ======================================
  // SIMULAÇÕES
  // ======================================

  SIMULATION: {
    // Capital padrão selecionado.
    DEFAULT_TRADE_BUDGET_USD: 100,

    // Valores disponíveis no aplicativo.
    TRADE_BUDGETS_USD: [
      50,
      100,
      150,
      250,
      500,
      1000
    ],

    // Compatibilidade com o scanner atual.
    TRADE_BUDGET_BRL: 100,

    // Consulta automática do livro.
    // O scanner será ajustado para usar
    // o limite padrão de cada corretora.
    ORDERBOOK_DEPTH: null,

    ORDERBOOK_MAX_AGE_MS: 15000,

    // Quantidade de candidatas por ciclo.
    MAX_CANDIDATES_TO_VALIDATE: 100,

    // Concorrência controlada.
    VALIDATION_CONCURRENCY: 2,

    MAX_SLIPPAGE_PERCENT: 1.0,

    MIN_BUDGET_FILL_RATIO: 0.98,

    MIN_NET_PROFIT_BRL: 0.10
  },

  // ======================================
  // MODOS DE OPERAÇÃO
  // ======================================

  MODES: {
    SPOT: true,
    FUTURES: true,
    DEX: true,

    SIMULATION: true,
    LIVE_TRADING: false
  }
};
