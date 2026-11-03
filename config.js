
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,

  NODE_ENV: process.env.NODE_ENV || 'development',

  SCAN_INTERVAL: 3000,

  REQUEST_TIMEOUT: 10000,

  EXCHANGES: {
    binance: {
      enabled: true,
      name: 'Binance'
    },
    okx: {
      enabled: true,
      name: 'OKX'
    },
    bybit: {
      enabled: true,
      name: 'Bybit'
    },
    kucoin: {
      enabled: true,
      name: 'KuCoin'
    },
    gateio: {
      enabled: true,
      name: 'Gate.io'
    }
  },

  ARBITRAGE: {
    MIN_PROFIT_PERCENT: 0.30,
    MAX_SPREAD_PERCENT: 10,
    TRADING_FEE_PERCENT: 0.10,
    INITIAL_BALANCE: 1000
  },

  MODES: {
    SPOT: true,
    FUTURES: true,
    DEX: true,
    SIMULATION: true,
    LIVE_TRADING: false
  }
};
