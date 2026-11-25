'use strict';

const WebSocket = require('ws');

const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const CACHE_TTL_MS = 900;
const CONNECT_TIMEOUT_MS = 5000;
const MAX_SUBSCRIPTIONS = 80;

let socket = null;
let connecting = null;
let pingTimer = null;
let reconnectTimer = null;
const books = new Map();
const pending = new Map();
const subscribed = new Set();

function normalizeInstId(symbol) {
  return String(symbol || '').replace('/', '-').replace(':', '-');
}

function stopTimers() {
  if (pingTimer) clearInterval(pingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  pingTimer = null;
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnected().catch(() => {});
  }, 1800);
  reconnectTimer.unref?.();
}

function rejectPending(message) {
  for (const [instId, waiters] of pending) {
    pending.delete(instId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
  }
}

function ensureConnected() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(socket);
  }
  if (connecting) return connecting;

  connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      perMessageDeflate: false
    });
    socket = ws;
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error('Timeout conectando ao WebSocket público OKX.'));
    }, CONNECT_TIMEOUT_MS);

    ws.once('open', () => {
      clearTimeout(timer);
      pingTimer = setInterval(() => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        try { ws.send('ping'); } catch (_) {}
      }, 25000);
      pingTimer.unref?.();
      resolve(ws);
    });

    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.event === 'error') {
        console.warn('[OKX-WS] Erro de assinatura:', message.msg || message.code);
        return;
      }
      const data = message.data;
      if (!Array.isArray(data) || !data.length) return;
      const instId = message.arg?.instId || data[0]?.instId;
      if (!instId) return;

      const item = data[data.length - 1];
      const asks = Array.isArray(item.asks) ? item.asks : [];
      const bids = Array.isArray(item.bids) ? item.bids : [];
      if (!asks.length || !bids.length) return;

      const book = {
        asks: asks.map(level => [Number(level[0]), Number(level[1])]),
        bids: bids.map(level => [Number(level[0]), Number(level[1])]),
        timestamp: Number(item.ts) || Date.now(),
        nonce: item.seqId ?? null,
        _receivedAt: Date.now(),
        _source: 'okx-public-websocket'
      };
      books.set(instId, book);

      const waiters = pending.get(instId);
      if (waiters?.length) {
        pending.delete(instId);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve({ ...book, asks: book.asks.slice(), bids: book.bids.slice() });
        }
      }
    });

    ws.on('close', () => {
      if (socket === ws) socket = null;
      stopTimers();
      subscribed.clear();
      rejectPending('WebSocket OKX desconectado antes de receber o livro.');
      scheduleReconnect();
    });

    ws.on('error', error => {
      clearTimeout(timer);
      rejectPending(error.message || 'Falha no WebSocket OKX.');
      if (socket === ws) socket = null;
      try { ws.terminate(); } catch (_) {}
      reject(error);
    });
  }).finally(() => { connecting = null; });

  return connecting;
}

async function getOkxOrderBook(symbol, timeoutMs = 2500) {
  const instId = normalizeInstId(symbol);
  if (!instId) throw new Error('Símbolo inválido para o feed OKX.');

  const cached = books.get(instId);
  if (cached && Date.now() - cached._receivedAt <= CACHE_TTL_MS) {
    return { ...cached, asks: cached.asks.slice(), bids: cached.bids.slice() };
  }

  const ws = await ensureConnected();
  if (subscribed.size >= MAX_SUBSCRIPTIONS && !subscribed.has(instId)) {
    throw new Error('Limite local de inscrições OKX atingido; usar REST.');
  }

  if (!subscribed.has(instId)) {
    ws.send(JSON.stringify({
      op: 'subscribe',
      args: [{ channel: 'books5', instId }]
    }));
    subscribed.add(instId);
  }

  return new Promise((resolve, reject) => {
    const waiters = pending.get(instId) || [];
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const current = pending.get(instId) || [];
        const remaining = current.filter(entry => entry !== waiter);
        if (remaining.length) pending.set(instId, remaining);
        else pending.delete(instId);
        reject(new Error('Timeout aguardando snapshot books5 da OKX.'));
      }, Math.max(500, timeoutMs))
    };
    pending.set(instId, [...waiters, waiter]);
  });
}

function getOkxWsStatus() {
  return {
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
    subscribedSymbols: subscribed.size,
    cachedBooks: books.size,
    source: 'public-books5'
  };
}

module.exports = { getOkxOrderBook, getOkxWsStatus };
