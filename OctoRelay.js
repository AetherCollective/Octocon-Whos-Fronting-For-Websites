'use strict';

const WebSocket = require('ws');

// Secrets only available server-side
const API_KEY = process.env.API_KEY;
const SYSTEM_ID = process.env.SYSTEM_ID;

if (!API_KEY || !SYSTEM_ID) {
  // Remove this line if you want absolute silence
  console.error('Missing API_KEY or SYSTEM_ID');
  process.exit(1);
}

const OCTOCON_URL =
  `wss://api.octocon.app/api/socket/websocket?vsn=2.0.0&token=${API_KEY}`;

const server = new WebSocket.Server({
  port: 3000,
  perMessageDeflate: false,
  maxPayload: 512 * 1024 // drop client messages larger than 512KB
});

// --------- Config ---------
const MAX_QUEUE = 1000;                 // cap client→upstream queue
const MAX_ALTERS = 5000;                // cap number of cached alters
const RECONNECT_DELAY_MS = 5000;        // upstream reconnect delay
const HEARTBEAT_MS = 30000;             // phoenix heartbeat interval
const MAX_MESSAGE_BYTES = 512 * 1024;   // drop messages larger than 512KB

// --------- LRU cache for alters ---------
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
  if (sec !== 'public') return null;   // only allow public alters

  return {
    primary: !!f.primary,
    alter: {
      id: f.alter.id,
      name: f.alter.name,
      color: f.alter.color
      // avatar_url removed
    },
    front: {
      id: f.front.id,
      comment: f.front.comment,
      time_start: f.front.time_start,
      time_end: f.front.time_end
      // user_id removed
    }
  };
}

