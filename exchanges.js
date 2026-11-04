
const ccxt = require('ccxt');
const config = require('./config');

// ==========================================
// CRYPTO ARBITRAGE SCANNER 6.2
// GERENCIAMENTO DE CORRETORAS
// SPOT EXCLUSIVAMENTE
// ==========================================

const exchangeConfig = config.EXCHANGES || {};

const exchangeInstances = new Set();

// ==========================================
// IDENTIFICAÇÃO DE CORRETORAS
// ==========================================

function isSupported(exchangeId) {
  return (
    typeof exchangeId === 'string' &&
    typeof ccxt[exchangeId] === 'function'
  );
}

function isEnabled(exchangeId) {
  const item = exchangeConfig[exchangeId];

  return Boolean(
    item &&
    item.enabled === true
  );
}

// ==========================================
// CRIAR INSTÂNCIA CCXT
// ==========================================

function createExchange(exchangeId) {
  if (!isSupported(exchangeId)) {
    throw new Error(
      `Corretora não suportada pela versão instalada do CCXT: ${exchangeId}`
    );
  }

  if (!isEnabled(exchangeId)) {
    throw new Error(
      `Corretora não habilitada na configuração: ${exchangeId}`
    );
  }

  const ExchangeClass = ccxt[exchangeId];

  const exchange = new ExchangeClass({
    enableRateLimit: true,

    timeout: Number(
      config.REQUEST_TIMEOUT || 15000
    ),

    options: {
      defaultType: 'spot',
      adjustForTimeDifference: true
    }
  });

  exchangeInstances.add(exchange);

  return exchange;
}

// ==========================================
// FECHAR INSTÂNCIA COM SEGURANÇA
// ==========================================

async function closeExchange(exchange) {
  if (!exchange) return;

  exchangeInstances.delete(exchange);

  if (typeof exchange.close !== 'function') {
    return;
  }

  try {
    await exchange.close();
  } catch (error) {
    console.warn(
      '[EXCHANGES] Erro ao fechar conexão:',
      exchange.id || 'desconhecida',
      error.message || String(error)
    );
  }
}

// ==========================================
// FECHAR TODAS AS INSTÂNCIAS ATIVAS
// ==========================================

async function clearExchangeCache() {
  const instances = Array.from(exchangeInstances);

  await Promise.all(
    instances.map(exchange =>
      closeExchange(exchange)
    )
  );

  exchangeInstances.clear();

  return {
    closed: instances.length
  };
}

// ==========================================
// CORRETORAS SUPORTADAS
// ==========================================

function getSupportedExchanges() {
  return Object.entries(exchangeConfig).map(
    ([exchangeId, settings]) => {
      const supported = isSupported(exchangeId);

      const enabled =
        settings.enabled === true;

      return {
        id: exchangeId,

        name:
          settings.name ||
          exchangeId,

        enabled,

        supported,

        available:
          enabled && supported,

        status: !supported
          ? 'unsupported'
          : enabled
            ? 'configured'
            : 'disabled'
      };
    }
  );
}

// ==========================================
// CORRETORAS HABILITADAS
// ==========================================

function getEnabledExchanges() {
  return Object.keys(exchangeConfig).filter(
    exchangeId =>
      isEnabled(exchangeId) &&
      isSupported(exchangeId)
  );
}

// ==========================================
// CARREGAR MERCADOS
// ==========================================

async function loadExchangeMarkets(exchangeId) {
  const exchange = createExchange(exchangeId);

  try {
    const markets = await exchange.loadMarkets();

    return {
      exchangeId,

      exchange:
        exchangeConfig[exchangeId]?.name ||
        exchangeId,

      markets,

      count: Object.keys(markets || {}).length
    };

  } finally {
    await closeExchange(exchange);
  }
}

// ==========================================
// CAPACIDADES DA CORRETORA
// ==========================================

function getExchangeCapabilities(exchangeId) {
  if (!isSupported(exchangeId)) {
    return {
      id: exchangeId,
      supported: false,
      enabled: isEnabled(exchangeId),
      available: false,
      error: 'Corretora não suportada pelo CCXT.'
    };
  }

  const ExchangeClass = ccxt[exchangeId];

  const exchange = new ExchangeClass({
    enableRateLimit: true,
    options: {
      defaultType: 'spot'
    }
  });

  const has = exchange.has || {};

  return {
    id: exchangeId,

    name:
      exchangeConfig[exchangeId]?.name ||
      exchangeId,

    supported: true,

    enabled: isEnabled(exchangeId),

    available: isEnabled(exchangeId),

    spot: true,

    fetchTicker:
      has.fetchTicker === true,

    fetchTickers:
      has.fetchTickers === true,

    fetchOrderBook:
      has.fetchOrderBook === true,

    watchTicker:
      has.watchTicker === true,

    authenticated: false,

    realOrdersEnabled: false
  };
}

// ==========================================
// EXPORTAÇÕES
// ==========================================

module.exports = {
  createExchange,

  closeExchange,

  clearExchangeCache,

  getSupportedExchanges,

  getEnabledExchanges,

  loadExchangeMarkets,

  getExchangeCapabilities,

  isSupported,

  isEnabled
};
