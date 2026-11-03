
const ccxt = require('ccxt');
const config = require('./config');

// ==========================================
// EXCHANGE MANAGER
// CRYPTO ARBITRAGE SCANNER
// ==========================================

const exchangeCache = new Map();


// ==========================================
// VERIFICAR SUPORTE DO CCXT
// ==========================================

function isSupported(exchangeId) {
  return (
    typeof ccxt[exchangeId] === 'function'
  );
}


// ==========================================
// CRIAR OU REUTILIZAR CONEXÃO
// ==========================================

function createExchange(exchangeId) {

  if (!isSupported(exchangeId)) {
    throw new Error(
      `Corretora não suportada pelo CCXT: ${exchangeId}`
    );
  }

  if (exchangeCache.has(exchangeId)) {
    return exchangeCache.get(exchangeId);
  }

  const exchange = new ccxt[exchangeId]({

    enableRateLimit: true,

    timeout: config.REQUEST_TIMEOUT || 15000,

    options: {
      defaultType: 'spot'
    }

  });

  exchangeCache.set(exchangeId, exchange);

  return exchange;
}


// ==========================================
// LISTAR CORRETORAS CONFIGURADAS
// ==========================================

function getSupportedExchanges() {

  return Object.entries(config.EXCHANGES)
    .map(([id, settings]) => {

      const supported = isSupported(id);

      return {

        id,

        name: settings.name || id,

        enabled: Boolean(settings.enabled),

        supported,

        available: Boolean(
          settings.enabled && supported
        ),

        status: !supported
          ? 'unsupported'
          : settings.enabled
            ? 'configured'
            : 'disabled'

      };

    });

}


// ==========================================
// LISTAR CORRETORAS ATIVAS
// ==========================================

function getEnabledExchanges() {

  return getSupportedExchanges()
    .filter(exchange => exchange.available)
    .map(exchange => exchange.id);

}


// ==========================================
// CARREGAR MERCADOS
// ==========================================

async function loadExchangeMarkets(exchangeId) {

  const exchange = createExchange(exchangeId);

  await exchange.loadMarkets();

  return {

    exchangeId,

    exchange: config.EXCHANGES[exchangeId]?.name ||
      exchangeId,

    totalMarkets: Object.keys(
      exchange.markets || {}
    ).length,

    markets: exchange.markets

  };

}


// ==========================================
// CAPACIDADES DA CORRETORA
// ==========================================

function getExchangeCapabilities(exchangeId) {

  const exchange = createExchange(exchangeId);

  return {

    id: exchangeId,

    name: config.EXCHANGES[exchangeId]?.name ||
      exchangeId,

    spot: Boolean(
      exchange.has.fetchTicker &&
      exchange.has.fetchOrderBook
    ),

    fetchTickers: exchange.has.fetchTickers,

    fetchOrderBook: exchange.has.fetchOrderBook,

    websocket: Boolean(
      exchange.has.watchTicker
    ),

    authenticated: false,

    realOrdersEnabled: false

  };

}


// ==========================================
// LIMPAR CACHE
// ==========================================

function clearExchangeCache(exchangeId) {

  if (exchangeId) {

    const exchange = exchangeCache.get(exchangeId);

    if (exchange && typeof exchange.close === 'function') {
      exchange.close().catch(() => {});
    }

    exchangeCache.delete(exchangeId);

    return true;
  }

  for (const exchange of exchangeCache.values()) {

    if (typeof exchange.close === 'function') {
      exchange.close().catch(() => {});
    }

  }

  exchangeCache.clear();

  return true;

}


// ==========================================
// EXPORTAÇÕES
// ==========================================

module.exports = {

  createExchange,

  isSupported,

  getSupportedExchanges,

  getEnabledExchanges,

  loadExchangeMarkets,

  getExchangeCapabilities,

  clearExchangeCache

};
