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
    const sameAddress = network.type === 'evm'\n      ? tokenAddress.toLowerCase() === quoteTokenAddress.toLowerCase()\n      : tokenAddress === quoteTokenAddress;\n    if (sameAddress) {
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
      tradeAmount: amount,\n      quoteCurrencyAssumption: 'Resultado em equivalente USD; use stablecoin pareada ao dólar. O peg não é verificado pelo servidor.',
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
