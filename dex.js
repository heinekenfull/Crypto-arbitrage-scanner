const axios = require('axios');
const config = require('./config');

const API_BASE = 'https://api.geckoterminal.com/api/v2';
const CACHE_TTL_MS = Number(config.DEX?.CACHE_TTL_MS || 60000);
const MIN_LIQUIDITY_USD = Number(config.DEX?.MIN_LIQUIDITY_USD || 10000);
const MAX_POOLS_PER_NETWORK = Number(config.DEX?.MAX_POOLS_PER_NETWORK || 20);

const NETWORKS = config.DEX?.NETWORKS || [
  { id: 'eth', name: 'Ethereum' },
  { id: 'bsc', name: 'BNB Chain' },
  { id: 'polygon_pos', name: 'Polygon' },
  { id: 'arbitrum', name: 'Arbitrum' },
  { id: 'optimism', name: 'Optimism' },
  { id: 'base', name: 'Base' },
  { id: 'avax', name: 'Avalanche' },
  { id: 'solana', name: 'Solana' }
];

let cachedResult = null;
let cachedAt = 0;
let scanInProgress = false;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relationshipId(resource, name) {
  return resource?.relationships?.[name]?.data?.id || null;
}

function shortAddress(value) {
  if (!value) return null;
  const parts = String(value).split('_');
  return parts.length > 1 ? parts.slice(1).join('_') : String(value);
}

async function fetchNetworkPools(network) {
  const url = API_BASE + '/networks/' +
    encodeURIComponent(network.id) +
    '/trending_pools?include=base_token,quote_token,dex';

  const response = await axios.get(url, {
    timeout: 9000,
    headers: {
      Accept: 'application/json;version=20230203'
    },
    params: { page: 1 }
  });

  const payload = response.data || {};
  const included = new Map(
    (payload.included || []).map(item => [item.id, item])
  );

  const pools = (payload.data || []).map(pool => {
    const attrs = pool.attributes || {};
    const baseId = relationshipId(pool, 'base_token');
    const quoteId = relationshipId(pool, 'quote_token');
    const dexId = relationshipId(pool, 'dex');
    const base = included.get(baseId)?.attributes || {};
    const quote = included.get(quoteId)?.attributes || {};
    const dex = included.get(dexId)?.attributes || {};

    return {
      networkId: network.id,
      network: network.name,
      poolAddress: attrs.address || shortAddress(pool.id),
      poolName: attrs.name || 'Pool sem nome',
      dexId: dexId || null,
      dex: dex.name || dexId || 'DEX não identificada',
      baseTokenAddress: base.address || shortAddress(baseId),
      baseToken: base.symbol || String(attrs.name || '').split('/')[0]?.trim() || 'TOKEN',
      quoteToken: quote.symbol || String(attrs.name || '').split('/')[1]?.trim() || '',
      baseTokenPriceUsd: num(attrs.base_token_price_usd),
      quoteTokenPriceUsd: num(attrs.quote_token_price_usd),
      liquidityUsd: num(attrs.reserve_in_usd),
      volume24hUsd: num(attrs.volume_usd?.h24),
      priceChange24h: num(attrs.price_change_percentage?.h24),
      transactions24h: num(attrs.transactions?.h24?.buys) +
        num(attrs.transactions?.h24?.sells),
      url: 'https://www.geckoterminal.com/' + network.id +
        '/pools/' + (attrs.address || shortAddress(pool.id))
    };
  }).filter(pool =>
    pool.poolAddress &&
    pool.baseTokenPriceUsd > 0 &&
    pool.liquidityUsd >= MIN_LIQUIDITY_USD
  );

  pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);

  return {
    networkId: network.id,
    network: network.name,
    success: true,
    pools: pools.slice(0, MAX_POOLS_PER_NETWORK),
    poolsReceived: (payload.data || []).length
  };
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;

      try {
        results[index] = await callback(items[index]);
      } catch (error) {
        results[index] = {
          networkId: items[index].id,
          network: items[index].name,
          success: false,
          error: error.response?.status === 429
            ? 'Limite temporário da API DEX (HTTP 429). Aguarde e tente novamente.'
            : error.message || 'Falha ao consultar pools.'
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker()
    )
  );

  return results;
}

