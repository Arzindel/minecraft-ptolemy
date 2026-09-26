'use strict';

// Configuration → LLM: one card per endpoint (LM Studio, text-generation-webui, NVIDIA Build,
// OpenAI, Anthropic, custom servers), each with its key, model, tool mode and three tests whose
// dots stay green/red until Ptolemy restarts or the endpoint changes.

(() => {
  const root = document.getElementById('endpoints');
  const send = (m) => window.ptolemy.send(m);
  const models = new Map(); // endpoint id -> fetched model ids
  const refreshing = new Set();
  let state = null;

  const TESTS = [
    { kind: 'endpoint', label: 'Test endpoint', title: 'Can Ptolemy reach the server (and is the key accepted)?' },
    { kind: 'model', label: 'Test model', title: 'Send a short message and check for a tiny JSON reply.' },
    { kind: 'mcp', label: 'Test tools', title: 'Can the model call tools natively (like an MCP client), or does it write the calls as plain text?' },
  ];

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) if (c !== null && c !== undefined) node.append(c);
    return node;
  }

  function render() {
    if (!state) return;
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    root.textContent = '';
    root.append(el('div', { className: 'endpoints-head' },
      el('h3', { textContent: 'Endpoints' }),
      el('span', { className: 'muted small', textContent: 'The selected one drives Automatic mode. API keys are saved in the git-ignored .env file and never sent back to this page.' })));

    const list = el('div', { className: 'endpoint-list' });
    for (const e of state.endpoints) list.append(card(e));
    root.append(list);

    const preset = el('select');
    for (const [id, p] of Object.entries(state.presets)) preset.append(new Option(p.label, id));
    preset.value = 'custom';
    const add = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'Add endpoint' });
    add.addEventListener('click', () => send({ type: 'endpointAdd', preset: preset.value }));
    root.append(el('div', { className: 'endpoint-add' }, el('span', { className: 'muted small', textContent: 'Another endpoint:' }), preset, add));

    if (focused) {
      const again = root.querySelector(`[data-focus-key="${focused}"]`);
      if (again) again.focus();
    }
  }

  function card(e) {
    const active = state.active === e.id;
    const box = el('div', { className: `endpoint${active ? ' active' : ''}` });

    const use = el('input', { type: 'radio', name: 'endpoint-active', checked: active, title: 'Use this endpoint for Automatic mode' });
    use.addEventListener('change', () => send({ type: 'endpointActive', id: e.id }));
    const name = el('input', { type: 'text', className: 'endpoint-name', value: e.name, spellcheck: false, size: Math.max(8, e.name.length + 1) });
    name.dataset.focusKey = `${e.id}-name`;
    name.addEventListener('change', () => send({ type: 'endpointUpdate', id: e.id, patch: { name: name.value } }));
    const kind = el('span', { className: 'chip', textContent: state.presets[e.preset].label + (e.api === 'anthropic' ? ' · Messages API' : ' · OpenAI API') });
    const remove = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'Remove', title: 'Remove this endpoint (and its saved key)' });
    remove.addEventListener('click', () => {
      if (window.confirm(`Remove "${e.name}" and its saved API key?`)) send({ type: 'endpointRemove', id: e.id });
    });
    box.append(el('div', { className: 'endpoint-top' }, el('label', { className: 'endpoint-use' }, use, active ? ' In use' : ' Use'), name, kind, el('span', { className: 'spacer' }), remove));

    const rows = el('div', { className: 'endpoint-rows' });

    // Server URL
    const url = el('input', { type: 'text', value: e.baseUrl, spellcheck: false });
    url.dataset.focusKey = `${e.id}-url`;
    url.addEventListener('change', () => send({ type: 'endpointUpdate', id: e.id, patch: { baseUrl: url.value } }));
    rows.append(row('Server URL', url));

    // API key: dots, never filled in from the server.
    const key = el('input', { type: 'password', autocomplete: 'off', spellcheck: false });
    key.dataset.focusKey = `${e.id}-key`;
    key.placeholder = e.keySource === '.env' ? '•••••••• saved in .env (type to replace)'
      : e.keySource ? `using $${e.keySource} (type to override)` : 'optional; not set';
    key.addEventListener('change', () => {
      if (key.value.trim()) send({ type: 'endpointKey', id: e.id, key: key.value.trim() });
      key.value = '';
    });
    const clear = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'Clear', disabled: e.keySource !== '.env' });
    clear.addEventListener('click', () => send({ type: 'endpointKey', id: e.id, key: '' }));
    rows.append(row('API key', key, clear));

    // Model: dropdown of what the server lists, plus refresh.
    const model = el('select');
    model.dataset.focusKey = `${e.id}-model`;
    const known = models.get(e.id) || [];
    model.append(new Option(e.preset === 'oobabooga' ? '(whatever is loaded)' : '(server default / first listed)', ''));
    for (const id of new Set([...(e.model ? [e.model] : []), ...known])) model.append(new Option(id, id));
    model.append(new Option('Other… (type a name)', '__other'));
    model.value = e.model;
    model.addEventListener('change', () => {
      let value = model.value;
      if (value === '__other') {
        value = window.prompt('Model name', e.model || '');
        if (value === null) {
          model.value = e.model;
          return;
        }
      }
      send({ type: 'endpointUpdate', id: e.id, patch: { model: value } });
    });
    const refresh = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: refreshing.has(e.id) ? '…' : '↻', title: 'Fetch the list of models' });
    refresh.addEventListener('click', () => {
      refreshing.add(e.id);
      refresh.textContent = '…';
      send({ type: 'endpointModels', id: e.id });
    });
    const count = el('span', { className: 'muted small', textContent: known.length ? `${known.length} listed` : '' });
    rows.append(row('Model', model, refresh, count));

    // Tool calling
    const mode = el('select');
    for (const [v, label] of [['auto', 'Auto (native, else text)'], ['native', 'Native'], ['text', 'Text (in the prompt)']]) mode.append(new Option(label, v));
    mode.value = e.toolMode;
    mode.addEventListener('change', () => send({ type: 'endpointUpdate', id: e.id, patch: { toolMode: mode.value } }));
    rows.append(row('Tool calling', mode));
    box.append(rows);

    // Tests with their dots.
    const tests = el('div', { className: 'endpoint-tests' });
    let lastMessage = null;
    for (const t of TESTS) {
      const result = e.tests[t.kind];
      const dot = el('span', { className: `dot ${result ? (result.running ? 'running' : result.ok ? 'ok' : 'fail') : ''}` });
      dot.title = result ? result.message : 'Not tested yet';
      const button = el('button', { type: 'button', className: 'btn btn-ghost btn-small', title: t.title, disabled: Boolean(result && result.running) }, dot, ` ${t.label}`);
      button.addEventListener('click', () => send({ type: 'endpointTest', id: e.id, kind: t.kind }));
      tests.append(button);
      if (result && (!lastMessage || result.time > lastMessage.time)) lastMessage = { ...result, label: t.label };
    }
    box.append(tests);
    if (lastMessage) {
      box.append(el('p', { className: `endpoint-result small ${lastMessage.running ? '' : lastMessage.ok ? 'ok' : 'fail'}`, textContent: `${lastMessage.label}: ${lastMessage.message}` }));
    }
    box.append(el('p', { className: 'muted small endpoint-help', textContent: state.presets[e.preset].help }));
    return box;
  }

  function row(label, ...controls) {
    return el('div', { className: 'endpoint-row' }, el('span', { className: 'config-label', textContent: label }), el('div', { className: 'endpoint-controls' }, ...controls));
  }

  document.addEventListener('ptolemy:endpoints', (ev) => {
    state = ev.detail;
    // Don't redraw under the user's fingers while they type in one of the boxes.
    const typing = document.activeElement && root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'
      && document.activeElement.type !== 'radio';
    if (typing) document.activeElement.addEventListener('blur', render, { once: true });
    else render();
  });

  document.addEventListener('ptolemy:endpointModels', (ev) => {
    const { id, models: list, error } = ev.detail;
    refreshing.delete(id);
    if (error) window.alert(`Couldn't list the models: ${error}`);
    else models.set(id, list);
    render();
  });

  window.ptolemyEndpoints = { current: () => state };
})();
