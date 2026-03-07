/**
 * octo-client.js  –  Octocon relay client
 *
 * Exposes the same two global functions as the original Simply Plural client:
 *   window.getCurrentFronters(elementId)
 *   window.getLastFrontedDateTime(elementId, memberId)
 *
 * Just swap your RELAY_URL to point at your OctoRelay instance.
 */

(() => {
  const RELAY_URL = 'wss://YOUR_RELAY_IP_HERE';

  // ─── internal state ────────────────────────────────────────────────────────

  let socket        = null;
  let ready         = false;
  let currentFronts = [];               // raw front objects from relay
  let primaryId     = null;             // alter id of primary front
  let lastFrontedHistory = {};          // alterId → ISO timestamp string
  let historyLoaded = false;

  // Registered targets for live-ticking "last fronted" displays
  // { alterId: string, elementId: string }
  const lastFrontedTargets = [];

  // ─── helpers ───────────────────────────────────────────────────────────────

  /**
   * Convert a timestamp (ISO string or ms number) to a human "X ago" string.
   * Mirrors the logic in OctoClient and sp-client exactly.
   */
  function timeSince(ts) {
    const then = typeof ts === 'number' ? ts : new Date(ts).getTime();
    const diffMs = Date.now() - then;
    if (diffMs < 0) return 'in the future?';

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours   = Math.floor(minutes / 60);
    const days    = Math.floor(hours   / 24);
    const months  = Math.floor(days    / 30.4375);
    const years   = Math.floor(months  / 12);

    const plural = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
    const parts  = [];

    if (years > 0) {
      parts.push(plural(years, 'year'));
      const rem = months % 12;
      if (rem > 0) parts.push(plural(rem, 'month'));
    } else if (months > 0) {
      parts.push(plural(months, 'month'));
      const rem = Math.floor(days % 30.4375);
      if (rem > 0) parts.push(plural(rem, 'day'));
    } else if (days > 0) {
      parts.push(plural(days, 'day'));
      const rem = hours % 24;
      if (rem > 0) parts.push(plural(rem, 'hour'));
    } else if (hours > 0) {
      parts.push(plural(hours, 'hour'));
      const rem = minutes % 60;
      if (rem > 0) parts.push(plural(rem, 'minute'));
    } else if (minutes > 0) {
      parts.push(plural(minutes, 'minute'));
      const rem = seconds % 60;
      if (rem > 0) parts.push(plural(rem, 'second'));
    } else {
      parts.push(plural(seconds, 'second'));
    }

    return parts.slice(0, 2).join(', ') + ' ago';
  }

  function setHTML(el, html) {
    if (el.dataset.lastValue !== html) {
      el.dataset.lastValue = html;
      el.innerHTML = html;
    }
  }

  // ─── WebSocket connection ──────────────────────────────────────────────────

  function connect() {
    socket = new WebSocket(RELAY_URL);

    socket.addEventListener('open', () => {
      ready = true;
      // Ask relay for full history and current fronts immediately
      socket.send(JSON.stringify({ event: 'get_last_fronted_all' }));
      socket.send(JSON.stringify({ event: 'get_current_fronts'   }));
    });

    socket.addEventListener('message', ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      handleMessage(msg);
    });

    socket.addEventListener('close', () => {
      ready = false;
      setTimeout(connect, 3000);
    });

    socket.addEventListener('error', () => {});
  }

  function handleMessage(msg) {
    switch (msg.event) {

      // ── snapshot on connect / explicit request ──────────────────────────
      case 'fronts_snapshot':
      case 'current_fronts':
        currentFronts = msg.fronts || [];
        primaryId     = currentFronts.find(f => f.primary)?.alter?.id ?? null;
        refreshFrontersElements();
        refreshLastFrontedElements();
        break;

      // ── real-time fronting events ───────────────────────────────────────
      case 'fronting_started':
        if (msg.payload?.front) {
          currentFronts.push(msg.payload.front);
          refreshFrontersElements();
          refreshLastFrontedElements();
        }
        break;

      case 'fronting_ended':
        if (msg.payload?.alter_id) {
          currentFronts = currentFronts.filter(f => f.alter?.id !== msg.payload.alter_id);
          refreshFrontersElements();
          refreshLastFrontedElements();
        }
        break;

      case 'front_updated':
        if (msg.payload?.front) {
          currentFronts = currentFronts.map(f =>
            f.alter?.id === msg.payload.front.alter?.id ? msg.payload.front : f
          );
          refreshFrontersElements();
          refreshLastFrontedElements();
        }
        break;

      case 'primary_front':
        primaryId = msg.payload?.alter_id ?? null;
        refreshFrontersElements();
        break;

      // ── history ─────────────────────────────────────────────────────────
      case 'last_fronted_all':
        lastFrontedHistory = msg.history || {};
        historyLoaded = true;
        refreshLastFrontedElements();
        break;

      case 'last_fronted_update':
        if (msg.alter_id && msg.timestamp) {
          lastFrontedHistory[String(msg.alter_id)] = msg.timestamp;
          refreshLastFrontedElements();
        }
        break;
    }
  }

  // ─── fronters element registry ────────────────────────────────────────────

  const frontersTargets = []; // { elementId: string }

  function refreshFrontersElements() {
    for (const { elementId } of frontersTargets) renderFronters(elementId);
  }

  function renderFronters(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const visible = currentFronts.filter(f => f.alter?.security_level !== 'private');

    if (!visible.length) {
      setHTML(el, '<span class="p"><strong>No one is currently fronting.</strong></span>');
      return;
    }

    let ordered = [...visible];
    if (primaryId) {
      ordered.sort((a, b) =>
        a.alter?.id === primaryId ? -1 : b.alter?.id === primaryId ? 1 : 0
      );
    }

    const names = ordered
      .map(f => {
        const a = f.alter;
        if (!a) return null;

        const safe  = (a.name || '').replace(/\s+/g, '-');
        let   label = `<a href="#${safe}" style="color:${a.color};text-decoration:none;">${a.name}</a>`;

        if (f.front?.comment?.trim()) {
          label += ` <span style="color:${a.color};">(${f.front.comment})</span>`;
        }

        if (a.id === primaryId) label = `<strong>${label}</strong>`;

        return label;
      })
      .filter(Boolean)
      .join(', ');

    setHTML(el, `<span class="p"><strong>Currently Fronting:</strong> ${names}</span>`);
  }

  // ─── last-fronted element registry ────────────────────────────────────────

  function refreshLastFrontedElements() {
    if (!historyLoaded) return;
    for (const { alterId, elementId } of lastFrontedTargets) {
      renderLastFronted(alterId, elementId);
    }
  }

  function renderLastFronted(alterId, elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const key       = String(alterId);
    const isFronting = currentFronts.some(f => f.alter?.id == alterId);

    if (isFronting) {
      setHTML(el, `<span class="p"><strong>Last Fronted:&nbsp;<rainbow class="pulse">Actively Fronting Now!</rainbow></strong></span>`);
      return;
    }

    const ts = lastFrontedHistory[key];

    if (!ts) {
      setHTML(el, `<span class="p"><strong>Last Fronted:</strong> Unknown</span>`);
      return;
    }

    setHTML(el, `<span class="p"><strong>Last Fronted:</strong> ${timeSince(ts)}</span>`);
  }

  // ─── public API ───────────────────────────────────────────────────────────

  /**
   * getCurrentFronters(elementId)
   *
   * Drop-in replacement for the SP version.
   * Renders "Currently Fronting: …" into the element and keeps it live.
   */
  window.getCurrentFronters = function (elementId) {
    if (!frontersTargets.some(t => t.elementId === elementId)) {
      frontersTargets.push({ elementId });
    }
    // Render immediately if we already have data
    renderFronters(elementId);
  };

  /**
   * getLastFrontedDateTime(elementId, memberId)
   *
   * Drop-in replacement for the SP version.
   * Renders "Last Fronted: X ago" (or "Actively Fronting Now!") and keeps it live.
   *
   * NOTE: memberId must be the Octocon alter ID (string/number), not an SP member ID.
   */
  window.getLastFrontedDateTime = function (elementId, memberId) {
    const key = String(memberId);

    if (!lastFrontedTargets.some(t => t.alterId === key && t.elementId === elementId)) {
      lastFrontedTargets.push({ alterId: key, elementId });
    }

    if (historyLoaded) {
      // History already in memory — render immediately
      renderLastFronted(key, elementId);
    } else if (ready) {
      // Socket is open but history was never requested (e.g. Carrd navigation
      // without a page reload) — request it now. The response will trigger
      // refreshLastFrontedElements() which renders all registered targets.
      socket.send(JSON.stringify({ event: 'get_last_fronted_all' }));
    }
    // If socket isn't open yet, onopen will request history automatically.
  };

  // ─── tick loop for relative timestamps ────────────────────────────────────

  setInterval(() => {
    if (!historyLoaded) return;
    refreshLastFrontedElements();
  }, 1000);

  // ─── boot ─────────────────────────────────────────────────────────────────

  connect();

})();