function calculateIndicativeSpreads(pools) {
  const groups = new Map();

  for (const pool of pools) {
    if (!pool.baseTokenAddress) continue;

    const key = pool.networkId + ':' +
      pool.baseTokenAddress.toLowerCase();

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pool);
  }

  const spreads = [];

  for (const entries of groups.values()) {
    if (entries.length < 2) continue;

    entries.sort((a, b) =>
      a.baseTokenPriceUsd - b.baseTokenPriceUsd
    );

    const low = entries[0];
    const high = entries[entries.length - 1];

    if (low.dexId === high.dexId) continue;
    if (low.baseTokenPriceUsd <= 0) continue;

    const spreadPercent =
      ((high.baseTokenPriceUsd - low.baseTokenPriceUsd) /
        low.baseTokenPriceUsd) * 100;

    if (!Number.isFinite(spreadPercent) || spreadPercent <= 0) continue;

    spreads.push({
      network: low.network,
      networkId: low.networkId,
      token: low.baseToken,
      tokenAddress: low.baseTokenAddress,
      lowerDex: low.dex,
      higherDex: high.dex,
      lowerPriceUsd: low.baseTokenPriceUsd,
      higherPriceUsd: high.baseTokenPriceUsd,
      indicativeSpreadPercent: spreadPercent,
      lowerPoolLiquidityUsd: low.liquidityUsd,
      higherPoolLiquidityUsd: high.liquidityUsd,
      lowerPoolAddress: low.poolAddress,
      higherPoolAddress: high.poolAddress,
      executable: false,
      warning: 'Diferença indicativa entre pools; não considera cotação de swap, impacto de preço, gas ou MEV.'
    });
  }

  return spreads.sort(
    (a, b) => b.indicativeSpreadPercent - a.indicativeSpreadPercent
  ).slice(0, 100);
}

async function scanDexMarkets() {
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { ...cachedResult, cached: true };
  }

  if (scanInProgress) {
    if (cachedResult) return { ...cachedResult, cached: true, scanInProgress: true };
    return {
      success: false,
      busy: true,
      message: 'A consulta DEX já está em andamento.'
    };
  }

  scanInProgress = true;
  const startedAt = Date.now();

  try {
    // Duas redes por vez: oito chamadas por ciclo, com intervalo mínimo
    // de 60 segundos para respeitar o limite da API pública.
    const networkResults = await mapWithConcurrency(
      NETWORKS,
      2,
      fetchNetworkPools
    );

    const pools = networkResults
      .filter(result => result.success)
      .flatMap(result => result.pools);

    const spreads = calculateIndicativeSpreads(pools);

    const result = {
      success: true,
      mode: 'DEX',
      provider: 'GeckoTerminal',
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      networksConfigured: NETWORKS.length,
      networksConnected: networkResults.filter(item => item.success).length,
      totalPools: pools.length,
      totalIndicativeSpreads: spreads.length,
      executableOpportunities: 0,
      networks: networkResults.map(item => ({
        id: item.networkId,
        name: item.network,
        success: item.success,
        pools: item.pools?.length || 0,
        error: item.error || null
      })),
      pools,
      indicativeSpreads: spreads,
      simulationEnabled: false,
      realOrdersEnabled: false,
      disclaimer: 'Monitoramento informativo. Preços de pools não são cotações executáveis; nenhuma rentabilidade ou ordem é garantida.'
    };

    cachedResult = result;
    cachedAt = Date.now();

    return result;
  } finally {
    scanInProgress = false;
  }
}

function getDexStatus() {
  return {
    enabled: true,
    mode: 'DEX',
    provider: 'GeckoTerminal',
    networks: NETWORKS,
    cacheTtlMs: CACHE_TTL_MS,
    minLiquidityUsd: MIN_LIQUIDITY_USD,
    simulationEnabled: false,
    realOrdersEnabled: false,
    lastScanAt: cachedResult?.timestamp || null,
    scanInProgress
  };
}

module.exports = {
  scanDexMarkets,
  getDexStatus,
  NETWORKS
};
