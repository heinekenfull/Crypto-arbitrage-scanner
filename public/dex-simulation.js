'use strict';
(function () {
  const panel = document.getElementById('dexPanel');
  if (!panel) return;
  const form = document.createElement('div');
  form.className = 'panel';
  form.id = 'dexTradeSimulation';
  form.innerHTML = [
    '<h3>Simulação de compra e venda por tamanho de ordem</h3>',
    '<p class="panel-description">Informe o token, a moeda de cotação e o capital. O sistema consulta duas rotas reais de cotação e calcula o resultado conservador da ida e volta. Nenhuma carteira ou transação é usada.</p>',
    '<div class="dex-network-row">',
    '<div class="control-group"><label for="dexQuoteToken">Contrato da moeda de cotação (USDC / USDT)</label><input id="dexQuoteToken" autocomplete="off" placeholder="Endereço da stablecoin"></div>',
    '<div class="control-group"><label for="dexTradeAmount">Capital de entrada</label><input id="dexTradeAmount" type="number" min="0.000001" step="any" value="100"></div>',
    '<div class="control-group"><label for="dexTokenDecimals">Decimais do token</label><input id="dexTokenDecimals" type="number" min="0" max="18" value="18"></div>',
    '<div class="control-group"><label for="dexQuoteDecimals">Decimais da cotação</label><input id="dexQuoteDecimals" type="number" min="0" max="18" value="6"></div>',
    '<div class="control-group"><label for="dexSlippage">Tolerância de slippage (%)</label><input id="dexSlippage" type="number" min="0.01" max="5" step="0.01" value="0.50"></div>',
    '<button class="primary" id="dexSimulateButton" type="button">SIMULAR IDA E VOLTA</button>',
    '</div>',
    '<div id="dexSimulationStatus" class="empty">Aguardando dados da operação.</div>',
    '<div id="dexSimulationResults" class="dex-summary"></div>',
    '<p class="dex-disclaimer" id="dexSimulationDisclaimer">A taxa de rede pode não estar disponível em todas as redes; nesse caso, o lucro líquido ficará indisponível em vez de inventarmos um valor.</p>'
  ].join('');
  const poolTable = panel.querySelector('.table-wrap');
  if (poolTable) panel.insertBefore(form, poolTable); else panel.appendChild(form);
  const networkSelect = document.getElementById('dexNetwork');
  const tokenInput = document.getElementById('dexTokenAddress');
  const status = document.getElementById('dexSimulationStatus');
  const results = document.getElementById('dexSimulationResults');
  const button = document.getElementById('dexSimulateButton');
  const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const EVM_USDC = { ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913', polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' };
  networkSelect.addEventListener('change', function () {
    document.getElementById('dexQuoteToken').value = networkSelect.value === 'solana' ? SOL_USDC : (EVM_USDC[networkSelect.value] || '');
    document.getElementById('dexTokenDecimals').value = networkSelect.value === 'solana' ? '9' : '18';
    document.getElementById('dexQuoteDecimals').value = '6';
  });
  networkSelect.dispatchEvent(new Event('change'));
  function money(value) { return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }); }
  function card(label, value) { const item = document.createElement('div'); item.className = 'result-item'; const small = document.createElement('small'); small.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; item.append(small, strong); results.appendChild(item); }
  button.addEventListener('click', async function () {
    const network = networkSelect.value;
    const tokenAddress = tokenInput.value.trim();
    const quoteTokenAddress = document.getElementById('dexQuoteToken').value.trim();
    const amount = document.getElementById('dexTradeAmount').value;
    const tokenDecimals = document.getElementById('dexTokenDecimals').value;
    const quoteDecimals = document.getElementById('dexQuoteDecimals').value;
    const slippageBps = Math.round(Number(document.getElementById('dexSlippage').value) * 100);
    if (!tokenAddress || !quoteTokenAddress) { status.textContent = 'Informe o endereço do token e o contrato da moeda de cotação.'; return; }
    button.disabled = true; button.textContent = 'CONSULTANDO ROTAS...'; status.textContent = 'Obtendo cotação de compra e depois cotação de venda...'; results.innerHTML = '';
    try {
      const response = await fetch('/api/dex/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ network, tokenAddress, quoteTokenAddress, amount, tokenDecimals, quoteDecimals, slippageBps }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Falha na simulação.');
      const r = data.result;
      card('Compra estimada (tokens)', Number(data.buy.expectedTokenAmount).toLocaleString('en-US', { maximumFractionDigits: 10 }));
      card('Impacto na compra', data.buy.priceImpact === null ? 'Não informado' : String(data.buy.priceImpact));
      card('Venda estimada (cotação)', money(data.sell.expectedQuoteAmount));
      card('Impacto na venda', data.sell.priceImpact === null ? 'Não informado' : String(data.sell.priceImpact));
      card('Resultado conservador antes do gas', money(r.conservativeProfitBeforeGas));
      card('Retorno conservador', r.conservativeReturnBeforeGasPct.toFixed(4) + '%');
      card('Custo de rede estimado', r.networkFeeUsd === null ? 'Não disponível' : money(r.networkFeeUsd));
      card('Lucro líquido após custos', r.netProfitAfterGas === null ? 'Indisponível sem estimativa de gas' : money(r.netProfitAfterGas));
      card('Lucro líquido (%)', r.netProfitPercentAfterGas === null ? 'Indisponível' : r.netProfitPercentAfterGas.toFixed(4) + '%');
      card('Rota de compra', data.buy.sources.join(', ') || 'Não detalhada');
      card('Rota de venda', data.sell.sources.join(', ') || 'Não detalhada');
      status.textContent = 'Cotações recebidas de ' + data.provider + '. Resultado conservador calculado com a saída mínima das duas pernas.';
      document.getElementById('dexSimulationDisclaimer').textContent = data.explanation + ' Taxa de rede: ' + r.networkFeeStatus + '. Cotação em ' + new Date(data.timestamp).toLocaleString('pt-BR') + '.';
    } catch (error) { status.textContent = 'Não foi possível simular: ' + error.message; }
    finally { button.disabled = false; button.textContent = 'SIMULAR IDA E VOLTA'; }
  });
})();