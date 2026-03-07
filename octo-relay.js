'use strict';

/**
 * OctoRelay – single-file, production-style relay
 * - Persistent upstream Phoenix connection
 * - Event bus
 * - State store (currentFronts + lastFronted + alterSecurity)
 * - History persistence
 * - WebSocket server for clients
 * - Structured logging
 */

const { Socket } = require('phoenix');
const WebSocket = require('ws');
const http = require('http');
const { Redis } = require('@upstash/redis');

// =========================
// Environment & constants
// =========================

const API_KEY = process.env.API_KEY;
const SYSTEM_ID = process.env.SYSTEM_ID;
const LOGGING = process.env.LOGGING;

if (!API_KEY || !SYSTEM_ID) {
  console.error('Missing API_KEY or SYSTEM_ID');
  process.exit(1);
}

const PORT = 3000;
const MAX_ALTERS = 1000;
const MAX_MESSAGE_BYTES = 512 * 1024;

// Reconnect backoff ladder (ms): 2s, 5s, 10s, 30s, 60s
const RECONNECT_DELAYS = [2000, 5000, 10000, 30000, 60000];

// =========================
// Logger
// =========================

function formatLogTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const yyyy = d.getFullYear();

  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const msec = pad(d.getMilliseconds(), 3);

  return `${mm}/${dd}/${yyyy} ${hh}:${min}:${ss}.${msec}`;
}

function log(source, message, data) {
  if (!LOGGING) return;
  const ts = formatLogTimestamp();
  const base = `[${ts}] [${source}] ${message}`;
  if (data !== undefined) {
    try {
      console.log(base, JSON.stringify(data, null, 2));
    } catch {
      console.log(base, data);
    }
  } else {
    console.log(base);
  }
}

// =========================
// Simple event bus
// =========================

const listeners = new Map();

function on(eventName, fn) {
  if (!listeners.has(eventName)) listeners.set(eventName, new Set());
  listeners.get(eventName).add(fn);
}

async function emit(eventName, payload) {
  const set = listeners.get(eventName);
  if (!set) return;
  for (const fn of set) {
    try {
      await fn(payload);
    } catch (e) {
      log('EVENT', `Handler error for ${eventName}`, { error: String(e) });
    }
  }
}

// =========================
// LRU cache for alters
// =========================

class LRUMap {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      log('LRU', 'Evicting oldest alter from cache', { oldest });
      this.map.delete(oldest);
    }
  }
  get(key) {
    return this.map.get(key);
  }
}

const lastFronted = new Map();
const currentFronts = new Map();
const alterSecurity = new LRUMap(MAX_ALTERS);

// =========================
// Upstash Redis client
// =========================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const REDIS_KEY = 'octo:lastFronted';

// =========================
// State store
// =========================

const systemStatus = {
  upstreamConnected: false,
  channelJoined: false,
};

// =========================
// History persistence
// =========================

async function loadHistory() {
  try {
    const obj = await redis.hgetall(REDIS_KEY);
    if (obj) {
      for (const [id, ts] of Object.entries(obj)) {
        if (typeof ts === 'string') lastFronted.set(id, ts);
      }
    }
    log('HISTORY', `Loaded ${lastFronted.size} entries from Redis`);
  } catch (e) {
    log('HISTORY', 'Failed to load history from Redis, starting fresh', { error: String(e) });
  }
}

async function saveHistory(alterId, ts) {
  try {
    await redis.hset(REDIS_KEY, { [alterId]: ts });
    log('HISTORY', `Saved entry to Redis`, { alterId, ts });
  } catch (e) {
    log('ERROR', 'Failed to save history to Redis', { error: String(e) });
  }
}

async function updateLastFronted(alterId, front) {
  const ts = front.time_end ?? front.time_start;
  if (!ts) return;

  if (front.time_end) {
    if (lastFronted.get(alterId) === front.time_end) return;
    lastFronted.set(alterId, front.time_end);
    await saveHistory(alterId, front.time_end);
    return;
  }

  if (lastFronted.get(alterId) === front.time_start) return;
  lastFronted.set(alterId, front.time_start);
  await saveHistory(alterId, front.time_start);
}

// =========================
// Sanitization
// =========================

function sanitizeFront(f) {
  if (!f?.alter?.id || !f.front) return null;

  const sec = alterSecurity.get(f.alter.id)?.security_level;
  // Allow public, trusted_only, friends_only; block private and unknown
  if (!sec || sec === 'private') return null;

  return {
    primary: !!f.primary,
    alter: {
      id: f.alter.id,
      name: f.alter.name,
      color: f.alter.color,
    },
    front: {
      id: f.front.id,
      comment: f.front.comment,
      time_start: f.front.time_start,
      time_end: f.front.time_end,
    },
  };
}

// =========================
// Fronting state machine
// =========================

function handleFrontsSnapshot(fronts) {
  currentFronts.clear();
  for (const f of fronts) currentFronts.set(f.alter.id, f);
}

function handleFrontingStarted(payload) {
  const f = payload?.front;
  if (!f) return;
  currentFronts.set(f.alter.id, f);
}

