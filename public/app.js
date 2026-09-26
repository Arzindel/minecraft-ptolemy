'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const el = {
    mcStatus: $('mc-status'),
    mcStatusText: $('mc-status-text'),
    uiStatus: $('ui-status'),
    uiStatusText: $('ui-status-text'),
    connectHint: $('connect-hint'),
    connectCommand: $('connect-command'),
    copyConnect: $('copy-connect'),
    disconnectBtn: $('disconnect-btn'),
    log: $('log'),
    showChat: $('show-chat'),
    clearLog: $('clear-log'),
    form: $('command-form'),
    input: $('command-input'),
    infoConnected: $('info-connected'),
    infoPlayer: $('info-player'),
    infoRemote: $('info-remote'),
    infoUptime: $('info-uptime'),
    infoPending: $('info-pending'),
    inspect: $('inspect'),
    inspectCaption: $('inspect-caption'),
  };

  const GLYPHS = { command: '›', response: '✓', error: '✗', chat: '💬', agent: '🤖', event: '⚡', system: '·' };
  const HISTORY_KEY = 'ptolemy.commandHistory';
  const TAB_KEY = 'ptolemy.tab';

  let socket = null;
  let minecraft = { connected: false };

  // --- Server link ------------------------------------------------------------

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ui`);
    setUiStatus('waiting', 'Server: connecting');

    socket.addEventListener('open', () => setUiStatus('connected', 'Server'));
    socket.addEventListener('message', (ev) => handle(JSON.parse(ev.data)));
    socket.addEventListener('close', () => {
      setUiStatus('offline', 'Server offline');
      renderStatus({ minecraft: { connected: false }, offline: true });
      setTimeout(connect, 1500);
    });
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function handle(msg) {
    switch (msg.type) {
      case 'status':
        renderStatus(msg);
        break;
      case 'history':
        el.log.textContent = '';
        msg.entries.forEach(appendLog);
        break;
      case 'log':
        appendLog(msg.entry);
        break;
      case 'sight':
      case 'path':
      case 'agent':
      case 'settings':
      case 'pilot':
      case 'pilotEntry':
      case 'pilotTranscript':
      case 'llmModels':
        // For the Nanny Cam, the Automatic tab and the Configuration tab.
        document.dispatchEvent(new CustomEvent(`ptolemy:${msg.type}`, { detail: msg }));
        break;
      default:
        break;
    }
  }

  // --- Header / info panel ----------------------------------------------------

  function setUiStatus(state, text) {
    el.uiStatus.dataset.state = state;
    el.uiStatusText.textContent = text;
  }

  function renderStatus(msg) {
    minecraft = msg.minecraft || { connected: false };

    if (msg.mcPort) {
      el.connectCommand.textContent = `/connect localhost:${msg.mcPort}`;
      const lan = (msg.addresses || []).map((a) => `${a}:${msg.mcPort}`);
      el.connectCommand.title = lan.length
        ? `From another device on your network, use: ${lan.join(' or ')}`
        : '';
    }

    if (msg.offline) {
      el.mcStatus.dataset.state = 'offline';
      el.mcStatusText.textContent = 'Unknown (server offline)';
    } else if (minecraft.connected) {
      el.mcStatus.dataset.state = 'connected';
      el.mcStatusText.textContent = minecraft.player ? `Connected as ${minecraft.player}` : 'Minecraft connected';
    } else {
      el.mcStatus.dataset.state = 'waiting';
      el.mcStatusText.textContent = 'Waiting for Minecraft';
    }

    el.connectHint.hidden = minecraft.connected;
    el.disconnectBtn.hidden = !minecraft.connected;

    el.infoConnected.textContent = minecraft.connected ? 'Connected' : 'Not connected';
    el.infoPlayer.textContent = minecraft.player || '–';
    el.infoRemote.textContent = minecraft.remote || '–';
    el.infoPending.textContent = minecraft.pending ?? 0;
    renderUptime();
  }

  function renderUptime() {
    if (!minecraft.connected || !minecraft.since) {
      el.infoUptime.textContent = '–';
      return;
    }
    const s = Math.floor((Date.now() - minecraft.since) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    el.infoUptime.textContent = h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
  }

  setInterval(renderUptime, 1000);

  el.copyConnect.addEventListener('click', async () => {
    const text = el.connectCommand.textContent;
    try {
      await navigator.clipboard.writeText(text);
      el.copyConnect.textContent = 'Copied';
    } catch {
      el.copyConnect.textContent = 'Copy failed';
    }
    setTimeout(() => { el.copyConnect.textContent = 'Copy'; }, 1200);
  });

  el.disconnectBtn.addEventListener('click', () => send({ type: 'disconnect' }));

  // --- Console log ------------------------------------------------------------

  function appendLog(entry) {
    const stick = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 40;

    const li = document.createElement('li');
    li.className = entry.kind;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(entry.time).toLocaleTimeString([], { hour12: false });

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = GLYPHS[entry.kind] || '';

    const text = document.createElement('span');
    text.className = 'text';
    if (entry.kind === 'chat') {
      text.textContent = `<${entry.sender}> ${entry.text}`;
    } else if (entry.kind === 'error' && !entry.body) {
      // Failed before reaching the game (not connected, timeout...): show what was attempted.
      text.textContent = entry.commandLine ? `${entry.text} (${entry.commandLine})` : entry.text;
    } else {
      text.textContent = entry.text;
    }

    li.append(time, glyph, text);

    if (entry.body || entry.kind === 'response' || entry.kind === 'error') {
      li.dataset.inspectable = '';
      li.addEventListener('click', () => inspect(entry, li));
    }

    el.log.appendChild(li);
    if (stick) el.log.scrollTop = el.log.scrollHeight;

    if (entry.body || entry.kind === 'response' || entry.kind === 'error') inspect(entry, li);
  }

  function inspect(entry, li) {
    el.log.querySelectorAll('li.selected').forEach((n) => n.classList.remove('selected'));
    li.classList.add('selected');
    el.inspectCaption.textContent = entry.kind === 'agent' ? 'AgentCommand event'
      : entry.kind === 'event' ? `${entry.commandLine} event`
        : entry.kind === 'system' ? (entry.commandLine || entry.text)
          : entry.commandLine || 'Response';
    el.inspect.textContent = JSON.stringify(
      entry.body ?? { statusCode: entry.statusCode, statusMessage: entry.text },
      null,
      2,
    );
  }

  el.showChat.addEventListener('change', () => {
    el.log.classList.toggle('hide-chat', !el.showChat.checked);
  });

  el.clearLog.addEventListener('click', () => send({ type: 'clearLog' }));

  // --- Command input with history --------------------------------------------

  let history = [];
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { /* storage unavailable */ }
  let historyIndex = history.length;
  let draft = '';

  el.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = el.input.value.trim();
    if (!text) return;

    send({ type: 'command', text });

    if (history[history.length - 1] !== text) history.push(text);
    history = history.slice(-100);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
    historyIndex = history.length;
    draft = '';
    el.input.value = '';
  });

  el.input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    if (!history.length) return;
    ev.preventDefault();

    if (historyIndex === history.length) draft = el.input.value;
    historyIndex += ev.key === 'ArrowUp' ? -1 : 1;
    historyIndex = Math.max(0, Math.min(history.length, historyIndex));
    el.input.value = historyIndex === history.length ? draft : history[historyIndex];
    el.input.setSelectionRange(el.input.value.length, el.input.value.length);
  });

  // --- Tabs -------------------------------------------------------------------

  function selectTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    try { localStorage.setItem(TAB_KEY, name); } catch { /* ignore */ }
    if (name === 'manual') el.input.focus();
    document.dispatchEvent(new CustomEvent('ptolemy:tab', { detail: name }));
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  let initialTab = 'manual';
  try { initialTab = localStorage.getItem(TAB_KEY) || 'manual'; } catch { /* ignore */ }
  selectTab(initialTab);

  // Shared with the other scripts on the page (e.g. the Nanny Cam's Scan button).
  window.ptolemy = { send };

  connect();
})();
