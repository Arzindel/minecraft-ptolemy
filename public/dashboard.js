'use strict';

// Dashboard: the world Ptolemy thinks it's in, where the robot and player are, what the robot is
// doing, and its World Memory: todo list, what's on its mind, named areas, notes, recent activity
// and this world's own instructions. Everything is editable here as well as by the LLM.

(() => {
  const root = document.getElementById('dashboard');
  const send = (m) => window.ptolemy.send(m);
  const op = (name, fields = {}) => send({ type: 'memory', op: name, ...fields });

  const data = { world: null, status: null, positions: null, pilot: null, wonder: null, endpoints: null };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  // The Connection and Selected response cards are in the page already; the rest go between them.
  const inspectCard = document.getElementById('dash-inspect-card');
  const connectionCard = root.querySelector('.card-connection');

  function card(title, id, extraHead) {
    const body = el('div', { className: 'card-body', id: `dash-${id}` });
    const box = el('section', { className: `card card-${id}` }, el('header', { className: 'card-head' }, el('h3', { textContent: title }), extraHead || null), body);
    root.insertBefore(box, inspectCard);
    return body;
  }

  /** A one-line input + button that calls fn(value) and clears itself. */
  function adder(placeholder, fn, buttonText = 'Add') {
    const input = el('input', { type: 'text', placeholder });
    const go = () => {
      const v = input.value.trim();
      if (!v) return;
      fn(v);
      input.value = '';
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    const button = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: buttonText });
    button.addEventListener('click', go);
    return el('div', { className: 'adder' }, input, button);
  }

  function ago(time) {
    const s = Math.round((Date.now() - time) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  function removeButton(title, fn) {
    const b = el('button', { type: 'button', className: 'icon-btn', textContent: '×', title });
    b.addEventListener('click', fn);
    return b;
  }

  // --- Skeleton (built once) ----------------------------------------------------

  const worldBody = card('World', 'world');
  const nowBody = card('Right now', 'now');
  root.insertBefore(connectionCard, nowBody.parentElement.nextSibling);
  const todoBody = card('Todo list', 'todos', (() => {
    const b = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'Clear done' });
    b.addEventListener('click', () => op('todoClearDone'));
    return b;
  })());
  const todoList = el('ul', { className: 'dash-list' });
  todoBody.append(todoList, adder('Something to do...', (text) => op('todoAdd', { text })));

  const thoughtBody = card('On its mind', 'thoughts');
  const thoughtList = el('ul', { className: 'dash-list' });
  thoughtBody.append(thoughtList, adder('Give it a thought, e.g. "I want to see flowers"', (text) => op('thoughtAdd', { text }), 'Think'));

  const areaBody = card('Areas', 'areas');
  const areaList = el('div', { className: 'area-list' });
  areaBody.append(areaList, areaForm());

  const noteBody = card('Notes', 'notes');
  const noteList = el('ul', { className: 'dash-list' });
  noteBody.append(noteList, adder('A fact worth keeping, e.g. "the wood chest is at 10 64 5"', (text) => op('noteAdd', { text }), 'Save'));

  const journalBody = card('Recent activity', 'journal');
  const instructionsBody = card('Instructions for this world', 'instructions');
  const instructions = el('textarea', { rows: 4, placeholder: 'Only for this world, e.g. "Stay out of the basement. Build with cobblestone from slot 1."' });
  instructions.addEventListener('change', () => op('instructions', { text: instructions.value }));
  instructionsBody.append(instructions, el('p', { className: 'muted small', textContent: 'Added to the LLM\'s prompt in this world only. Saved when you click away.' }));

  function areaForm() {
    const name = el('input', { type: 'text', placeholder: 'Name, e.g. kitchen' });
    const coords = el('input', { type: 'text', placeholder: 'x1 y1 z1 x2 y2 z2' });
    const add = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'Add' });
    add.addEventListener('click', () => {
      const n = coords.value.trim().split(/[\s,]+/).map(Number);
      if (!name.value.trim() || !(n.length === 3 || n.length === 6) || n.some((v) => !Number.isFinite(v))) {
        window.alert('Give a name and 3 or 6 numbers (one corner, or two opposite corners).');
        return;
      }
      op('areaSet', { name: name.value, a: n.slice(0, 3), b: n.length === 6 ? n.slice(3) : n.slice(0, 3) });
      name.value = '';
      coords.value = '';
    });
    const radius = el('input', { type: 'number', min: 0, max: 64, value: 3, title: 'Blocks around, in every direction' });
    const around = (who) => {
      const b = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: `Around ${who}` });
      b.addEventListener('click', () => {
        if (!name.value.trim()) {
          window.alert('Give the area a name first.');
          return;
        }
        op('areaAround', { name: name.value, who: who === 'me' ? 'player' : 'robot', radius: Number(radius.value) });
        name.value = '';
      });
      return b;
    };
    return el('div', { className: 'area-form' },
      el('div', { className: 'adder' }, name, coords, add),
      el('div', { className: 'adder small' }, el('span', { className: 'muted', textContent: 'or a box of radius' }), radius, around('me'), around('the robot')));
  }

  // --- Rendering ------------------------------------------------------------------

  function renderWorld() {
    worldBody.textContent = '';
    const st = data.status;
    const w = data.world;
    if (!st) return;
    if (w) {
      const name = el('input', { type: 'text', className: 'world-name', value: w.name, title: 'Rename this world' });
      name.addEventListener('change', () => op('rename', { name: name.value }));
      worldBody.append(name);
    } else {
      worldBody.append(el('p', { className: 'muted', textContent: 'No world loaded yet.' }));
    }
    worldBody.append(el('p', { className: `detect detect-${st.detection.state}`, textContent: st.detection.message }));
    if (w) worldBody.append(el('p', { className: 'muted small', textContent: `id ${w.id} · first seen ${new Date(w.createdAt).toLocaleDateString()}` }));

    const agent = st.agent || {};
    if (agent.exists === false) {
      const create = el('button', { type: 'button', className: 'btn btn-primary btn-small', textContent: 'Create the agent' });
      create.addEventListener('click', () => op('agentCreate'));
      worldBody.append(el('p', { className: 'warn' }, 'This world has no agent yet. ', create));
    }
    const redetect = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'Detect again' });
    redetect.addEventListener('click', () => op('detect'));
    worldBody.append(el('div', { className: 'row-buttons' }, redetect));

    const others = (st.worlds || []).filter((o) => !w || o.id !== w.id);
    if (others.length) {
      const list = el('ul', { className: 'dash-list' });
      for (const o of others) {
        const claim = el('button', { type: 'button', className: 'btn btn-ghost btn-small', textContent: 'This is it', title: 'The open game world is actually this one: switch to its memory and re-mark the game world' });
        claim.addEventListener('click', () => {
          if (window.confirm(`Treat the open game world as "${o.name}"? Its marker will be changed to match.`)) op('claim', { id: o.id });
        });
        const del = removeButton('Delete this world\'s memory', () => {
          if (window.confirm(`Delete everything Ptolemy remembers about "${o.name}"?`)) op('deleteWorld', { id: o.id });
        });
        list.append(el('li', {}, el('span', { className: 'grow', textContent: o.name }),
          el('span', { className: 'muted small', textContent: `${o.areas} areas · ${ago(o.lastSeenAt)}` }), claim, del));
      }
      worldBody.append(el('details', { className: 'other-worlds' }, el('summary', { textContent: `Other worlds (${others.length})` }), list));
    }
  }

  function renderNow() {
    nowBody.textContent = '';
    const p = data.positions;
    const dl = el('dl', { className: 'facts' });
    const fact = (k, v) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
    if (p && p.robot) fact('Robot', `${p.robot.x} ${p.robot.y} ${p.robot.z} facing ${p.robot.facing}${p.robot.areas ? ` · in ${p.robot.areas}` : ''}`);
    else fact('Robot', data.status && data.status.agent.exists === false ? 'no agent in this world' : 'unknown');
    if (p && p.player) fact('Player', `${p.player.x} ${p.player.y} ${p.player.z}${p.player.areas ? ` · in ${p.player.areas}` : ''}`);
    else fact('Player', 'unknown');

    const pilot = data.pilot;
    if (pilot) {
      const doing = !pilot.running ? 'idle'
        : `${pilot.source === 'wonder' ? 'wondering' : pilot.source === 'chat' ? 'on a chat request' : 'on a request'} · ${pilot.phase}${pilot.phase === 'tool' ? ` ${pilot.detail}` : ''}`;
      fact('Doing', doing);
    }
    if (data.wonder) {
      const wd = data.wonder;
      let text = { off: 'off', on: 'on (until someone asks)', always: 'always on' }[wd.mode];
      if (wd.mode !== 'off') text += wd.blocked ? ` · paused: ${wd.blocked}` : wd.nextAt ? ` · next in ${Math.max(0, Math.ceil((wd.nextAt - Date.now()) / 1000))}s` : '';
      fact('Wondering', text);
    }
    const ep = data.endpoints && data.endpoints.endpoints.find((e) => e.id === data.endpoints.active);
    if (ep) {
      const dd = el('dd', {}, `${ep.name}${ep.model ? ` · ${ep.model}` : ''} `);
      for (const kind of ['endpoint', 'model', 'mcp']) {
        const r = ep.tests[kind];
        dd.append(el('span', { className: `dot ${r ? (r.running ? 'running' : r.ok ? 'ok' : 'fail') : ''}`, title: `${kind}: ${r ? r.message : 'not tested'}` }));
      }
      const link = el('button', { type: 'button', className: 'link-btn', textContent: 'set up' });
      link.addEventListener('click', () => {
        window.ptolemy.selectTab('config');
        if (window.ptolemyConfig) window.ptolemyConfig.select('llm');
      });
      dd.append(' ', link);
      dl.append(el('dt', { textContent: 'LLM' }), dd);
    }
    nowBody.append(dl);
  }

  function renderMemory() {
    const w = data.world;
    todoList.textContent = '';
    thoughtList.textContent = '';
    areaList.textContent = '';
    noteList.textContent = '';
    journalBody.textContent = '';
    if (!w) {
      for (const list of [todoList, thoughtList, noteList]) list.append(el('li', { className: 'muted', textContent: 'No world loaded.' }));
      return;
    }

    const NEXT = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
    const MARK = { pending: '○', in_progress: '◐', done: '●' };
    for (const t of w.todos) {
      const toggle = el('button', { type: 'button', className: `todo-mark ${t.status}`, textContent: MARK[t.status], title: `${t.status.replace('_', ' ')} (click to change)` });
      toggle.addEventListener('click', () => op('todoUpdate', { id: t.id, status: NEXT[t.status] }));
      list(todoList, el('li', { className: `todo ${t.status}` }, toggle, el('span', { className: 'grow', textContent: t.text }), removeButton('Remove', () => op('todoRemove', { id: t.id }))));
    }
    if (!w.todos.length) todoList.append(el('li', { className: 'muted', textContent: 'Nothing to do. The LLM writes its plans here too.' }));

    for (const t of [...w.thoughts].reverse()) {
      list(thoughtList, el('li', {}, el('span', { className: 'grow thought', textContent: `“${t.text}”` }),
        el('span', { className: 'muted small', textContent: ago(t.time) }), removeButton('Let go', () => op('thoughtRemove', { id: t.id }))));
    }
    if (!w.thoughts.length) thoughtList.append(el('li', { className: 'muted', textContent: 'A clear mind.' }));

    if (w.areas.length) {
      const table = el('table', { className: 'area-table' });
      table.append(el('tr', {}, ...['Name', 'From', 'To', 'Part of', ''].map((h) => el('th', { textContent: h }))));
      // Parents first, children indented under them.
      const depth = (a) => (a.parent ? 1 + depth(w.areas.find((o) => o.name === a.parent) || {}) : 0);
      const ordered = [];
      const add = (parent) => w.areas.filter((a) => (a.parent || null) === parent).forEach((a) => { ordered.push(a); add(a.name); });
      add(null);
      for (const a of w.areas) if (!ordered.includes(a)) ordered.push(a);
      for (const a of ordered) {
        table.append(el('tr', {},
          el('td', { className: 'area-name', textContent: `${'  '.repeat(depth(a))}${depth(a) ? '└ ' : ''}${a.name}`, title: a.note || '' }),
          el('td', { textContent: a.min.join(' ') }), el('td', { textContent: a.max.join(' ') }),
          el('td', { className: 'muted', textContent: a.parent || '' }),
          el('td', {}, removeButton('Forget this area', () => op('areaRemove', { name: a.name })))));
      }
      areaList.append(table);
    } else {
      areaList.append(el('p', { className: 'muted small', textContent: 'No areas yet. Name the places the robot should know: a house, the kitchen in it, the farm...' }));
    }

    for (const n of w.notes) list(noteList, el('li', {}, el('span', { className: 'grow', textContent: n.text }), removeButton('Forget', () => op('noteRemove', { id: n.id }))));
    if (!w.notes.length) noteList.append(el('li', { className: 'muted', textContent: 'No notes yet.' }));

    const journal = el('ul', { className: 'dash-list journal' });
    for (const j of [...w.journal].reverse().slice(0, 15)) {
      const src = { ui: 'WebUI', chat: 'chat', wonder: 'wondering' }[j.source] || j.source;
      journal.append(el('li', {}, el('span', { className: 'muted small nowrap', textContent: `${ago(j.time)} · ${src}` }),
        el('span', { className: 'grow' }, j.request ? el('strong', { textContent: `${j.request} ` }) : null, j.result)));
    }
    if (!w.journal.length) journal.append(el('li', { className: 'muted', textContent: 'Nothing yet.' }));
    journalBody.append(journal);

    if (document.activeElement !== instructions) instructions.value = w.instructions || '';
  }

  function list(ul, li) {
    ul.append(li);
  }

  // --- Events -------------------------------------------------------------------------

  const on = (name, fn) => document.addEventListener(`ptolemy:${name}`, (ev) => fn(ev.detail));
  on('memory', (m) => { data.world = m.world; renderMemory(); renderWorld(); });
  on('worldStatus', (s) => { data.status = s; renderWorld(); renderNow(); });
  on('positions', (p) => { data.positions = p; renderNow(); });
  on('pilot', (p) => { data.pilot = p; renderNow(); });
  on('wonder', (w) => { data.wonder = w; renderNow(); });
  on('endpoints', (e) => { data.endpoints = e; renderNow(); });
  on('agent', (a) => {
    // Live robot position while it walks a path.
    if (data.positions && data.positions.robot) {
      Object.assign(data.positions.robot, a.position);
      renderNow();
    }
  });
  on('memoryError', (e) => window.alert(e.message));
  setInterval(() => { if (data.wonder && data.wonder.nextAt) renderNow(); }, 1000);

  renderMemory();
})();
