'use strict';

// Configuration tab: a form generated from the server's settings schema. Changes apply
// immediately, are saved on the server (data/settings.json) and show up in every open tab.

(() => {
  const form = document.getElementById('config-form');
  const resetButton = document.getElementById('config-reset');
  const inputs = new Map(); // key -> { input, field, row }
  let rendered = false;
  let values = {};
  let secretsSet = {};

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

        const input = makeInput(field);
        input.addEventListener('change', () => {
          let value;
          if (field.type === 'boolean') value = input.checked;
          else if (field.type === 'number' || !field.type) value = Number(input.value);
          else value = input.value;
          // An empty secret box means "keep the saved key"; the Clear button removes it.
          if (field.type === 'secret' && !value) return;
          window.ptolemy.send({ type: 'settings', values: { [field.key]: value } });
          if (field.type === 'secret') input.value = '';
        });

        const extra = document.createElement('span');
        extra.className = 'config-default muted small';
        if (field.type === 'secret') {
          const clear = document.createElement('button');
          clear.type = 'button';
          clear.className = 'btn btn-ghost btn-small';
          clear.textContent = 'Clear';
          clear.addEventListener('click', () => window.ptolemy.send({ type: 'settings', values: { [field.key]: '' } }));
          extra.append(clear);
        } else if (field.models) {
          const list = document.createElement('button');
          list.type = 'button';
          list.className = 'btn btn-ghost btn-small';
          list.textContent = 'List models';
          list.title = 'Ask the server which models it has';
          list.addEventListener('click', () => {
            list.textContent = 'Asking...';
            window.ptolemy.send({ type: 'llmModels', provider: field.showIf && field.showIf.value });
          });
          extra.append(list);
        } else if (field.type === 'select') {
          extra.textContent = `default ${(field.options.find((o) => o.value === field.default) || {}).label || field.default}`;
        } else if (field.type === 'boolean') {
          extra.textContent = `default ${field.default ? 'on' : 'off'}`;
        } else if (field.type === 'text') {
          extra.textContent = field.default ? '' : 'default empty';
        } else if (field.type !== 'textarea') {
          extra.textContent = `default ${field.default}`;
        }

        row.append(name, input, extra);
        if (field.type === 'textarea') row.classList.add('config-row-wide');
        section.append(row);
        inputs.set(field.key, { input, field, row, extra });
      }
      form.append(section);
    }
    rendered = true;
  }

  function makeInput(field) {
    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      for (const option of field.options) input.append(new Option(option.label, option.value));
    } else if (field.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
    } else {
      input = document.createElement('input');
      if (field.type === 'boolean') {
        input.type = 'checkbox';
      } else if (field.type === 'text') {
        input.type = 'text';
        input.spellcheck = false;
        if (field.models) {
          const list = document.createElement('datalist');
          list.id = `models-${field.key.replace(/\W/g, '-')}`;
          form.append(list);
          input.setAttribute('list', list.id);
        }
      } else if (field.type === 'secret') {
        input.type = 'password';
        input.autocomplete = 'off';
      } else {
        input.type = 'number';
        Object.assign(input, { min: field.min, max: field.max, step: field.step });
      }
    }
    return input;
  }

  function fill() {
    for (const [key, { input, field, row }] of inputs) {
      if (field.showIf) row.hidden = values[field.showIf.key] !== field.showIf.value;
      if (!(key in values)) continue;
      if (field.type === 'boolean') {
        input.checked = values[key];
      } else if (field.type === 'secret') {
        input.placeholder = secretsSet[key] ? 'saved (type to replace)' : 'not set';
        input.classList.toggle('changed', Boolean(secretsSet[key]));
        continue;
      } else if (document.activeElement !== input || field.type !== 'textarea') {
        input.value = values[key];
      }
      input.classList.toggle('changed', values[key] !== field.default);
    }
  }

  document.addEventListener('ptolemy:settings', (ev) => {
    if (!rendered) render(ev.detail.schema);
    values = ev.detail.values;
    secretsSet = ev.detail.secretsSet || {};
    fill();
  });

  document.addEventListener('ptolemy:llmModels', (ev) => {
    const { provider, models, error } = ev.detail;
    const entry = inputs.get(`llm.${provider}.model`);
    if (!entry) return;
    const button = entry.extra.querySelector('button');
    if (error) {
      button.textContent = 'List models';
      window.alert(`Couldn't list models: ${error}`);
      return;
    }
    const list = document.getElementById(entry.input.getAttribute('list'));
    list.textContent = '';
    for (const id of models) list.append(new Option(id, id));
    button.textContent = `${models.length} models`;
    button.title = models.length ? 'Pick one from the Model box (clear it to see them all)' : 'The server listed no models';
    entry.input.focus();
  });

  resetButton.addEventListener('click', () => {
    if (window.confirm('Reset every setting to its default?')) window.ptolemy.send({ type: 'settingsReset' });
  });
})();
