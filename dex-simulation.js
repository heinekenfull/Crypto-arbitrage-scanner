'use strict';

const express = require('express');
const router = express.Router();

const NETWORKS = {
  ethereum: { chainId: 1, type: 'evm', nativeUsdToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  bsc: { chainId: 56, type: 'evm', nativeUsdToken: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  polygon: { chainId: 137, type: 'evm', nativeUsdToken: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270' },
  arbitrum: { chainId: 42161, type: 'evm', nativeUsdToken: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' },
  base: { chainId: 8453, type: 'evm', nativeUsdToken: '0x4200000000000000000000000000000000000006' },
  solana: { type: 'solana', nativeUsdToken: 'So11111111111111111111111111111111111111112' }
};

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function decimals(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 18) throw new Error(name + ' deve ser um inteiro entre 0 e 18.');
  return n;
}

function toUnits(value, places) {
  const raw = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error('Valor de operação inválido.');
  const parts = raw.split('.');
  const fraction = (parts[1] || '').padEnd(places, '0');
  if (fraction.length > places) throw new Error('O valor possui mais casas decimais que o token permite.');
  return (BigInt(parts[0]) * (10n ** BigInt(places)) + BigInt(fraction || '0')).toString();
}

function fromUnits(raw, places) {
  if (raw === undefined || raw === null) return null;
  const value = BigInt(String(raw));
  const base = 10n ** BigInt(places);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(places, '0').replace(/0+$/, '');
  return Number(fraction ? whole.toString() + '.' + fraction : whole.toString());
}

async function fetchJson(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.reason || body.error || body.message || ('HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function validateAddress(type, address) {
  return type === 'evm'
    ? /^0x[a-fA-F0-9]{40}$/.test(address)
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

async function quoteEvm(network, sellToken, buyToken, sellAmount, slippageBps) {
  if (!process.env.ZERO_EX_API_KEY) {
    const error = new Error('Falta configurar ZERO_EX_API_KEY no ambiente do servidor.');
    error.status = 503;
    throw error;
  }
  const params = new URLSearchParams({
    chainId: String(network.chainId), sellToken, buyToken, sellAmount, slippageBps: String(slippageBps)
  });
  return fetchJson('https://api.0x.org/swap/allowance-holder/price?' + params.toString(), {
    headers: { '0x-api-key': process.env.ZERO_EX_API_KEY, '0x-version': 'v2', accept: 'application/json' }
  });
}

async function quoteSolana(sellToken, buyToken, sellAmount, slippageBps) {
  if (!process.env.JUPITER_API_KEY) {
    const error = new Error('Falta configurar JUPITER_API_KEY no ambiente do servidor.');
    error.status = 503;
    throw error;
  }
  const params = new URLSearchParams({
    inputMint: sellToken, outputMint: buyToken, amount: sellAmount,
    slippageBps: String(slippageBps), restrictIntermediateTokens: 'true'
  });
  return fetchJson('https://api.jup.ag/swap/v1/quote?' + params.toString(), {
    headers: { 'x-api-key': process.env.JUPITER_API_KEY, accept: 'application/json' }
  });
}

function outputAmount(quote) {
  return quote.buyAmount || quote.outAmount || null;
}

function minimumOutput(quote) {
  return quote.minBuyAmount || quote.otherAmountThreshold || outputAmount(quote);
}

function impact(quote) {
  if (quote.estimatedPriceImpact !== undefined) return quote.estimatedPriceImpact;
  if (quote.priceImpactPct !== undefined) return quote.priceImpactPct;
  return null;
}

function sources(quote, provider) {
  if (provider === '0x') return [...new Set((quote.route?.fills || []).map(item => item.source).filter(Boolean))];
  return [...new Set((quote.routePlan || []).map(item => item.swapInfo?.label).filter(Boolean))];
}

function gasNative(quote) {
  const gas = Number(quote.gas || quote.transaction?.gas);
  const gasPrice = Number(quote.gasPrice || quote.transaction?.gasPrice);
  if (Number.isFinite(gas) && gas > 0 && Number.isFinite(gasPrice) && gasPrice > 0) return gas * gasPrice / 1e18;
  const total = Number(quote.totalNetworkFee);
  return Number.isFinite(total) && total > 0 ? total / 1e18 : null;
}

async function nativePriceUsd(networkKey, network) {
  const chain = networkKey === 'solana' ? 'solana' : networkKey;
  const response = await fetchJson('https://api.dexscreener.com/token-pairs/v1/' + chain + '/' +
    encodeURIComponent(network.nativeUsdToken), { headers: { accept: 'application/json' } }, 7000);
  if (!Array.isArray(response)) return null;
  const prices = response.map(pair => Number(pair.priceUsd)).filter(price => Number.isFinite(price) && price > 0);
  return prices.length ? prices[0] : null;
}


const STABLES = {
  ethereum: {
    USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7'
  },
  bsc: {
    USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    USDT: '0x55d398326f99059ff775485246999027b3197955'
  },
  polygon: {
    USDC: '0x3c499c542cef5e3811e1192ce70d8c03d5c3359',
    USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f'
  },
  arbitrum: {
    USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    USDT: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
  },
  base: {
    USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    USDT: '0xfde4c96c8593536e31f229ea8f37b2ad a2699bb2'.replace(/ /g, '')
  },
  solana: {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
  }
};

const AUTO_SCAN_TTL_MS = 90000;
let autoScanCache = { at: 0, data: null };
let autoScanPromise = null;

function dexChainId(networkKey) {
  return networkKey === 'solana' ? 'solana' : networkKey;
}

function normalizeDexPair(pair, networkKey) {
  const base = pair.baseToken || {};
  const quote = pair.quoteToken || {};
  const price = Number(pair.priceUsd);
  const liquidity = Number(pair.liquidity?.usd || 0);
  const volume = Number(pair.volume?.h24 || 0);
  if (!base.address || !quote.address || !Number.isFinite(price) || price <= 0) return null;
  return {
    network: networkKey,
    dexId: String(pair.dexId || 'DEX'),
    pairAddress: pair.pairAddress || '',
    pairUrl: pair.url || '',
    tokenAddress: base.address,
    tokenSymbol: String(base.symbol || 'TOKEN').slice(0, 24),
    tokenName: String(base.name || base.symbol || 'Token').slice(0, 50),
    quoteTokenAddress: quote.address,
    quoteSymbol: String(quote.symbol || '').toUpperCase(),
    tokenPriceUsd: price,
    liquidityUsd: liquidity,
    volume24hUsd: volume,
    priceChange24h: Number(pair.priceChange?.h24 || 0)
  };
}

async function discoverDexOpportunities() {
  if (autoScanCache.data && Date.now() - autoScanCache.at < AUTO_SCAN_TTL_MS) {
    return { ...autoScanCache.data, cached: true };
  }
  if (autoScanPromise) return autoScanPromise;

  autoScanPromise = (async () => {
    const searchResults = [];
    for (const query of ['USDC', 'USDT']) {
      try {
        const data = await fetchJson(
          'https://api.dexscreener.com/latest/dex/search/?q=' + encodeURIComponent(query),
          { headers: { accept: 'application/json' } }, 9000
        );
        if (Array.isArray(data.pairs)) searchResults.push(...data.pairs);
      } catch (error) {
        console.warn('[DEX_AUTO] Busca ' + query + ': ' + error.message);
      }
    }

    let profiles = [];
    try {
      const data = await fetchJson(
        'https://api.dexscreener.com/token-profiles/latest/v1',
        { headers: { accept: 'application/json' } }, 9000
      );
      if (Array.isArray(data)) profiles = data;
    } catch (error) {
      console.warn('[DEX_AUTO] Perfis recentes: ' + error.message);
    }

    const resultsByNetwork = {};
    const networkKeys = Object.keys(NETWORKS);
    for (const networkKey of networkKeys) {
      const stableAddresses = new Set(
        Object.values(STABLES[networkKey]).map(value =>
          NETWORKS[networkKey].type === 'evm' ? value.toLowerCase() : value
        )
      );
      const chain = dexChainId(networkKey);
      const seeds = new Map();

      for (const pair of searchResults) {
        if (String(pair.chainId).toLowerCase() !== chain) continue;
        const quoteAddress = String(pair.quoteToken?.address || '');
        const quoteKey = NETWORKS[networkKey].type === 'evm' ? quoteAddress.toLowerCase() : quoteAddress;
        const baseAddress = String(pair.baseToken?.address || '');
        if (!stableAddresses.has(quoteKey) || !baseAddress) continue;
        const liquidity = Number(pair.liquidity?.usd || 0);
        const old = seeds.get(baseAddress);
        if (!old || liquidity > old.liquidity) seeds.set(baseAddress, { address: baseAddress, liquidity });
      }

      for (const profile of profiles) {
        if (String(profile.chainId).toLowerCase() !== chain || !profile.tokenAddress) continue;
        if (!seeds.has(profile.tokenAddress)) {
          seeds.set(profile.tokenAddress, { address: profile.tokenAddress, liquidity: 0 });
        }
      }

      const selected = [...seeds.values()]
        .sort((a, b) => b.liquidity - a.liquidity)
        .slice(0, 8);

      const pairLists = [];
      let cursor = 0;
      async function worker() {
        while (cursor < selected.length) {
          const item = selected[cursor++];
          try {
            const pairs = await fetchJson(
              'https://api.dexscreener.com/token-pairs/v1/' + chain + '/' + encodeURIComponent(item.address),
              { headers: { accept: 'application/json' } }, 8000
            );
            if (Array.isArray(pairs)) pairLists.push(...pairs);
          } catch (error) {
            console.warn('[DEX_AUTO] ' + networkKey + ' ' + item.address + ': ' + error.message);
          }
        }
      }
      await Promise.all([worker(), worker()]);

      const pools = [];
      const seenPairs = new Set();
      for (const pair of pairLists) {
        if (String(pair.chainId).toLowerCase() !== chain) continue;
        const normalized = normalizeDexPair(pair, networkKey);
        if (!normalized) continue;
        const quoteKey = NETWORKS[networkKey].type === 'evm'
          ? normalized.quoteTokenAddress.toLowerCase()
          : normalized.quoteTokenAddress;
        if (!stableAddresses.has(quoteKey)) continue;
        if (normalized.liquidityUsd < 5000 || normalized.volume24hUsd < 1000) continue;
        const pairKey = normalized.pairAddress || (normalized.tokenAddress + ':' + normalized.quoteTokenAddress + ':' + normalized.dexId);
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        pools.push(normalized);
      }

      const byToken = new Map();
      for (const pool of pools) {
        const key = NETWORKS[networkKey].type === 'evm'
          ? pool.tokenAddress.toLowerCase()
          : pool.tokenAddress;
        if (!byToken.has(key)) byToken.set(key, []);
        byToken.get(key).push(pool);
      }

      const opportunities = [];
      for (const tokenPools of byToken.values()) {
        if (tokenPools.length < 2) continue;
        for (const buy of tokenPools) {
          for (const sell of tokenPools) {
            if (buy.pairAddress === sell.pairAddress || buy.dexId === sell.dexId) continue;
            if (sell.tokenPriceUsd <= buy.tokenPriceUsd) continue;
            const spread = (sell.tokenPriceUsd - buy.tokenPriceUsd) / buy.tokenPriceUsd * 100;
            if (!Number.isFinite(spread) || spread < 0.10 || spread > 20) continue;
            opportunities.push({
              network: networkKey,
              tokenSymbol: buy.tokenSymbol,
              tokenName: buy.tokenName,
              tokenAddress: buy.tokenAddress,
              quoteSymbol: buy.quoteSymbol,
              quoteTokenAddress: buy.quoteTokenAddress,
              buyDex: buy.dexId,
              sellDex: sell.dexId,
              buyPriceUsd: buy.tokenPriceUsd,
              sellPriceUsd: sell.tokenPriceUsd,
              grossSpreadPercent: spread,
              minPoolLiquidityUsd: Math.min(buy.liquidityUsd, sell.liquidityUsd),
              buyVolume24hUsd: buy.volume24hUsd,
              sellVolume24hUsd: sell.volume24hUsd,
              buyPairUrl: buy.pairUrl,
              sellPairUrl: sell.pairUrl,
              status: 'prévia; precisa simular rota e custos'
            });
          }
        }
      }
      opportunities.sort((a, b) =>
        b.grossSpreadPercent - a.grossSpreadPercent ||
        b.minPoolLiquidityUsd - a.minPoolLiquidityUsd
      );
      resultsByNetwork[networkKey] = {
        pools,
        opportunities: opportunities.slice(0, 12),
        tokensDiscovered: selected.length
      };
    }

    const allOpportunities = networkKeys.flatMap(key => resultsByNetwork[key].opportunities)
      .sort((a, b) => b.grossSpreadPercent - a.grossSpreadPercent);
    const data = {
      success: true,
      timestamp: new Date().toISOString(),
      networks: resultsByNetwork,
      opportunities: allOpportunities.slice(0, 50),
      totalPools: networkKeys.reduce((sum, key) => sum + resultsByNetwork[key].pools.length, 0),
      totalOpportunities: allOpportunities.length,
      discovery: 'Universo público descoberto por busca de pares USDC/USDT e perfis recentes do DexScreener; não representa todas as pools existentes.',
      readOnly: true,
      transactionsEnabled: false
    };
    autoScanCache = { at: Date.now(), data };
    return { ...data, cached: false };
  })();

  try {
    return await autoScanPromise;
  } finally {
    autoScanPromise = null;
  }
}

router.get('/auto-scan', async (req, res) => {
  try {
    const data = await discoverDexOpportunities();
    res.json(data);
  } catch (error) {
    console.error('[DEX_AUTO]', error);
    fail(res, 502, error.message || 'Falha na descoberta automática de pools.');
  }
});

router.get('/pools', async (req, res) => {
  try {
    const networkKey = String(req.query.network || '').toLowerCase();
    const network = NETWORKS[networkKey];
    const tokenAddress = String(req.query.tokenAddress || '').trim();
    if (!network) return fail(res, 400, 'Rede não suportada.');
    if (!validateAddress(network.type, tokenAddress)) return fail(res, 400, 'Endereço de token inválido.');
    const chain = dexChainId(networkKey);
    const pairs = await fetchJson(
      'https://api.dexscreener.com/token-pairs/v1/' + chain + '/' + encodeURIComponent(tokenAddress),
      { headers: { accept: 'application/json' } }, 9000
    );
    const pools = (Array.isArray(pairs) ? pairs : [])
      .map(pair => normalizeDexPair(pair, networkKey))
      .filter(Boolean)
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
      .slice(0, 40);
    const prices = pools.map(pool => pool.tokenPriceUsd);
    const low = pools.length ? pools.reduce((a, b) => a.tokenPriceUsd < b.tokenPriceUsd ? a : b) : null;
    const high = pools.length ? pools.reduce((a, b) => a.tokenPriceUsd > b.tokenPriceUsd ? a : b) : null;
    res.json({
      success: true,
      network: { id: networkKey, name: networkKey },
      poolsFound: pools.length,
      pools,
      comparison: {
        lowestPricePool: low,
        highestPricePool: high,
        grossSpreadPercent: low && high && low.tokenPriceUsd > 0
          ? (high.tokenPriceUsd - low.tokenPriceUsd) / low.tokenPriceUsd * 100 : 0
      },
      readOnly: true,
      transactionsEnabled: false
    });
  } catch (error) {
    console.error('[DEX_POOLS]', error);
    fail(res, 502, error.message || 'Falha ao consultar pools.');
  }
});

router.get('/simulation-status', (req, res) => {
  res.json({
    success: true,
    providers: {
      evm: { name: '0x Swap API', configured: Boolean(process.env.ZERO_EX_API_KEY) },
      solana: { name: 'Jupiter', configured: Boolean(process.env.JUPITER_API_KEY) }
    },
    readOnly: true,
    transactionsEnabled: false
  });
});

router.post('/simulate', async (req, res) => {
  try {
    const body = req.body || {};
    const networkKey = String(body.network || '').toLowerCase();
    const network = NETWORKS[networkKey];
    if (!network) return fail(res, 400, 'Rede não suportada para simulação.');

    const tokenAddress = String(body.tokenAddress || '').trim();
    const quoteTokenAddress = String(body.quoteTokenAddress || '').trim();
    if (!validateAddress(network.type, tokenAddress) || !validateAddress(network.type, quoteTokenAddress)) {
      return fail(res, 400, 'Informe endereços válidos para o token e a moeda de cotação.');
    }
    const sameAddress = network.type === 'evm'
      ? tokenAddress.toLowerCase() === quoteTokenAddress.toLowerCase()
      : tokenAddress === quoteTokenAddress;
    if (sameAddress) {
      return fail(res, 400, 'Token e moeda de cotação precisam ser diferentes.');
    }

    const tokenDecimals = decimals(body.tokenDecimals, 'Decimais do token');
    const quoteDecimals = decimals(body.quoteDecimals, 'Decimais da moeda de cotação');
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      return fail(res, 400, 'Capital deve ser maior que zero e menor ou igual a 100 milhões.');
    }
    const slippageBps = Number(body.slippageBps ?? 50);
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) {
      return fail(res, 400, 'Slippage máximo deve ficar entre 1 e 500 bps (0,01% a 5%).');
    }

    const initialUnits = toUnits(body.amount, quoteDecimals);
    const provider = network.type === 'evm' ? '0x' : 'Jupiter';

    const buyQuote = network.type === 'evm'
      ? await quoteEvm(network, quoteTokenAddress, tokenAddress, initialUnits, slippageBps)
      : await quoteSolana(quoteTokenAddress, tokenAddress, initialUnits, slippageBps);

    if (buyQuote.liquidityAvailable === false) return fail(res, 422, 'A rota de compra não possui liquidez suficiente.');
    const boughtUnits = outputAmount(buyQuote);
    if (!boughtUnits || BigInt(boughtUnits) <= 0n) return fail(res, 422, 'O provedor não retornou quantidade válida na compra.');

    const sellInputUnits = minimumOutput(buyQuote);
    const sellQuote = network.type === 'evm'
      ? await quoteEvm(network, tokenAddress, quoteTokenAddress, sellInputUnits, slippageBps)
      : await quoteSolana(tokenAddress, quoteTokenAddress, sellInputUnits, slippageBps);

    if (sellQuote.liquidityAvailable === false) return fail(res, 422, 'A rota de venda não possui liquidez suficiente.');
    const expectedFinalUnits = outputAmount(sellQuote);
    const conservativeFinalUnits = minimumOutput(sellQuote);
    if (!expectedFinalUnits || !conservativeFinalUnits) return fail(res, 422, 'O provedor não retornou quantidade válida na venda.');

    const expectedFinal = fromUnits(expectedFinalUnits, quoteDecimals);
    const conservativeFinal = fromUnits(conservativeFinalUnits, quoteDecimals);
    const expectedProfitBeforeGas = expectedFinal - amount;
    const conservativeProfitBeforeGas = conservativeFinal - amount;
    const expectedReturnBeforeGasPct = expectedProfitBeforeGas / amount * 100;
    const conservativeReturnBeforeGasPct = conservativeProfitBeforeGas / amount * 100;

    let networkFeeNative = null;
    let nativeUsd = null;
    let networkFeeUsd = null;
    let networkFeeStatus = 'não informado pelo provedor';
    if (network.type === 'evm') {
      const buyGas = gasNative(buyQuote);
      const sellGas = gasNative(sellQuote);
      if (buyGas !== null && sellGas !== null) {
        networkFeeNative = buyGas + sellGas;
        nativeUsd = await nativePriceUsd(networkKey, network).catch(() => null);
        if (nativeUsd !== null) {
          networkFeeUsd = networkFeeNative * nativeUsd;
          networkFeeStatus = 'estimado com gas/gasPrice retornados pelo 0x';
        }
      }
    } else {
      nativeUsd = await nativePriceUsd(networkKey, network).catch(() => null);
      if (nativeUsd !== null) {
        networkFeeNative = 0.00001;
        networkFeeUsd = networkFeeNative * nativeUsd;
        networkFeeStatus = 'estimativa da taxa base (5.000 lamports por transação); prioridade não incluída';
      }
    }

    const netProfitAfterGas = networkFeeUsd === null ? null : conservativeProfitBeforeGas - networkFeeUsd;
    const netProfitPercentAfterGas = netProfitAfterGas === null ? null : netProfitAfterGas / amount * 100;

    res.json({
      success: true,
      version: '6.2.0',
      provider,
      network: networkKey,
      tradeAmount: amount,
      quoteCurrencyAssumption: 'Resultado em equivalente USD; use stablecoin pareada ao dólar. O peg não é verificado pelo servidor.',
      tokenDecimals,
      quoteDecimals,
      slippageToleranceBps: slippageBps,
      slippageTolerancePercent: slippageBps / 100,
      buy: {
        expectedTokenAmount: fromUnits(boughtUnits, tokenDecimals),
        minimumTokenAmount: fromUnits(sellInputUnits, tokenDecimals),
        priceImpact: impact(buyQuote),
        sources: sources(buyQuote, provider)
      },
      sell: {
        expectedQuoteAmount: expectedFinal,
        minimumQuoteAmount: conservativeFinal,
        priceImpact: impact(sellQuote),
        sources: sources(sellQuote, provider)
      },
      result: {
        expectedProfitBeforeGas,
        expectedReturnBeforeGasPct,
        conservativeProfitBeforeGas,
        conservativeReturnBeforeGasPct,
        networkFeeNative,
        nativeUsd,
        networkFeeUsd,
        networkFeeStatus,
        netProfitAfterGas,
        netProfitPercentAfterGas,
        feesIncludedInQuotes: true,
        profitableAfterCosts: netProfitAfterGas === null ? null : netProfitAfterGas > 0,
        costsComplete: networkFeeUsd !== null
      },
      timestamp: new Date().toISOString(),
      readOnly: true,
      transactionsEnabled: false,
      explanation: 'Cotação de ida e volta dimensionada pelo capital informado. Taxas de rota estão refletidas nos valores de saída e não são descontadas novamente. O lucro líquido só é informado quando a taxa de rede pode ser estimada.'
    });
  } catch (error) {
    console.error('[DEX_SIMULATION]', error);
    return fail(res, error.status || 502, error.message || 'Falha ao simular rota DEX.');
  }
});

module.exports = { router };
