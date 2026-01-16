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
const fs = require('fs');
const path = require('path');

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
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');
const MAX_ALTERS = 1000;
const MAX_MESSAGE_BYTES = 512 * 1024;

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

// =========================
// State store
// =========================

const lastFronted = new Map();
const currentFronts = new Map();
const alterSecurity = new LRUMap(MAX_ALTERS);

const systemStatus = {
  upstreamConnected: false,
  channelJoined: false,
};

// =========================
// History persistence
// =========================

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [id, ts] of Object.entries(obj)) {
      if (typeof ts === 'string') lastFronted.set(id, ts);
    }
    log('HISTORY', `Loaded ${lastFronted.size} entries`);
  } catch (e) {
    log('HISTORY', 'No history file found or failed to parse, starting fresh', { error: String(e) });
  }
}

function saveHistory(alterId, ts) {
  const obj = Object.fromEntries(lastFronted.entries());
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj, null, 2), 'utf8');
    log('HISTORY', `Saved ${Object.keys(obj).length} entries`, { alterId, ts });
  } catch (e) {
    log('ERROR', 'Failed to write history file', { error: String(e) });
  }
}

function updateLastFronted(alterId, front) {
  // Prefer time_end, but ONLY if it exists.
  const ts = front.time_end ?? front.time_start;
  if (!ts) return;

  // If time_end exists, ignore time_start entirely.
  if (front.time_end) {
    // If we already saved this exact time_end, skip.
    if (lastFronted.get(alterId) === front.time_end) return;
    lastFronted.set(alterId, front.time_end);
    return saveHistory(alterId, front.time_end);
  }

  // Only reach here if NO time_end exists.
  // Now we allow time_start updates.
  if (lastFronted.get(alterId) === front.time_start) return;
  lastFronted.set(alterId, front.time_start);
  saveHistory(alterId, front.time_start);
}

// =========================
// Sanitization
// =========================

function sanitizeFront(f) {
  if (!f?.alter?.id || !f.front) return null;

  const sec = alterSecurity.get(f.alter.id)?.security_level;
  if (sec !== 'public') return null;

  return {
    primary: !!f.primary,
    alter: { id: f.alter.id, name: f.alter.name, color: f.alter.color },
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
  const sanitized = sanitizeFront(payload.front);
  if (!sanitized) return;
  currentFronts.set(sanitized.alter.id, sanitized);
  updateLastFronted(sanitized.alter.id, sanitized.front);
}

function handleFrontUpdated(payload) {
  const sanitized = sanitizeFront(payload.front);
  if (!sanitized) return;
  currentFronts.set(sanitized.alter.id, sanitized);
  updateLastFronted(sanitized.alter.id, sanitized.front);
}

/*  
===========================================================
⭐ FIXED VERSION OF handleFrontingEnded
===========================================================
*/
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
  for (const f of currentFronts.values()) f.primary = false;
  const entry = currentFronts.get(alterId);
  if (entry) entry.primary = true;
}

// =========================
// Upstream (Phoenix) connection
// =========================

let upstreamSocket = null;
let upstreamChannel = null;
let reconnectTimer = null;

function makePhoenixSocket() {
  const socket = new Socket('wss://api.octocon.app/api/socket', {
    params: { token: API_KEY },
    transport: WebSocket,
    heartbeatIntervalMs: 30000,
    reconnectAfterMs: tries => [1000, 2000, 5000, 10000][Math.min(tries, 3)],
  });

  socket.onOpen(() => {
    systemStatus.upstreamConnected = true;
  });

  socket.onClose(() => {
    systemStatus.upstreamConnected = false;
    systemStatus.channelJoined = false;
    scheduleReconnect();
  });

  socket.connect();
  return socket;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    setupUpstream();
  }, 2000);
}

function setupUpstream() {
  upstreamSocket = makePhoenixSocket();
  upstreamChannel = upstreamSocket.channel(`system:${SYSTEM_ID}`, { token: API_KEY });

  upstreamSocket.onMessage(msg => {
    try {
      if (Array.isArray(msg)) {
        const [_, __, topic, event, payload] = msg;

        if (topic === `system:${SYSTEM_ID}` && event === 'fronting_ended') {
          const alterId = payload?.alter_id;
          if (!alterId) return;

          /*  
          ===========================================================
          ⭐ FIXED RAW-ARRAY fronting_ended HANDLER
          ===========================================================
          */
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

        return;
      }

      const { topic, event, payload } = msg;
      if (topic !== `system:${SYSTEM_ID}`) return;

      if (event === 'phx_reply' && payload?.response?.fronts) {
        const sanitizedFronts = payload.response.fronts
          .map(sanitizeFront)
          .filter(Boolean);

        handleFrontsSnapshot(sanitizedFronts);

        emit('broadcast', {
          type: 'fronts_snapshot',
          fronts: sanitizedFronts,
        });

        for (const f of sanitizedFronts) updateLastFronted(f.alter.id, f.front);
      }
    } catch { }
  });

  upstreamChannel
    .join()
    .receive('ok', resp => {
      systemStatus.channelJoined = true;

      if (Array.isArray(resp?.alters)) {
        for (const a of resp.alters) {
          if (a?.id && a.security_level === 'public') {
            alterSecurity.set(a.id, {
              security_level: 'public',
              name: a.name,
              color: a.color,
            });
          }
        }
      }

      if (Array.isArray(resp?.fronts)) {
        const frontsOnly = resp.fronts.map(sanitizeFront).filter(Boolean);
        handleFrontsSnapshot(frontsOnly);

        emit('broadcast', {
          type: 'fronts_snapshot',
          fronts: frontsOnly,
        });

        for (const f of frontsOnly) updateLastFronted(f.alter.id, f.front);
      }
    })
    .receive('error', () => scheduleReconnect())
    .receive('timeout', () => scheduleReconnect());

  upstreamChannel.on('fronting_started', p => forwardEvent('fronting_started', p));
  upstreamChannel.on('fronting_ended', p => forwardEvent('fronting_ended', p));
  upstreamChannel.on('front_updated', p => forwardEvent('front_updated', p));
  upstreamChannel.on('primary_front', p => forwardEvent('primary_front', p));

  function forwardEvent(event, payload) {
    if (event === 'fronting_started') handleFrontingStarted(payload);
    else if (event === 'front_updated') handleFrontUpdated(payload);
    else if (event === 'fronting_ended') handleFrontingEnded(payload);
    else if (event === 'primary_front') handlePrimaryFront(payload);

    emit('broadcast', { type: event, payload });
  }
}

// =========================
// HTTP + WebSocket server
// =========================

const httpServer = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      upstreamConnected: systemStatus.upstreamConnected,
      channelJoined: systemStatus.channelJoined,
      currentFronts: currentFronts.size,
      lastFronted: lastFronted.size,
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
    client.send(JSON.stringify(obj));
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
  connections.add({ client });

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
    for (const ctx of connections) {
      if (ctx.client === client) connections.delete(ctx);
    }
  });
});

httpServer.listen(PORT);

// =========================
// Startup & shutdown
// =========================

loadHistory();
setupUpstream();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));