function handleFrontUpdated(payload) {
  const f = payload?.front;
  if (!f) return;
  currentFronts.set(f.alter.id, f);
}

function handleFrontingEnded(payload) {
  const alterId = payload?.alter_id;
  if (!alterId) return;

  currentFronts.delete(alterId);

  const time_end =
    payload?.front?.time_end ||
    payload?.time_end ||
    new Date().toISOString();

  updateLastFronted(alterId, { time_end });

  emit('broadcast', {
    type: 'last_fronted_update',
    alter_id: alterId,
    timestamp: time_end,
  });
}

function handlePrimaryFront(payload) {
  const alterId = payload?.alter_id;
  if (!alterId) return;

  const sec = alterSecurity.get(alterId)?.security_level;
  if (!sec || sec === 'private') return;

  for (const f of currentFronts.values()) f.primary = false;
  const entry = currentFronts.get(alterId);
  if (entry) entry.primary = true;
}

// =========================
// Upstream (Phoenix) connection
// =========================

let upstreamSocket = null;
let upstreamChannel = null;

// ── Reconnect manager ──────────────────────────────────────────────────────
// Single source of truth for reconnection. All paths that want a reconnect
// call scheduleReconnect(). A pending timer means one is already queued —
// nothing else will fire until it runs. This eliminates the race between the
// watchdog, onClose, and onError all calling setupUpstream() simultaneously.

let reconnectTimer = null;
let reconnectAttempt = 0;

function scheduleReconnect() {
  // Already waiting — don't stack another timer
  if (reconnectTimer !== null) return;

  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  log('RECONNECT', `Scheduling reconnect attempt ${reconnectAttempt} in ${delay}ms`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    setupUpstream();
  }, delay);
}

function resetReconnectBackoff() {
  reconnectAttempt = 0;
}

// ── Tear down the current socket/channel cleanly ───────────────────────────
// We null out upstreamChannel BEFORE disconnecting so that the onClose /
// onError callbacks that fire during disconnect see null and bail out
// instead of scheduling yet another reconnect.

function teardownUpstream() {
  const chan = upstreamChannel;
  const sock = upstreamSocket;

  upstreamChannel = null;
  upstreamSocket = null;

  systemStatus.upstreamConnected = false;
  systemStatus.channelJoined = false;

  if (chan) {
    try { chan.leave(); } catch { }
  }
  if (sock) {
    try { sock.disconnect(); } catch { }
  }
}

// ── Build and connect ──────────────────────────────────────────────────────

function setupUpstream() {
  // Defensive: tear down anything still lingering
  teardownUpstream();

  const socket = new Socket('wss://api.octocon.app/api/socket', {
    params: { token: API_KEY },
    transport: WebSocket,
    heartbeatIntervalMs: 30000,
    // Let Phoenix handle its own internal reconnects at the socket level;
    // we manage channel-level reconnects ourselves below.
    reconnectAfterMs: () => 10000,
  });

  socket.onOpen(() => {
    systemStatus.upstreamConnected = true;
    log('UPSTREAM', 'Socket connected');
  });

  socket.onClose(() => {
    // Only act if this is still the active socket (not one we already replaced)
    if (upstreamSocket !== socket) return;
    systemStatus.upstreamConnected = false;
    systemStatus.channelJoined = false;
    log('UPSTREAM', 'Socket closed — scheduling reconnect');
    teardownUpstream();
    scheduleReconnect();
  });

  socket.onError(err => {
    if (upstreamSocket !== socket) return;
    log('UPSTREAM', 'Socket error — scheduling reconnect', { err: String(err) });
    teardownUpstream();
    scheduleReconnect();
  });

  socket.connect();
  upstreamSocket = socket;

  // ── Channel ──────────────────────────────────────────────────────────────

  const channel = socket.channel(`system:${SYSTEM_ID}`, { token: API_KEY });

  channel
    .join()
    .receive('ok', resp => {
      // Guard: ignore if we've already moved on to a new connection
      if (upstreamChannel !== channel) return;

      systemStatus.channelJoined = true;
      resetReconnectBackoff();
      log('UPSTREAM', 'Channel joined');

      if (Array.isArray(resp?.alters)) {
        for (const a of resp.alters) {
          if (a?.id && a.security_level !== 'private') {
            alterSecurity.set(a.id, {
              security_level: a.security_level,
              name: a.name,
              color: a.color,
            });
          }
        }
      }

      if (Array.isArray(resp?.fronts)) {
        for (const f of resp.fronts) {
          if (f?.alter?.id && f.front) {
            updateLastFronted(f.alter.id, f.front);
          }
        }

        const frontsOnly = resp.fronts.map(sanitizeFront).filter(Boolean);
        handleFrontsSnapshot(frontsOnly);

        emit('broadcast', {
          type: 'fronts_snapshot',
          fronts: frontsOnly,
        });
      }
    })
    .receive('error', err => {
      if (upstreamChannel !== channel) return;
      log('UPSTREAM', 'Channel join error — scheduling reconnect', { err: String(err) });
      teardownUpstream();
      scheduleReconnect();
    })
    .receive('timeout', () => {
      if (upstreamChannel !== channel) return;
      log('UPSTREAM', 'Channel join timeout — scheduling reconnect');
      teardownUpstream();
      scheduleReconnect();
    });

  channel.on('fronting_started', p => forwardEvent('fronting_started', p));
  channel.on('fronting_ended',   p => forwardEvent('fronting_ended',   p));
  channel.on('front_updated',    p => forwardEvent('front_updated',    p));
  channel.on('primary_front',    p => forwardEvent('primary_front',    p));

  channel.onClose(() => {
    if (upstreamChannel !== channel) return;
    log('UPSTREAM', 'Channel closed — scheduling reconnect');
    systemStatus.channelJoined = false;
    teardownUpstream();
    scheduleReconnect();
  });

  channel.onError(err => {
    if (upstreamChannel !== channel) return;
    log('UPSTREAM', 'Channel error — scheduling reconnect', { err: String(err) });
    systemStatus.channelJoined = false;
    teardownUpstream();
    scheduleReconnect();
  });

  upstreamChannel = channel;
}

