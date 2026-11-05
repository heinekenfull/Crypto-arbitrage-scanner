'use strict';

// Lightweight online market-pattern engine.
// It ranks observed opportunities; it never creates trades or changes math validation.
const fs = require('fs');
const path = require('path');

const MAX_KEYS = 600;
const MAX_OBSERVATIONS = 24;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const historyFile = process.env.AI_HISTORY_FILE || null;
const patterns = new Map();
let scansObserved = 0;
let lastUpdated = null;

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function keyOf(item) {
  return [item.symbol, item.buyExchangeId, item.sellExchangeId].join('|').toUpperCase();
}
function compact(item) {
  return {
    at: Date.now(),
    net: finite(item.estimatedNetPercent),
    gross: finite(item.grossSpreadPercent),
    validated: item.status === 'validated',
    present: true,
    slippage: finite(item.simulations?.[0]?.slippagePercent, -1),
    liquidity: finite(item.simulations?.[0]?.filledPercent, -1)
  };
}
function load() {
  if (!historyFile) return;
  try {
    const stat = fs.statSync(historyFile);
    if (stat.size > MAX_FILE_BYTES) return;
    const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (!data || !Array.isArray(data.entries)) return;
    scansObserved = Math.max(0, finite(data.scansObserved));
    lastUpdated = data.lastUpdated || null;
    for (const entry of data.entries.slice(-MAX_KEYS)) {
      if (entry && typeof entry.key === 'string' && Array.isArray(entry.observations)) {
        patterns.set(entry.key, entry.observations.slice(-MAX_OBSERVATIONS));
      }
    }
  } catch (_) { /* First run or unavailable persistent disk. */ }
}
function persist() {
  if (!historyFile) return;
  try {
    const dir = path.dirname(historyFile);
    fs.mkdirSync(dir, { recursive: true });
    const entries = Array.from(patterns.entries()).map(([key, observations]) => ({ key, observations }));
    const temp = historyFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ scansObserved, lastUpdated, entries }));
    fs.renameSync(temp, historyFile);
  } catch (error) {
    console.warn('[AI] Histórico não persistido:', error.message);
  }
}
function scorePattern(observations) {
  const recent = observations.slice(-MAX_OBSERVATIONS);
  const count = recent.length;
  const avg = recent.reduce((s, x) => s + x.net, 0) / Math.max(1, count);
  const positive = recent.filter(x => x.net > 0).length / Math.max(1, count);
  const validated = recent.filter(x => x.validated).length / Math.max(1, count);
  const values = recent.map(x => x.net);
  const variance = values.reduce((s, x) => s + Math.pow(x - avg, 2), 0) / Math.max(1, count);
  const volatility = Math.sqrt(variance);
  const stability = Math.max(0, 1 - Math.min(1, volatility / Math.max(0.25, Math.abs(avg) + 0.25)));
  const score = Math.round(Math.max(0, Math.min(100,
    15 + Math.min(25, count * 3) + positive * 25 + validated * 25 + stability * 10
  )));
  const confidence = count < 3 ? 'baixa' : count < 8 ? 'moderada' : 'maior';
  const reasons = [];
  if (count >= 3) reasons.push('padrão recorrente em ' + count + ' leituras');
  else reasons.push('pouco histórico disponível');
  const presence = recent.filter(x => x.present !== false).length / Math.max(1, count);
  if (positive >= 0.7) reasons.push('margens positivas frequentes');
  if (presence < 0.7 && count >= 3) reasons.push('oportunidade aparece de forma intermitente');
  if (validated >= 0.5) reasons.push('validação por livro em parte das leituras');
  if (stability >= 0.7 && count >= 3) reasons.push('spread relativamente estável');
  if (volatility > 1) reasons.push('grande oscilação observada');
  return { score, confidence, observations: count, averageNetPercent: Number(avg.toFixed(4)),
    positiveRatePercent: Number((positive * 100).toFixed(1)),
    presenceRatePercent: Number((presence * 100).toFixed(1)),
    validatedRatePercent: Number((validated * 100).toFixed(1)),
    volatilityPercent: Number(volatility.toFixed(4)), reasons };
}
function observeScan(result) {
  if (!result || result.success !== true || result.isPreliminary) return getInsights();
  scansObserved += 1;
  lastUpdated = new Date().toISOString();
  const seen = new Set();
  for (const item of (result.opportunities || [])) {
    if (!item || !item.symbol || !item.buyExchangeId || !item.sellExchangeId) continue;
    const key = keyOf(item);
    seen.add(key);
    let observations = patterns.get(key);
    if (!observations) observations = [];
    observations.push(compact(item));
    if (observations.length > MAX_OBSERVATIONS) observations = observations.slice(-MAX_OBSERVATIONS);
    patterns.set(key, observations);
  }
  // A missing pair is also a learning signal: it prevents the model from
  // treating an old spread as continuously available after it disappears.
  for (const [key, existing] of patterns.entries()) {
    if (seen.has(key)) continue;
    existing.push({ at: Date.now(), net: 0, gross: 0, validated: false, present: false, slippage: -1, liquidity: -1 });
    if (existing.length > MAX_OBSERVATIONS) existing.splice(0, existing.length - MAX_OBSERVATIONS);
  }
  // Bound memory even if the market presents thousands of unique pairs.
  while (patterns.size > MAX_KEYS) patterns.delete(patterns.keys().next().value);
  persist();
  return getInsights(result.opportunities || []);
}
function getInsights(current = []) {
  const rows = [];
  for (const item of current) {
    const observations = patterns.get(keyOf(item)) || [];
    const analysis = scorePattern(observations);
    rows.push({
      symbol: item.symbol, buyExchangeId: item.buyExchangeId, sellExchangeId: item.sellExchangeId,
      ...analysis, currentNetPercent: finite(item.estimatedNetPercent),
      status: item.status || 'candidate'
    });
  }
  rows.sort((a, b) => b.score - a.score || b.currentNetPercent - a.currentNetPercent);
  return {
    enabled: true, engine: 'lightweight-online-patterns', scansObserved,
    trackedPatterns: patterns.size, lastUpdated, persistence: historyFile ? 'configured-file' : 'memory-only',
    disclaimer: 'Pontuação baseada somente em histórico observado. Não é previsão garantida nem substitui livro, taxas, slippage ou validação matemática.',
    top: rows.slice(0, 20)
  };
}
load();
module.exports = { observeScan, getInsights };
