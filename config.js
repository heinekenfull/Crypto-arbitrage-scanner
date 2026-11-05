require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  SCAN_INTERVAL: 45000,
  REQUEST_TIMEOUT: 10000,

  MAX_MARKETS_PER_EXCHANGE: 120,
  EXCHANGE_SCAN_CONCURRENCY: 1,

  // Somente corretoras suportadas e habilitadas para o scanner SPOT.
  EXCHANGES: {
    okx: { enabled: true, name: 'OKX' },
    kucoin: { enabled: true, name: 'KuCoin' },
    mexc: { enabled: true, name: 'MEXC' },
    bitget: { enabled: true, name: 'Bitget' },
    htx: { enabled: true, name: 'HTX' },
    bingx: { enabled: true, name: 'BingX' }
  },

  ARBITRAGE: {
    MIN_PROFIT_PERCENT: 0.05,
    MAX_SPREAD_PERCENT: 10,
    TRADING_FEE_PERCENT: 0.10,
    EXCHANGE_TAKER_FEES_PERCENT: {},
    INITIAL_BALANCE: 1000
  },

  SIMULATION: {
    DEFAULT_TRADE_BUDGET_USD: 100,

    // Capital interno de referência para medir liquidez e slippage.
    // Não há seleção ou comparação de capitais na interface.

    ORDERBOOK_DEPTH: 12,
    ORDERBOOK_MAX_AGE_MS: 15000,
    ORDERBOOK_REQUEST_TIMEOUT_MS: 8000,
    MAX_BOOK_SKEW_MS: 5000,

    MAX_CANDIDATES_TO_VALIDATE: 18,
    VALIDATION_CONCURRENCY: 1,

    MAX_SLIPPAGE_PERCENT: 1.0,
    MIN_BUDGET_FILL_RATIO: 0.90,
    MIN_NET_PROFIT_BRL: 0.10
  },

  MODES: {
    SPOT: true,
    FUTURES: false,
    DEX: true,
    SIMULATION: true,
    LIVE_TRADING: false
  }
};
