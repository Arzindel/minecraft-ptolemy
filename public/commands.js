'use strict';

// Commands tab: every tool the LLM can call, every #console command and the Minecraft commands the
// robot works with, each with an editable description. Tool descriptions are exactly what the model
// reads; # descriptions are what #help prints; / commands ticked "In LLM prompt" are listed for
// run_command in the system prompt.

(() => {
  const body = document.getElementById('commands-body');
  const filter = document.getElementById('commands-filter');
  const send = (m) => window.ptolemy.send(m);
  let data = null;

  const SECTIONS = [
    { kind: 'tools', title: 'LLM tools', help: 'What the model (and MCP clients) can call. The description is what the model reads to decide when and how to use it.', prefix: '' },
    { kind: 'hash', title: '# Console commands', help: 'Ptolemy\'s own commands, typed in the Manual console. The description is what #help shows.', prefix: '#' },
    { kind: 'slash', title: '/ Minecraft commands', help: 'Game commands the robot works with (the slash is optional in the console). Tick "In LLM prompt" to offer one to the model for run_command, with this description.', prefix: '/' },
  ];

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  function render() {
    if (!data) return;
    const q = filter.value.trim().toLowerCase();
    body.textContent = '';
    for (const section of SECTIONS) {
      const rows = data[section.kind].filter((c) => !q || `${c.name} ${c.usage || ''} ${c.params || ''} ${c.description}`.toLowerCase().includes(q));
      if (!rows.length) continue;
      const box = el('section', { className: 'cmd-section' },
        el('h3', { textContent: `${section.title} (${rows.length})` }),
        el('p', { className: 'muted small', textContent: section.help }));
      for (const c of rows) box.append(row(section, c));
      body.append(box);
    }
    if (!body.children.length) body.append(el('p', { className: 'muted', textContent: 'Nothing matches.' }));
  }

  function row(section, c) {
    const signature = section.kind === 'tools' ? `(${c.params})` : c.usage;
    const head = el('div', { className: 'cmd-head' },
      el('code', { className: 'cmd-name', textContent: `${section.prefix}${c.name}` }),
      signature ? el('code', { className: 'cmd-usage', textContent: signature }) : null,
      ...(c.tags || []).map((t) => el('span', { className: 'chip', textContent: t })),
      c.edited ? el('span', { className: 'chip chip-edited', textContent: 'edited' }) : null);

    const text = el('textarea', { rows: Math.min(6, Math.max(2, Math.ceil(c.description.length / 110))), value: c.description, spellcheck: true });
    text.addEventListener('change', () => send({ type: 'commandEdit', kind: section.kind, name: c.name, description: text.value }));

    const actions = el('div', { className: 'cmd-actions' });
    if (section.kind === 'slash') {
      const box = el('input', { type: 'checkbox', checked: c.inPrompt });
      box.addEventListener('change', () => send({ type: 'commandEdit', kind: 'slash', name: c.name, inPrompt: box.checked }));
      actions.append(el('label', { className: 'toggle' }, box, ' In LLM prompt'));
    }
    if (c.description !== c.defaultDescription) {
      const reset = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'Default', title: c.defaultDescription });
      reset.addEventListener('click', () => send({ type: 'commandEdit', kind: section.kind, name: c.name, description: '' }));
      actions.append(reset);
    }
    return el('div', { className: `cmd-row${c.edited ? ' edited' : ''}` }, head, text, actions);
  }

  document.addEventListener('ptolemy:commands', (ev) => {
    data = ev.detail;
    // Don't redraw under the user's fingers while they're typing a description.
    if (document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') {
      document.activeElement.addEventListener('blur', render, { once: true });
    } else render();
  });
  filter.addEventListener('input', render);
  document.getElementById('commands-reset').addEventListener('click', () => {
    if (window.confirm('Put every command description back to its default?')) send({ type: 'commandsReset' });
  });
})();
