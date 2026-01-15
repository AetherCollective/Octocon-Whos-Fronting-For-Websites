'use strict';

const { Socket } = require('phoenix');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Secrets only available server-side
const API_KEY = process.env.API_KEY;
const SYSTEM_ID = process.env.SYSTEM_ID;

// --------- Logging Control ---------
const LOGGING = process.env.LOGGING;
function logHistory(...args) {
  if (LOGGING) console.log(...args);
}


if (!API_KEY || !SYSTEM_ID) {
  console.error('Missing API_KEY or SYSTEM_ID');
  process.exit(1);
}

// --------- History persistence ---------
const HISTORY_FILE = path.join(__dirname, "data", "history.json");

// in-memory: Map<alterId, epoch>
const lastFronted = new Map();

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [id, ts] of Object.entries(obj)) {
      if (typeof ts === 'string') lastFronted.set(id, ts);
    }
    logHistory(`[HISTORY] Loaded ${lastFronted.size} entries`);
  } catch (e) {
    logHistory(`[HISTORY] No history file found or failed to parse, starting fresh`);
  }
}

function saveHistory() {
  const obj = Object.fromEntries(lastFronted.entries());
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj, null, 2), 'utf8');
    logHistory(`[HISTORY] Saved ${Object.keys(obj).length} entries`);
  } catch (e) {
    console.error('Failed to write history file:', e);
  }
}

function updateLastFronted(alterId, front) {
  if (!alterId || !front) return;

  const ts = front.time_end || front.time_start;
  if (!ts) return;

  logHistory(`[HISTORY] alter ${alterId} → ${ts}`);

  lastFronted.set(alterId, ts);
  saveHistory();
}

// load at boot
loadHistory();

// Create HTTP server to handle /status and WS upgrades
const httpServer = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Attach WebSocket server to the HTTP server
const server = new WebSocket.Server({
  server: httpServer,
  perMessageDeflate: false,
  maxPayload: 512 * 1024
});

// Start listening
httpServer.listen(3000);

// --------- Config ---------
const MAX_QUEUE = 200;
const MAX_ALTERS = 1000;
const MAX_MESSAGE_BYTES = 512 * 1024;

// --------- LRU cache for alters ---------
class LRUMap {
  constructor(maxSize) { this.maxSize = maxSize; this.map = new Map(); }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  get(key) { return this.map.get(key); }
  clear() { this.map.clear(); }
}

const alterSecurity = new LRUMap(MAX_ALTERS);

// Track active connections
const connections = new Set();

// Broadcast helper (silent)
function broadcast(obj) {
  const out = JSON.stringify(obj);
  for (const ctx of connections) {
    try { ctx.client.send(out); } catch { }
  }
}

// Helper: sanitize a single front object
function sanitizeFront(f) {
  if (!f || !f.alter || !f.front) return null;
  const alterId = f.alter.id;
  if (!alterId) return null;

  const sec = alterSecurity.get(alterId)?.security_level;
  if (sec !== 'public') return null;

  return {
    primary: !!f.primary,
    alter: { id: f.alter.id, name: f.alter.name, color: f.alter.color },
    front: {
      id: f.front.id,
      comment: f.front.comment,
      time_start: f.front.time_start,
      time_end: f.front.time_end
    }
  };
}

// Create a Phoenix Socket factory
function makePhoenixSocket() {
  const socket = new Socket('wss://api.octocon.app/api/socket', {
    params: { token: API_KEY },
    transport: WebSocket,
    heartbeatIntervalMs: 30000,
    reconnectAfterMs: tries => [1000, 2000, 5000, 5000][Math.min(tries, 3)]
  });
  socket.connect();
  return socket;
}

