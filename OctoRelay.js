'use strict';

const { Socket } = require('phoenix'); // npm i phoenix
const WebSocket = require('ws');       // npm i ws

// Secrets only available server-side
const API_KEY = process.env.API_KEY;
const SYSTEM_ID = process.env.SYSTEM_ID;

if (!API_KEY || !SYSTEM_ID) {
  console.error('Missing API_KEY or SYSTEM_ID');
  process.exit(1);
}

// Server: disable permessage deflate and cap incoming client payloads
const server = new WebSocket.Server({
  port: 3000,
  perMessageDeflate: false,
  maxPayload: 512 * 1024 // drop client messages larger than 512KB
});

// --------- Config ---------
const MAX_QUEUE = 200;                 // cap client→upstream queue
const MAX_ALTERS = 1000;               // cap number of cached alters
const MAX_MESSAGE_BYTES = 512 * 1024;  // drop messages larger than 512KB

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

// Track active connections for graceful shutdown
const connections = new Set();

// Helper: sanitize a single front object
function sanitizeFront(f) {
  if (!f || !f.alter || !f.front) return null;
  const alterId = f.alter.id;
  if (!alterId) return null;

  const sec = alterSecurity.get(alterId)?.security_level;
  if (sec !== 'public') return null; // only allow public alters

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

// Create a Phoenix Socket factory (one per connection to control lifecycle)
function makePhoenixSocket() {
  const socket = new Socket('wss://api.octocon.app/api/socket', {
    params: { token: API_KEY },
    transport: WebSocket,        // use ws in Node
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

  // Keep only minimal refs to avoid retention
  const ctx = { client, queue, socket: null, channel: null };
  connections.add(ctx);

  function teardownUpstream() {
    try { if (channel) channel.leave(); } catch {}
    channel = null;
    try { if (socket) socket.disconnect(() => {}); } catch {}
    socket = null;

    ctx.channel = null;
    ctx.socket = null;
  }

  function teardownClient() {
    try { client.removeAllListeners(); } catch {}
    try { client.close(); } catch {}
  }

  function enqueue(msg) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(msg);
  }

  function flushQueue() {
    // No upstream push semantics defined; drop buffered messages
    queue.length = 0;
  }

  // Upstream (Phoenix) setup
  socket = makePhoenixSocket();
  channel = socket.channel(`system:${SYSTEM_ID}`, { token: API_KEY });

  // keep references for server-close cleanup
  ctx.socket = socket;
  ctx.channel = channel;

  // Optional lifecycle hooks (silent)
  socket.onOpen(() => {});
  socket.onError(() => {});
  socket.onClose(() => {});

  channel.join()
    .receive('ok', resp => {
      // Capture alters metadata (only public)
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

      // Initial snapshot fronts if provided
      if (Array.isArray(resp?.fronts)) {
        const frontsOnly = resp.fronts.map(sanitizeFront).filter(Boolean);
        const out = JSON.stringify({ event: 'fronts_snapshot', fronts: frontsOnly });
        if (Buffer.byteLength(out) <= MAX_MESSAGE_BYTES) {
          try { client.send(out); } catch {}
        }
      }

      flushQueue();
    })
    .receive('error', () => {})
    .receive('timeout', () => {});

  // Incremental events from upstream
  const forwardEvent = (event, payload) => {
    if ((event === 'fronting_ended' || event === 'primary_front') && payload?.alter_id) {
      const sec = alterSecurity.get(payload.alter_id)?.security_level;
      if (sec !== 'public') return;
    }

    if (payload?.front) {
      const sanitized = sanitizeFront(payload.front);
      if (!sanitized) return;
      payload.front = sanitized;
    }

    const out = JSON.stringify({ event, payload });
    if (Buffer.byteLength(out) <= MAX_MESSAGE_BYTES) {
      try { client.send(out); } catch {}
    }
  };

  // Bind expected events
  channel.on('fronting_started', payload => forwardEvent('fronting_started', payload));
  channel.on('fronting_ended', payload => forwardEvent('fronting_ended', payload));
  channel.on('front_updated', payload => forwardEvent('front_updated', payload));
  channel.on('primary_front', payload => forwardEvent('primary_front', payload));

  // Alter updates (update cache, don’t forward)
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

  // Client → upstream bounds (optional)
  client.on('message', msg => {
    const size = Buffer.isBuffer(msg) ? msg.length : Buffer.byteLength(msg);
    if (size > MAX_MESSAGE_BYTES) return;

    // No upstream push defined; buffer until join then drop
    if (channel) {
      // No-op by default
    } else {
      enqueue(msg);
    }
  });

  client.on('close', () => {
    teardownUpstream();
    queue.length = 0;
    try { client.removeAllListeners(); } catch {}
    connections.delete(ctx);
  });

  client.on('error', () => {
    teardownUpstream();
    queue.length = 0;
    teardownClient();
    connections.delete(ctx);
  });
});

// Handle server close: terminate clients and tear down upstream references
server.on('close', () => {
  connections.forEach(ctx => {
    try { if (ctx.channel) ctx.channel.leave(); } catch {}
    try { if (ctx.socket) ctx.socket.disconnect(() => {}); } catch {}
    try { ctx.client.terminate(); } catch {}
    try { ctx.queue.length = 0; } catch {}
  });
  connections.clear();
});

// ---------- Graceful shutdown for Docker (SIGTERM/SIGINT) ----------
function shutdown() {
  try { server.close(); } catch {}

  connections.forEach(ctx => {
    try { if (ctx.channel) ctx.channel.leave(); } catch {}
    try { if (ctx.socket) ctx.socket.disconnect(() => {}); } catch {}
    try { ctx.client.close(); } catch {}
    try { ctx.client.terminate(); } catch {}
    try { ctx.queue.length = 0; } catch {}
  });

  connections.clear();

  setTimeout(() => { process.exit(0); }, 250);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);