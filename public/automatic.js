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

  $('pilot-mcp-url').textContent = `${location.origin}/mcp`;

  const PHASES = { idle: 'Idle', thinking: 'Thinking', tool: 'Running', stopping: 'Stopping' };

  function render(entry) {
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
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Thinking';
      const pre = document.createElement('pre');
      pre.textContent = entry.text;
      details.append(summary, pre);
      li.append(details);
    } else {
      const who = document.createElement('span');
      who.className = 'pilot-who';
      who.textContent = entry.kind === 'user'
        ? (entry.source === 'chat' ? `${entry.sender || 'Player'} (chat)` : 'You')
        : entry.kind === 'assistant' ? 'Ptolemy' : entry.kind === 'error' ? 'Error' : '';
      who.title = time;
      const text = document.createElement('span');
      text.className = 'pilot-text';
      text.textContent = entry.text;
      li.append(who, text);
    }

    if (!items.has(entry.id)) {
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      items.set(entry.id, li);
      log.append(li);
      if (stick) log.scrollTop = log.scrollHeight;
    }
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
    modelEl.textContent = `${s.provider}${s.model ? ` · ${s.model}` : ''} · ${s.toolMode === 'text' ? 'text tools' : 'native tools'}`;
    stopBtn.disabled = !s.running;
  });

  document.addEventListener('ptolemy:settings', (ev) => {
    const name = ev.detail.values['chat.name'] || 'ptolemy';
    $('pilot-chat-hint').textContent = `${name}, come here`;
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

  stopBtn.addEventListener('click', () => window.ptolemy.send({ type: 'pilotStop' }));
  resetBtn.addEventListener('click', () => window.ptolemy.send({ type: 'pilotReset' }));

  document.addEventListener('ptolemy:tab', (ev) => { if (ev.detail === 'automatic') input.focus(); });
})();
