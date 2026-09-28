'use strict';

// Automatic tab: talk to the LLM pilot and watch what it does. The conversation lives on the
// server, so every open tab shows the same transcript, including requests from in-game chat.

(() => {
  const $ = (id) => document.getElementById(id);
  const log = $('pilot-log');
  const form = $('pilot-form');
  const input = $('pilot-input');
  const stateEl = $('pilot-state');
  const modelEl = $('pilot-model');
  const stopBtn = $('pilot-stop');
  const resetBtn = $('pilot-reset');
  const items = new Map(); // entry id -> li
  let robotName = 'Ptolemy'; // chat.name: the robot can be renamed

  $('pilot-mcp-url').textContent = `${location.origin}/mcp`;

  const PHASES = { idle: 'Idle', thinking: 'Thinking', tool: 'Running', stopping: 'Stopping' };

  function render(entry) {
    if (entry.removed) {
      if (items.has(entry.id)) items.get(entry.id).remove();
      items.delete(entry.id);
      return;
    }
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const li = items.get(entry.id) || document.createElement('li');
    li.className = `pilot-${entry.kind}`;
    li.textContent = '';
    const time = new Date(entry.time).toLocaleTimeString([], { hour12: false });

    if (entry.kind === 'tool') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const status = entry.pending ? '…' : entry.ok ? '✓' : '✗';
      summary.textContent = `${status} ${entry.name}(${formatArgs(entry.args)})`;
      summary.title = time;
      details.append(summary);
      if (!entry.pending) {
        const pre = document.createElement('pre');
        pre.textContent = entry.result;
        details.append(pre);
        const first = String(entry.result || '').split('\n')[0];
        const preview = document.createElement('span');
        preview.className = 'pilot-preview';
        preview.textContent = first.length > 140 ? `${first.slice(0, 140)}…` : first;
        summary.append(preview);
      }
      li.classList.toggle('failed', entry.ok === false);
      li.append(details);
    } else if (entry.kind === 'thinking') {
      // Open while it streams in; afterwards it stays however the user left it.
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = entry.streaming ? `Thinking… (${entry.text.length.toLocaleString()} characters)` : 'Thinking';
      const pre = document.createElement('pre');
      pre.textContent = entry.text;
      details.append(summary, pre);
      details.open = Boolean(entry.streaming) || li.dataset.open === '1';
      details.addEventListener('toggle', () => { if (!entry.streaming) li.dataset.open = details.open ? '1' : ''; });
      li.append(details);
      if (entry.streaming) requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    } else {
      const who = document.createElement('span');
      who.className = 'pilot-who';
      who.textContent = entry.kind === 'user'
        ? (entry.source === 'chat' ? `${entry.sender || 'Player'} (chat)` : entry.source === 'robot' ? `${entry.sender || 'A robot'} (robot)`
          : entry.source === 'wonder' ? 'Wondering' : 'You')
        : entry.kind === 'assistant' ? (entry.source === 'chat' || entry.source === 'robot' ? `${robotName} → chat` : robotName)
          : entry.kind === 'notice' ? `${robotName} says` : entry.kind === 'error' ? 'Error' : '';
      who.title = time;
      const text = document.createElement('span');
      text.className = 'pilot-text';
      // The wondering prompt is long and always the same: show a short stand-in.
      text.textContent = entry.kind === 'user' && entry.source === 'wonder' ? '(idle for a while: act natural)' : entry.text;
      if (entry.kind === 'user' && entry.source === 'wonder') li.classList.add('pilot-wonder');
      if (entry.kind === 'user' && entry.source === 'robot') li.classList.add('pilot-robot');
      if (entry.missed) {
        li.classList.add('pilot-missed');
        text.textContent = `${entry.text}  (missed: it was distracted)`;
        li.title = 'Distracted: this message never reached the model (Chat & wondering → Distracted)';
      }
      if (entry.streaming) li.classList.add('streaming');
      li.append(who, text);
    }

    if (!items.has(entry.id)) {
      items.set(entry.id, li);
      log.append(li);
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function formatArgs(args) {
    const entries = Object.entries(args || {});
    if (!entries.length) return '';
    const text = entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }

  document.addEventListener('ptolemy:pilotTranscript', (ev) => {
    log.textContent = '';
    items.clear();
    ev.detail.entries.forEach(render);
    log.scrollTop = log.scrollHeight;
  });

  document.addEventListener('ptolemy:pilotEntry', (ev) => render(ev.detail.entry));

  document.addEventListener('ptolemy:pilot', (ev) => {
    const s = ev.detail;
    stateEl.dataset.phase = s.phase;
    stateEl.textContent = (PHASES[s.phase] || s.phase) + (s.phase === 'tool' && s.detail ? ` ${s.detail}` : '')
      + (s.queued ? ` · ${s.queued} queued` : '');
    modelEl.textContent = `${s.endpoint}${s.model ? ` · ${s.model}` : ''} · ${s.toolMode === 'text' ? 'text tools' : 'native tools'}`;
    stopBtn.disabled = !s.running;
  });

  document.addEventListener('ptolemy:settings', (ev) => {
    const name = ev.detail.values['chat.name'] || 'ptolemy';
    $('pilot-chat-hint').textContent = `${name}, come here`;
    if (name !== robotName) {
      robotName = name;
      // Re-label what's already in the transcript.
      for (const li of items.values()) li.querySelectorAll('.pilot-who').forEach((w) => { w.textContent = w.textContent.replace(/^\S+( → chat| says)?$/, (m, rest) => (/^(You|Error|Wondering)$|\((chat|robot)\)/.test(m) ? m : `${robotName}${rest || ''}`)); });
    }
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    window.ptolemy.send({ type: 'pilotSend', text });
    input.value = '';
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });

  // --- Wondering switch and countdown ---------------------------------------------

  const wonderSwitch = $('wonder-switch');
  const countdown = $('wonder-countdown');
  let wonder = null;

  wonderSwitch.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    window.ptolemy.send({ type: 'wonderMode', mode: b.dataset.mode });
  }));

  function renderCountdown() {
    if (!wonder) return;
    if (wonder.mode === 'off') countdown.textContent = '';
    else if (wonder.blocked) countdown.textContent = `paused: ${wonder.blocked}`;
    else if (wonder.nextAt) {
      const s = Math.max(0, Math.ceil((wonder.nextAt - Date.now()) / 1000));
      countdown.textContent = s ? `in ${s}s` : 'any moment';
    }
  }

  document.addEventListener('ptolemy:wonder', (ev) => {
    wonder = ev.detail;
    wonderSwitch.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === wonder.mode)));
    wonderSwitch.dataset.mode = wonder.mode;
    renderCountdown();
  });
  setInterval(renderCountdown, 500);

  // --- No agent yet: a modal over the panel ---------------------------------------
  // Only the connected player's own agent counts: `agent getposition` never sees anyone else's.

  const missing = $('agent-missing');
  const missingDetail = $('agent-missing-detail');
  let createdAt = 0;

  $('agent-create').addEventListener('click', () => {
    createdAt = Date.now();
    missing.hidden = true;
    window.ptolemy.send({ type: 'memory', op: 'agentCreate' });
  });

  document.addEventListener('ptolemy:worldStatus', (ev) => {
    const agent = ev.detail.agent || {};
    // Right after pressing Create, give the game a moment before showing it again.
    const waiting = Date.now() - createdAt < 3000;
    missing.hidden = agent.exists !== false || waiting;
    missingDetail.textContent = agent.exists === false && createdAt && !waiting
      ? `Still no agent. The game said: "${agent.message || 'nothing'}". Agents need cheats on (or Education Edition).` : '';
  });
  document.addEventListener('ptolemy:status', (ev) => {
    if (!ev.detail.minecraft || !ev.detail.minecraft.connected) missing.hidden = true;
  });

  stopBtn.addEventListener('click', () => window.ptolemy.send({ type: 'pilotStop' }));
  resetBtn.addEventListener('click', () => window.ptolemy.send({ type: 'pilotReset' }));

  document.addEventListener('ptolemy:tab', (ev) => {
    if (ev.detail !== 'robot') return;
    log.scrollTop = log.scrollHeight; // it may have filled while hidden
  });
})();
