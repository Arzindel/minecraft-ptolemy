'use strict';

// Tutorial tab: how Ptolemy works and what every setting does. The guides are written here; the
// "Every setting" reference at the end is built from the server's settings schema (labels, defaults
// and help texts), so it always matches the Configuration tab. Clicking a setting jumps to it.

(() => {
  const toc = document.getElementById('tutorial-toc');
  const body = document.getElementById('tutorial-body');

  const GUIDES = [
    ['start', 'Getting started', `
      <ol>
        <li>Start Ptolemy with <code>start.bat</code> (Windows) or <code>./start.sh</code> (macOS, Linux). It finds Node.js
          (or downloads a private copy into <code>.node/</code>), installs what's needed, starts, and opens this page.</li>
        <li>In Minecraft (a world with cheats on, and Education Edition features on for the agent), run the
          <code>/connect</code> command shown at the top of the page.</li>
        <li>No robot yet? A <b>Create Agent</b> box covers the Automatic panel: press it. Every player has one agent of their
          own; Ptolemy only ever sees and drives yours, never another player's.</li>
        <li>Pick an LLM under <b>Configuration → LLM</b>. The default, and the recommended one, is NVIDIA Build with
          <code>google/gemma-4-31b-it</code>: paste an nvapi key into its card. Then talk to the robot in the Automatic panel or
          the game chat.</li>
      </ol>`],
    ['talk', 'Talking to the robot', `
      <p>Two ways in: the <b>Automatic</b> panel on the Robot tab, and the <b>game chat</b>. In the chat, a message is for
        the robot when it contains its <b>wake word</b> (its name, <i>Ptolemy</i> by default), and not the <b>ignore
        word</b> (<i>Ptoless</i>), which lets you talk <i>about</i> it. <code>Ptolemy, stop</code> stops it.</p>
      <ul>
        <li><b>Only my player can call it</b>: only the player at this computer (whose game is connected) can give chat
          requests. Off: anyone in the world can.</li>
        <li><b>Answer chat requests in chat</b>: what it says about a chat request goes to the chat; WebUI requests are
          answered in the WebUI.</li>
        <li>It can be renamed from the chat: "Ptolemy, your name is now Boris".</li>
      </ul>`],
    ['interrupt', 'Interrupting and waiting in line', `
      <p>While the robot is busy, new requests either wait their turn (the queue holds 5) or cut in:</p>
      <table class="tutorial-table">
        <tr><th>Request from</th><th>While wondering</th><th>While working on a request</th></tr>
        <tr><td>The WebUI</td><td>waits</td><td>waits (use the <b>Stop</b> button to cut in)</td></tr>
        <tr><td>A player in the chat</td><td>interrupts</td><td>interrupts if <b>Players can always interrupt</b> is on
          (the default); otherwise waits, unless it contains an <b>interrupt word</b> (<i>hey hey, wait, stop</i>)</td></tr>
        <tr><td>Another robot</td><td>interrupts if <b>Robots can interrupt wondering</b></td><td>always waits</td></tr>
      </table>`],
    ['distracted', 'Distracted', `
      <p>Now and then the robot doesn't catch what's said to it in the chat: <b>Distracted: chance to miss a message</b>
        (1% by default). A missed message shows in the Automatic transcript, crossed out, but the model never sees it,
        and nothing is interrupted: not a request, not wondering.</p>
      <ul>
        <li>A message with an <b>exception mark</b> is never missed. The default is <code>!</code>: "Ptolemy, come here!"
          always gets through. Several marks or words, comma-separated.</li>
        <li>A bare "Ptolemy, stop" and everything from the WebUI are never missed.</li>
        <li>It applies to other robots' messages too.</li>
      </ul>`],
    ['robots', 'Other robots', `
      <p>If other players run Ptolemy too, their robots can talk to yours (and yours to them) in the chat.</p>
      <ul>
        <li>A robot only hears chat messages that contain its <b>name</b>. Both robots know this, so they end a conversation
          by not saying the other's name, and don't answer a goodbye.</li>
        <li><b>Listen to other robots</b> turns it on or off; <b>Robots can interrupt wondering</b> lets them break into
          a wander. They never interrupt a person's request, can't stop the robot, and can't allow flying or teleporting.</li>
        <li>Give the robots different names: a line signed with your robot's own name is always taken as its own.</li>
        <li>While wondering, the robot may say something to a player or a robot now and then.</li>
      </ul>`],
    ['wonder', 'Wondering', `
      <p>The <b>Wondering</b> switch above the conversation lets the robot act on its own when idle: after
        <b>Idle seconds before wondering</b> without anything happening, the model gets the <b>wondering prompt</b>.</p>
      <ul>
        <li><b>Off</b>: never. <b>On</b>: until someone asks for something. <b>Always on</b>: pauses for requests, then
          carries on.</li>
        <li><b>Max model calls per wander</b> keeps each wander short.</li>
      </ul>`],
    ['mind', 'On its mind: fading thoughts, Forget and ADHD', `
      <p>The robot keeps a few passing thoughts ("I want to see the flowers") and may act on them while wondering.</p>
      <ul>
        <li><b>Thoughts fade after</b> a number of seconds, and only the newest <b>Most thoughts kept</b> stay. 0 turns
          either off. The Dashboard shows when each one fades.</li>
        <li><b>Forget</b>: before a wander, on its chance, every thought is wiped and replaced by the forget text
          ("I forgot what I was thinking about").</li>
        <li><b>ADHD</b>: before a wander, on its own chance, a random shower thought from the list goes on top of its mind.
          With <b>ADHD: AI-generate thoughts</b>, the model is asked (with the shower thought prompt, no
          conversation, no tools) for a new one, which joins the list before one is picked.</li>
        <li>Both at once: the mind is wiped and the shower thought takes the place of the forget text.</li>
      </ul>`],
    ['time', 'Time, weather and placeholders', `
      <p>Ptolemy reads the game's clock and weather (never changes them) every few seconds, shown on the Dashboard as a
        24-hour clock and told to the model with every request.</p>
      <p>The model takes a while to answer, so it can write <b>placeholders</b> that are filled in the moment a message is
        sent: <code>{time_now}</code>, <code>{weather}</code>, <code>{day}</code>, <code>{my_coordinates}</code>.
        "It's {time_now}" is exact even if the answer took a minute.</p>`],
    ['build', 'Breaking and building', `
      <p>Every block action works on <b>one cell touching the robot</b>, named from the robot's point of view:
        <b>forward</b>, <b>back</b>, <b>left</b>, <b>right</b>, <b>up</b> (the cell above it) and <b>down</b> (the cell
        under it). "Down" is a place, not "put it down": a block placed in front of the robot is <i>forward</i>. Given a
        position instead of a direction, the robot first walks beside it.</p>
      <p>The robot takes up one cell. It can never act on the cell it is standing in, and never move into a solid block: it
        always works on a cell <i>next</i> to it. To put a block where it stands, it moves up and places down (or, if up is
        blocked, steps to a free side and places back towards the cell it left); place and replace do that by
        themselves when given the robot's own position.</p>
      <table class="tutorial-table">
        <tr><th>Tool</th><th>Console</th><th>What it does</th></tr>
        <tr><td>destroy</td><td></td><td>Breaks the block there.</td></tr>
        <tr><td>safe_destroy</td><td><code>#safe_destroy oak_log forward</code></td><td>Breaks it only if it is that block.</td></tr>
        <tr><td>place</td><td></td><td>Fills an <i>empty</i> cell from an inventory slot.</td></tr>
        <tr><td>replace</td><td><code>#replace 1 forward</code></td><td>Breaks what's there, then places: always ends with
          the new block, unless the slot is empty (then it only breaks).</td></tr>
        <tr><td>safe_replace</td><td><code>#safe_replace dirt 1 down</code></td><td>Replaces only if the block there is that block.</td></tr>
      </table>
      <p>The robot is told to prefer the <b>safe</b> versions whenever it knows what the block is (it usually does: it
        is told what touches it, and can scan), so a wrong direction or an old position never breaks the wrong thing. It
        uses plain destroy / replace only when it can't know, or when any block will do.</p>
      <p>When nothing changed, the action fails (✗ in the transcript) and says why: nothing to break, a block that won't
        break, the cell isn't empty (use replace), a player, mob or robot standing in the way, or else probably an empty
        inventory slot.</p>`],
    ['inventory', 'Inventory', `
      <p>The agent has 27 slots (three rows of nine). Nothing can read them, but they can be written, so Ptolemy keeps
        chosen slots stocked instead of knowing what's in them.</p>
      <ul>
        <li><b>Hold</b> a slot (1-26) with an item: it is refilled every second (<b>Refill held slots every</b>, with
          <b>Items put in a held slot</b>), so it never runs out, and the robot is told what it holds. Use the Dashboard's
          <b>Inventory</b> card (click a slot, type an item id like <code>oak_planks</code>, <b>Hold</b>), <code>#hold 1
          oak_planks</code>, or ask the robot. <b>Variant</b> picks a variant of old ids: <code>wood</code> 1 is spruce.</li>
        <li><b>Release</b> only stops tracking it: a slot can't be emptied, so what's left is simply unknown.</li>
        <li><b>Slot 27</b> is scratch space: <code>give_item</code> (<code>#give_item torch 3</code>) makes the items there
          and drops them towards you. <code>drop</code> (<code>#drop_inv 1 3</code>) drops from any slot.</li>
      </ul>`],
    ['see', 'How the robot sees', `
      <ul>
        <li><b>The map</b>: every block it has seen, kept on disk per world. <b>Vision</b> looks at a small cube around it
          after every step (and every few seconds when idle).</li>
        <li><b>Awareness radius</b>: the part of the map around it the model is told about with every request.</li>
        <li><b>scan</b> / <code>#scan</code>: looks at a cube (up to radius 15) and describes the whole of it, with a
          top-down height grid.</li>
        <li><b>survey</b> / <code>#survey</code>: a view from above with gettopsolidblock, to see how far down a cliff goes
          or how high a wall or tree is.</li>
        <li><b>Nanny Cam</b>: the map in 3D, zoom up to 100 blocks.</li>
      </ul>`],
  ];

  // Where a settings group lives, and how to get there.
  function whereIs(group, tabs) {
    if (group.tab === 'automatic') return { text: 'Robot tab → Chat & wondering card', go: () => window.ptolemy.selectTab('robot') };
    const tab = tabs.find((t) => t.id === group.tab);
    return {
      text: `Configuration → ${tab ? tab.label : group.tab}`,
      go: () => {
        window.ptolemy.selectTab('config');
        if (window.ptolemyConfig) window.ptolemyConfig.select(group.tab);
      },
    };
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  function section(id, title) {
    const s = el('section', { className: 'tutorial-section', id: `tutorial-${id}` }, el('h2', { textContent: title }));
    const link = el('a', { href: `#tutorial-${id}`, textContent: title });
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      s.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    toc.append(link);
    return s;
  }

  for (const [id, title, html] of GUIDES) {
    const s = section(id, title);
    s.insertAdjacentHTML('beforeend', html); // our own text, above
    body.append(s);
  }
  const reference = section('settings', 'Every setting');
  reference.append(el('p', { className: 'muted', textContent: 'Waiting for the server...' }));
  body.append(reference);

  function defaultText(f) {
    if (f.type === 'boolean') return f.default ? 'on' : 'off';
    if (f.type === 'select') return (f.options.find((o) => o.value === f.default) || {}).label || f.default;
    if (f.type === 'textarea') return 'a text (see the field)';
    if (f.type === 'text') return f.default ? `"${f.default}"` : 'empty';
    return String(f.default);
  }

  let rendered = false;
  document.addEventListener('ptolemy:settings', (ev) => {
    if (rendered) return;
    rendered = true;
    const { schema, tabs } = ev.detail;
    reference.textContent = '';
    reference.append(el('h2', { textContent: 'Every setting' }),
      el('p', { className: 'muted', textContent: 'Straight from the settings themselves. Settings marked "this world" are kept '
        + 'separately for each Minecraft world. Click a group\'s location to go there.' }));
    for (const group of schema) {
      const fields = group.fields.filter((f) => !f.hidden);
      if (!fields.length) continue;
      const where = whereIs(group, tabs);
      const go = el('button', { type: 'button', className: 'link-btn', textContent: where.text });
      go.addEventListener('click', where.go);
      const dl = el('dl', { className: 'tutorial-settings' });
      for (const f of fields) {
        dl.append(el('dt', {}, el('b', { textContent: f.label }), el('span', { className: 'muted small',
          textContent: ` · default ${defaultText(f)}${f.scope === 'world' ? ' · this world' : ''}` })),
        el('dd', { textContent: f.help || '' }));
      }
      reference.append(el('h3', {}, `${group.group} `, el('span', { className: 'small' }, '(', go, ')')),
        group.help ? el('p', { className: 'muted small', textContent: group.help }) : null, dl);
    }
  });
})();
