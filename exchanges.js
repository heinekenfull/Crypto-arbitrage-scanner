
const ccxt = require('ccxt');
const config = require('./config');

// ==========================================
// CRYPTO ARBITRAGE SCANNER 6.2.2
// GERENCIAMENTO DE CORRETORAS
// SPOT — SOMENTE CONSULTA E SIMULAÇÃO
// ==========================================

const exchangeConfig = config.EXCHANGES || {};
const exchangeInstances = new Set();

// ==========================================
// IDENTIFICAÇÃO
// ==========================================

function isSupported(exchangeId) {
  return (
    typeof exchangeId === 'string' &&
    typeof ccxt[exchangeId] === 'function'
  );
}

function isEnabled(exchangeId) {
  return exchangeConfig[exchangeId]?.enabled === true;
}

// ==========================================
// CRIAR INSTÂNCIA
// ==========================================

function createExchange(exchangeId) {
  if (!isSupported(exchangeId)) {
    throw new Error(
      `Corretora não suportada pelo CCXT: ${exchangeId}`
    );
  }

  if (!isEnabled(exchangeId)) {
    throw new Error(
      `Corretora não habilitada: ${exchangeId}`
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
// FECHAR INSTÂNCIA
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
      '[EXCHANGES] Falha ao fechar conexão:',
      exchange.id || 'desconhecida',
      error.message || String(error)
    );
  }
}

// ==========================================
// LIMPAR TODAS AS INSTÂNCIAS
// ==========================================

async function clearExchangeCache() {
  const instances = Array.from(exchangeInstances);

  const results = await Promise.all(
    instances.map(async exchange => {
      try {
        await closeExchange(exchange);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    })
  );

  exchangeInstances.clear();

  return {
    closed: results.filter(item => item.success).length,
    failed: results.filter(item => !item.success).length
  };
}

// ==========================================
// CORRETORAS SUPORTADAS
// ==========================================

function getSupportedExchanges() {
  return Object.entries(exchangeConfig).map(
    ([exchangeId, settings]) => {
      const supported = isSupported(exchangeId);
      const enabled = settings.enabled === true;

      return {
        id: exchangeId,

        name: settings.name || exchangeId,

        enabled,
        supported,

        available: enabled && supported,

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
// Retorna IDs em formato de array de strings.
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

  const capabilities = exchange.has || {};

  const result = {
    id: exchangeId,

    name:
      exchangeConfig[exchangeId]?.name ||
      exchangeId,

    supported: true,

    enabled: isEnabled(exchangeId),

    available: isEnabled(exchangeId),

    spot: true,

    fetchTicker:
      capabilities.fetchTicker === true,

    fetchTickers:
      capabilities.fetchTickers === true,

    fetchOrderBook:
      capabilities.fetchOrderBook === true,

    watchTicker:
      capabilities.watchTicker === true,

    authenticated: false,

    realOrdersEnabled: false
  };

  // A instância usada para consultar capacidades
  // não é adicionada ao conjunto de conexões ativas.

  return result;
}

// ==========================================
// ESTADO DAS CONEXÕES
// ==========================================

function getActiveExchangeInstances() {
  return exchangeInstances.size;
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

  getActiveExchangeInstances,

  isSupported,
  isEnabled
};
