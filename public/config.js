'use strict';

// Configuration tab: sub-tabs of forms generated from the server's settings schema. Changes apply
// immediately, are saved on the server and show up in every open tab. Fields marked "this world"
// are kept per Minecraft world. The LLM sub-tab also holds the endpoint cards (endpoints.js).

(() => {
  const form = document.getElementById('config-form');
  // Settings groups that aren't on a Configuration sub-tab (chat, wondering) go on the Robot tab.
  const robotSettings = document.getElementById('robot-settings');
  const subtabs = document.getElementById('config-subtabs');
  const worldLabel = document.getElementById('config-world');
  const resetButton = document.getElementById('config-reset');
  const inputs = new Map(); // key -> { input, field }
  const SUBTAB_KEY = 'ptolemy.configTab';
  let rendered = false;
  let current = 'llm';
  try { current = localStorage.getItem(SUBTAB_KEY) || 'llm'; } catch { /* ignore */ }

  function render(msg) {
    form.textContent = '';
    robotSettings.textContent = '';
    const subtabIds = new Set(msg.tabs.map((t) => t.id));
    subtabs.textContent = '';
    for (const tab of msg.tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'subtab';
      b.textContent = tab.label;
      b.dataset.subtab = tab.id;
      b.addEventListener('click', () => select(tab.id));
      subtabs.append(b);
    }

    for (const group of msg.schema) {
      const fields = group.fields.filter((f) => !f.hidden);
      if (!fields.length) continue;
      const section = document.createElement('fieldset');
      section.className = 'config-group';
      section.dataset.subtab = group.tab;
      const legend = document.createElement('legend');
      legend.textContent = group.group;
      if (fields.every((f) => f.scope === 'world')) legend.append(worldBadge());
      section.append(legend);
      if (group.help) {
        const help = document.createElement('p');
        help.className = 'muted small';
        help.textContent = group.help;
        section.append(help);
      }

      for (const field of fields) {
        const row = document.createElement('label');
        row.className = 'config-row';
        const name = document.createElement('span');
        name.className = 'config-label';
        name.textContent = field.label;
        if (field.help) name.title = field.help;

        const input = makeInput(field);
        input.addEventListener('change', () => {
          let value;
          if (field.type === 'boolean') value = input.checked;
          else if (field.type === 'select' || field.type === 'text' || field.type === 'textarea') value = input.value;
          else value = Number(input.value);
          window.ptolemy.send({ type: 'settings', values: { [field.key]: value } });
        });

        const extra = document.createElement('span');
        extra.className = 'config-default muted small';
        if (field.type === 'boolean') extra.textContent = `default ${field.default ? 'on' : 'off'}`;
        else if (field.type === 'select') extra.textContent = `default ${(field.options.find((o) => o.value === field.default) || {}).label}`;
        else if (field.type === 'text') extra.textContent = `default ${field.default || 'empty'}`;
        else if (field.type !== 'textarea') extra.textContent = `default ${field.default}`;

        row.append(name, input);
        if (field.type === 'textarea') {
          row.classList.add('config-row-wide');
          const reset = document.createElement('button');
          reset.type = 'button';
          reset.className = 'btn btn-ghost btn-small';
          reset.textContent = 'Default';
          reset.title = 'Put back the default text';
          reset.addEventListener('click', (ev) => {
            ev.preventDefault();
            window.ptolemy.send({ type: 'settings', values: { [field.key]: field.default } });
          });
          row.append(reset);
        } else {
          row.append(extra);
        }
        section.append(row);
        inputs.set(field.key, { input, field });
      }
      if (subtabIds.has(group.tab)) form.append(section);
      else {
        delete section.dataset.subtab;
        robotSettings.append(section);
      }
    }

    // Per-world settings can become the starting point for worlds seen from now on.
    const robot = document.createElement('p');
    robot.className = 'config-note small';
    robot.dataset.subtab = 'robot';
    robot.id = 'config-world-note';
    form.append(robot);

    rendered = true;
    select(msg.tabs.some((t) => t.id === current) ? current : msg.tabs[0].id);
  }

  function worldBadge() {
    const badge = document.createElement('span');
    badge.className = 'world-badge';
    badge.textContent = 'this world';
    badge.title = 'Kept separately for each Minecraft world';
    return badge;
  }

  function select(id) {
    current = id;
    try { localStorage.setItem(SUBTAB_KEY, id); } catch { /* ignore */ }
    subtabs.querySelectorAll('.subtab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.subtab === id)));
    document.querySelectorAll('.config [data-subtab]').forEach((el) => {
      if (el.classList.contains('subtab')) return;
      el.hidden = el.dataset.subtab !== id;
    });
  }

  function makeInput(field) {
    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      for (const option of field.options) input.append(new Option(option.label, option.value));
    } else if (field.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = field.default && field.default.length > 200 ? 6 : 3;
    } else {
      input = document.createElement('input');
      if (field.type === 'boolean') input.type = 'checkbox';
      else if (field.type === 'text') {
        input.type = 'text';
        input.spellcheck = false;
      } else {
        input.type = 'number';
        Object.assign(input, { min: field.min, max: field.max, step: field.step });
      }
    }
    return input;
  }

  function fill(msg) {
    const { values } = msg;
    for (const [key, { input, field }] of inputs) {
      if (!(key in values)) continue;
      if (field.type === 'boolean') input.checked = values[key];
      else if (document.activeElement !== input) input.value = values[key];
      input.classList.toggle('changed', values[key] !== field.default);
    }
    worldLabel.textContent = msg.world ? `World: ${msg.world.name}` : 'No world loaded';
    worldLabel.title = msg.world ? 'Settings marked "this world" are this world\'s own copy' : 'Settings marked "this world" apply to every world until one is loaded';
    const note = document.getElementById('config-world-note');
    if (note) {
      note.textContent = '';
      if (msg.world) {
        note.append(`These settings belong to "${msg.world.name}". A world Ptolemy sees for the first time starts with the defaults for new worlds. `);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-ghost btn-small';
        button.textContent = 'Use these as defaults for new worlds';
        button.addEventListener('click', () => window.ptolemy.send({ type: 'settingsWorldToDefaults' }));
        note.append(button);
      } else {
        note.textContent = 'No world is loaded, so these are the defaults for new worlds.';
      }
    }
  }

  document.addEventListener('ptolemy:settings', (ev) => {
    if (!rendered) render(ev.detail);
    fill(ev.detail);
  });

  resetButton.addEventListener('click', () => {
    if (window.confirm('Reset every setting to its default? (Endpoints and API keys are kept.)')) window.ptolemy.send({ type: 'settingsReset' });
  });

  window.ptolemyConfig = { select };
})();
