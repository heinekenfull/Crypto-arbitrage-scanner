require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  SCAN_INTERVAL: 5000,
  REQUEST_TIMEOUT: 15000,

  MAX_MARKETS_PER_EXCHANGE: 500,
  EXCHANGE_SCAN_CONCURRENCY: 2,

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

  ARBITRAGE: {
    MIN_PROFIT_PERCENT: 0.30,
    MAX_SPREAD_PERCENT: 10,
    TRADING_FEE_PERCENT: 0.10,
    EXCHANGE_TAKER_FEES_PERCENT: {},
    INITIAL_BALANCE: 1000
  },

  SIMULATION: {
    DEFAULT_TRADE_BUDGET_USD: 100,
    DEFAULT_TRADE_BUDGET_BRL: 100,

    TRADE_BUDGETS_USD: [50, 100, 150, 250, 500],
    TRADE_BUDGETS_BRL: [50, 100, 150, 250, 500],

    ORDERBOOK_DEPTH: null,
    ORDERBOOK_MAX_AGE_MS: 15000,
    MAX_BOOK_SKEW_MS: 5000,

    MAX_CANDIDATES_TO_VALIDATE: 100,
    VALIDATION_CONCURRENCY: 2,

    MAX_SLIPPAGE_PERCENT: 1.0,
    MIN_BUDGET_FILL_RATIO: 0.90,
    MIN_NET_PROFIT_BRL: 0.10
  },

  MODES: {
    SPOT: true,
    FUTURES: false,
    DEX: false,
    SIMULATION: true,
    LIVE_TRADING: false
  }
};