server.on('connection', client => {
  const queue = [];
  let socket = null;
  let channel = null;

  const ctx = { client, queue, socket: null, channel: null };
  connections.add(ctx);

  function teardownUpstream() {
    try { if (channel) channel.leave(); } catch { }
    channel = null;
    try { if (socket) socket.disconnect(() => { }); } catch { }
    socket = null;

    ctx.channel = null;
    ctx.socket = null;
  }

  function teardownClient() {
    try { client.removeAllListeners(); } catch { }
    try { client.close(); } catch { }
  }

  function enqueue(msg) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(msg);
  }

  function flushQueue() {
    queue.length = 0;
  }

  // Upstream setup
  socket = makePhoenixSocket();
  channel = socket.channel(`system:${SYSTEM_ID}`, { token: API_KEY });

  ctx.socket = socket;
  ctx.channel = channel;

  // Handle raw Phoenix messages
  socket.onMessage(msg => {
    try {
      if (Array.isArray(msg)) {
        const [_, __, topic, event, payload] = msg;

        if (topic === `system:${SYSTEM_ID}` && event === "fronting_ended") {
          const alterId = payload?.alter_id;
          if (alterId) {
            const nowIso = new Date().toISOString();
            updateLastFronted(alterId, { time_end: nowIso });

            broadcast({
              event: "last_fronted_update",
              alter_id: alterId,
              timestamp: nowIso
            });
          }
        }

        return;
      }

      const { topic, event, payload } = msg;

      if (topic !== `system:${SYSTEM_ID}`) return;

      if (event === "phx_reply" && payload?.response?.fronts) {
        const fronts = payload.response.fronts;
        for (const f of fronts) {
          const sanitized = sanitizeFront(f);
          if (!sanitized) continue;
          updateLastFronted(sanitized.alter.id, sanitized.front);
        }
      }
    } catch { }
  });

  channel.join()
    .receive('ok', resp => {
      if (Array.isArray(resp?.alters)) {
        for (const a of resp.alters) {
          if (a?.id && a.security_level === 'public') {
            alterSecurity.set(a.id, {
              security_level: 'public',
              name: a.name,
              color: a.color
            });
          }
        }
      }

      if (Array.isArray(resp?.fronts)) {
        const frontsOnly = resp.fronts.map(sanitizeFront).filter(Boolean);

        const out = JSON.stringify({ event: 'fronts_snapshot', fronts: frontsOnly });
        if (Buffer.byteLength(out) <= MAX_MESSAGE_BYTES) {
          try { client.send(out); } catch { }
        }

        for (const f of frontsOnly) {
          updateLastFronted(f.alter.id, f.front);
        }
      }

      flushQueue();
    });

  // Incremental events
  const forwardEvent = (event, payload) => {
  // Only allow public alters
  if ((event === 'fronting_ended' || event === 'primary_front') && payload?.alter_id) {
    const sec = alterSecurity.get(payload.alter_id)?.security_level;
    if (sec !== 'public') return;
  }

  // --- CASE 1: front object exists (fronting_started, front_updated)
  if (payload?.front) {
    const sanitized = sanitizeFront(payload.front);
    if (!sanitized) return;
    payload.front = sanitized;

    updateLastFronted(sanitized.alter.id, sanitized.front);
  }

  // --- CASE 2: fronting_ended WITHOUT a front object (common case)
  else if (event === 'fronting_ended' && payload?.alter_id) {
    const nowIso = new Date().toISOString();
    updateLastFronted(payload.alter_id, { time_end: nowIso });
  }

  // Forward to client
  const out = JSON.stringify({ event, payload });
  if (Buffer.byteLength(out) <= MAX_MESSAGE_BYTES) {
    try { client.send(out); } catch { }
  }
};

  channel.on('fronting_started', payload => forwardEvent('fronting_started', payload));
  channel.on('fronting_ended', payload => forwardEvent('fronting_ended', payload));
  channel.on('front_updated', payload => forwardEvent('front_updated', payload));
  channel.on('primary_front', payload => forwardEvent('primary_front', payload));

  channel.on('alter_updated', payload => {
    const a = payload?.alter;
    if (a?.id && a.security_level === 'public') {
      alterSecurity.set(a.id, { security_level: 'public', name: a.name, color: a.color });
    }
  });

  channel.on('alter_created', payload => {
    const a = payload?.alter;
    if (a?.id && a.security_level === 'public') {
      alterSecurity.set(a.id, { security_level: 'public', name: a.name, color: a.color });
    }
  });

  client.on('message', msg => {
    const size = Buffer.isBuffer(msg) ? msg.length : Buffer.byteLength(msg);
    if (size > MAX_MESSAGE_BYTES) return;

    let parsed = null;
    try {
      parsed = JSON.parse(msg.toString());
    } catch { }

    if (parsed && parsed.event === 'get_last_fronted_all') {
      const historyObj = Object.fromEntries(lastFronted.entries());
      const out = JSON.stringify({
        event: 'last_fronted_all',
        history: historyObj
      });
      if (Buffer.byteLength(out) <= MAX_MESSAGE_BYTES) {
        try { client.send(out); } catch { }
      }
      return;
    }

    if (!channel) {
      enqueue(msg);
    }
  });

  client.on('close', () => {
    teardownUpstream();
    queue.length = 0;
    try { client.removeAllListeners(); } catch { }
    connections.delete(ctx);
  });

  client.on('error', () => {
    teardownUpstream();
    queue.length = 0;
    teardownClient();
    connections.delete(ctx);
  });
});

// Handle server close
server.on('close', () => {
  connections.forEach(ctx => {
    try { if (ctx.channel) ctx.channel.leave(); } catch { }
    try { if (ctx.socket) ctx.socket.disconnect(() => { }); } catch { }
    try { ctx.client.terminate(); } catch { }
    try { ctx.queue.length = 0; } catch { }
  });
  connections.clear();
});

// ---------- Graceful shutdown ----------
function shutdown() {
  try { server.close(); } catch { }

  connections.forEach(ctx => {
    try { if (ctx.channel) ctx.channel.leave(); } catch { }
    try { if (ctx.socket) ctx.socket.disconnect(() => { }); } catch { }
    try { ctx.client.close(); } catch { }
    try { ctx.client.terminate(); } catch { }
    try { ctx.queue.length = 0; } catch { }
  });

  connections.clear();

  setTimeout(() => { process.exit(0); }, 250);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);