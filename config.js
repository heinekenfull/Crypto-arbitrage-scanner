
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',

  SCAN_INTERVAL: 3000,
  REQUEST_TIMEOUT: 15000,

  MAX_MARKETS_PER_EXCHANGE: 500,

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

    // Taxa padrão de contingência.
    TRADING_FEE_PERCENT: 0.10,

    // Preencher com taxas taker efetivas das contas.
    // Valores em porcentagem, não em fração.
    EXCHANGE_TAKER_FEES_PERCENT: {},

    INITIAL_BALANCE: 1000
  },

  SIMULATION: {
    TRADE_BUDGET_BRL: 100,

    ORDERBOOK_DEPTH: 50,
    ORDERBOOK_MAX_AGE_MS: 15000,

    MAX_CANDIDATES_TO_VALIDATE: 30,

    MAX_SLIPPAGE_PERCENT: 1.0,

    MIN_BUDGET_FILL_RATIO: 0.98,

    MIN_NET_PROFIT_BRL: 0.10
  },

  MODES: {
    SPOT: true,
    FUTURES: true,
    DEX: true,
    SIMULATION: true,
    LIVE_TRADING: false
  }
};