// =========================
// Forward upstream events
// =========================

function forwardEvent(event, payload) {
  if (event === 'fronting_started' || event === 'front_updated') {
    const raw = payload?.front;

    if (raw?.alter?.id && raw.front) {
      updateLastFronted(raw.alter.id, raw.front);
    }

    const sanitized = sanitizeFront(payload.front);
    if (!sanitized) return;

    const safePayload = { ...payload, front: sanitized };

    if (event === 'fronting_started') handleFrontingStarted(safePayload);
    else handleFrontUpdated(safePayload);

    emit('broadcast', { type: event, payload: safePayload });
    return;
  }

  if (event === 'fronting_ended') {
    handleFrontingEnded(payload);
    emit('broadcast', { type: event, payload });
    return;
  }

  if (event === 'primary_front') {
    const alterId = payload?.alter_id;
    if (!alterId) return;

    const sec = alterSecurity.get(alterId)?.security_level;
    if (!sec || sec === 'private') return;

    handlePrimaryFront(payload);
    emit('broadcast', { type: event, payload });
    return;
  }
}

// =========================
// Upstream watchdog
// =========================
// The watchdog is now a last-resort safety net only. Normal reconnection is
// handled by the socket/channel callbacks above. The watchdog only fires if
// somehow both flags are false AND no reconnect is already scheduled.

setInterval(() => {
  if (reconnectTimer !== null) return; // reconnect already queued

  if (!systemStatus.upstreamConnected || !systemStatus.channelJoined) {
    log('WATCHDOG', 'Unhealthy state detected — scheduling reconnect');
    scheduleReconnect();
  }
}, 15_000);

// =========================
// HTTP + WebSocket server
// =========================

const httpServer = http.createServer((req, res) => {
  // /health – simple liveness check (matches original sp-relay)
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // /status – full diagnostic info
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      upstreamConnected: systemStatus.upstreamConnected,
      channelJoined: systemStatus.channelJoined,
      currentFronts: currentFronts.size,
      lastFronted: lastFronted.size,
      reconnectAttempt,
      reconnectPending: reconnectTimer !== null,
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const server = new WebSocket.Server({
  server: httpServer,
  perMessageDeflate: false,
  maxPayload: MAX_MESSAGE_BYTES,
});

const connections = new Set();

function safeSend(client, obj) {
  try {
    const out = JSON.stringify(obj);
    if (Buffer.byteLength(out) > MAX_MESSAGE_BYTES) return;
    client.send(out);
  } catch { }
}

on('broadcast', msg => {
  let out;

  if (msg.type === 'fronts_snapshot') {
    out = { event: 'fronts_snapshot', fronts: msg.fronts };
  } else if (msg.type === 'last_fronted_update') {
    out = {
      event: 'last_fronted_update',
      alter_id: msg.alter_id,
      timestamp: msg.timestamp,
    };
  } else {
    out = { event: msg.type, payload: msg.payload };
  }

  for (const ctx of connections) safeSend(ctx.client, out);
});

server.on('connection', client => {
  const ctx = { client };
  connections.add(ctx);

  const fronts = Array.from(currentFronts.values());
  safeSend(client, { event: 'fronts_snapshot', fronts });

  client.on('message', msg => {
    let parsed;
    try { parsed = JSON.parse(msg); } catch { return; }

    if (parsed.event === 'get_last_fronted_all') {
      safeSend(client, {
        event: 'last_fronted_all',
        history: Object.fromEntries(lastFronted.entries()),
      });
    }

    if (parsed.event === 'get_current_fronts') {
      safeSend(client, {
        event: 'current_fronts',
        fronts: Array.from(currentFronts.values()),
      });
    }
  });

  client.on('close', () => {
    connections.delete(ctx);
  });

  client.on('error', () => {
    connections.delete(ctx);
    try { client.close(); } catch { }
    try { client.terminate(); } catch { }
  });
});

httpServer.listen(PORT);

// =========================
// Startup & shutdown
// =========================

loadHistory().then(() => setupUpstream());

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
