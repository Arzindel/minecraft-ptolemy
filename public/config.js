'use strict';

// Configuration tab: a form generated from the server's settings schema. Changes apply
// immediately, are saved on the server (data/settings.json) and show up in every open tab.

(() => {
  const form = document.getElementById('config-form');
  const resetButton = document.getElementById('config-reset');
  const inputs = new Map(); // key -> input
  let rendered = false;

  function render(schema) {
    form.textContent = '';
    for (const group of schema) {
      const section = document.createElement('fieldset');
      section.className = 'config-group';
      const legend = document.createElement('legend');
      legend.textContent = group.group;
      section.append(legend);
      if (group.help) {
        const help = document.createElement('p');
        help.className = 'muted small';
        help.textContent = group.help;
        section.append(help);
      }

      for (const field of group.fields) {
        const row = document.createElement('label');
        row.className = 'config-row';
        const name = document.createElement('span');
        name.className = 'config-label';
        name.textContent = field.label;
        if (field.help) name.title = field.help;

        const input = document.createElement('input');
        if (field.type === 'boolean') {
          input.type = 'checkbox';
        } else {
          input.type = 'number';
          Object.assign(input, { min: field.min, max: field.max, step: field.step });
        }
        input.addEventListener('change', () => {
          const value = field.type === 'boolean' ? input.checked : Number(input.value);
          window.ptolemy.send({ type: 'settings', values: { [field.key]: value } });
        });

        const def = document.createElement('span');
        def.className = 'config-default muted small';
        def.textContent = `default ${field.type === 'boolean' ? (field.default ? 'on' : 'off') : field.default}`;

        row.append(name, input, def);
        section.append(row);
        inputs.set(field.key, { input, field });
      }
      form.append(section);
    }
    rendered = true;
  }

  function fill(values) {
    for (const [key, { input, field }] of inputs) {
      if (!(key in values)) continue;
      if (field.type === 'boolean') input.checked = values[key];
      else input.value = values[key];
      input.classList.toggle('changed', values[key] !== field.default);
    }
  }

  document.addEventListener('ptolemy:settings', (ev) => {
    if (!rendered) render(ev.detail.schema);
    fill(ev.detail.values);
  });

  resetButton.addEventListener('click', () => {
    if (window.confirm('Reset every setting to its default?')) window.ptolemy.send({ type: 'settingsReset' });
  });
})();