server.on('connection', client => {
  let upstream = null;
  let heartbeat = null;
  let reconnectTimer = null;
  let isConnecting = false;
  const queue = [];

  // Register connection context for shutdown
  const ctx = {
    client,
    get upstream() { return upstream; },
    set upstream(v) { upstream = v; },
    get heartbeat() { return heartbeat; },
    set heartbeat(v) { heartbeat = v; },
    get reconnectTimer() { return reconnectTimer; },
    set reconnectTimer(v) { reconnectTimer = v; },
    get isConnecting() { return isConnecting; },
    set isConnecting(v) { isConnecting = v; },
    queue
  };
  connections.add(ctx);

  function clearHeartbeat() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function safeSend(ws, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  function enqueue(msg) {
    if (queue.length >= MAX_QUEUE) {
      // Drop oldest to keep memory bounded
      queue.shift();
    }
    queue.push(msg);
  }

  function flushQueue() {
    while (queue.length && upstream && upstream.readyState === WebSocket.OPEN) {
      const msg = queue.shift();
      safeSend(upstream, msg);
    }
  }

  function teardownUpstream() {
    clearHeartbeat();
    if (upstream) {
      try { upstream.removeAllListeners(); } catch { }
      try { upstream.close(); } catch { }
      upstream = null;
    }
  }

  function teardownClient() {
    try { client.removeAllListeners(); } catch { }
    try { client.close(); } catch { }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectUpstream();
    }, RECONNECT_DELAY_MS);
  }

  function connectUpstream() {
    if (isConnecting) return;
    isConnecting = true;

    upstream = new WebSocket(OCTOCON_URL, { perMessageDeflate: false });

    upstream.on('open', () => {
      isConnecting = false;

      const joinMsg = [
        "1",
        "1",
        `system:${SYSTEM_ID}`,
        "phx_join",
        { token: API_KEY }
      ];
      safeSend(upstream, JSON.stringify(joinMsg));

      heartbeat = setInterval(() => {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          const hb = ["1", null, "phoenix", "heartbeat", {}];
          safeSend(upstream, JSON.stringify(hb));
        }
      }, HEARTBEAT_MS);

      flushQueue();
    });

    // Relay upstream → client
    upstream.on('message', msg => {
      // Drop oversized upstream messages to protect memory
      const size = Buffer.isBuffer(msg) ? msg.length : Buffer.byteLength(msg);
      if (size > MAX_MESSAGE_BYTES) return;

      let parsed;
      try {
        parsed = JSON.parse(msg.toString());
      } catch {
        // silent on parse error
        return;
      }

      const [, , topic, event, payload] = parsed;

      // Skip heartbeat replies
      if (topic === "phoenix" && event === "phx_reply" && !payload?.response?.fronts) {
        return;
      }

      // Capture alter metadata on join reply; store only public
      if (payload?.response?.alters && Array.isArray(payload.response.alters)) {
        for (const a of payload.response.alters) {
          if (a?.id && a.security_level === 'public') {
            alterSecurity.set(a.id, {
              security_level: 'public',
              name: a.name,
              color: a.color
            });
          }
        }
      }

      // Handle initial snapshot (phx_reply with fronts)
      if (payload?.response?.fronts) {
        const frontsOnly = payload.response.fronts
          .map(sanitizeFront)
          .filter(Boolean);

        const out = JSON.stringify({ event: "fronts_snapshot", fronts: frontsOnly });
        if (Buffer.byteLength(out) <= MAX_MESSAGE_BYTES) {
          safeSend(client, out);
        }
        return;
      }

      // Track alter updates (store only public)
      if (event === 'alter_updated' || event === 'alter_created') {
        const a = payload?.alter;
        if (a?.id && a.security_level === 'public') {
          alterSecurity.set(a.id, {
            security_level: 'public',
            name: a.name,
            color: a.color
          });
        }
        return; // don't forward alter details downstream
      }

      // Handle incremental events
      if (["fronting_started", "fronting_ended", "front_updated", "primary_front"].includes(event)) {
        // Gate by public alters
        if ((event === "fronting_ended" || event === "primary_front") && payload?.alter_id) {
          const sec = alterSecurity.get(payload.alter_id)?.security_level;
          if (sec !== "public") return;
        }

        if (payload.front) {
          const sanitized = sanitizeFront(payload.front);
          if (!sanitized) return;
          payload.front = sanitized;
        }

        // Bound downstream payload size
        const out = JSON.stringify({ event, payload });
        if (Buffer.byteLength(out) <= MAX_MESSAGE_BYTES) {
          safeSend(client, out);
        }
        return;
      }
    });

    upstream.on('close', () => {
      isConnecting = false;
      teardownUpstream();
      scheduleReconnect();
    });

    upstream.on('error', () => {
      isConnecting = false;
      teardownUpstream();
      scheduleReconnect();
    });
  }

  // Forward client messages upstream with bounds
  client.on('message', msg => {
    const size = Buffer.isBuffer(msg) ? msg.length : Buffer.byteLength(msg);
    if (size > MAX_MESSAGE_BYTES) return;

    if (upstream && upstream.readyState === WebSocket.OPEN) {
      safeSend(upstream, msg);
    } else {
      enqueue(msg);
    }
  });

  client.on('close', () => {
    clearHeartbeat();
    clearReconnectTimer();
    teardownUpstream();
    queue.length = 0;
    connections.delete(ctx);
  });

  client.on('error', () => {
    clearHeartbeat();
    clearReconnectTimer();
    teardownUpstream();
    queue.length = 0;
    teardownClient();
    connections.delete(ctx);
  });

  connectUpstream();
});

// ---------- Graceful shutdown for Docker (SIGTERM/SIGINT) ----------
function shutdown() {
  // Stop accepting new connections
  try { server.close(); } catch { }

  // Teardown all active connection contexts
  connections.forEach(ctx => {
    try {
      if (ctx.heartbeat) clearInterval(ctx.heartbeat);
    } catch { }

    try {
      if (ctx.reconnectTimer) clearTimeout(ctx.reconnectTimer);
    } catch { }

    // Close upstream and client
    try {
      if (ctx.upstream) {
        try { ctx.upstream.removeAllListeners(); } catch { }
        try { ctx.upstream.close(); } catch { }
      }
    } catch { }
    try { ctx.client.close(); } catch { }
    try { ctx.client.terminate(); } catch { } // hard close if needed

    // Release queued messages
    try { ctx.queue.length = 0; } catch { }
  });

  // Small delay to allow sockets to close gracefully
  setTimeout(() => {
    process.exit(0);
  }, 250);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);