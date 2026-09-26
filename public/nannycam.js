'use strict';

// Nanny Cam: a WebGL2 view of the robot's Sight. Every block is the same unit cube drawn with
// instancing (one draw call per pass), so tens of thousands of blocks are cheap on any GPU.
/* global blockRgb, isTranslucent */

(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('cam-canvas');
  const tooltip = $('cam-tooltip');
  const empty = $('cam-empty');
  const info = $('cam-info');
  const radiusInput = $('cam-radius');
  const radiusValue = $('cam-radius-value');
  const scanRadius = $('cam-scan-radius');
  const scanButton = $('cam-scan');

  const AGENT_COLOR = [0.95, 0.76, 0.2, 1];
  // Walking paths are cyan, flight paths magenta; walked cells and finished trails fade.
  const PATH_COLORS = { walk: [0.2, 0.85, 0.95], fly: [0.95, 0.35, 0.85] };
  const TRANSLUCENT_ALPHA = 0.45;

  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) {
    empty.textContent = 'Your browser has WebGL2 turned off, so the Nanny Cam can’t draw.';
    return;
  }

  // --- Small matrix helpers (column-major, as WebGL expects) ------------------

  const mat4 = {
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      const nf = 1 / (near - far);
      return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
    },
    lookAt(eye, target, up) {
      const z = norm(sub(eye, target));
      const x = norm(cross(up, z));
      const y = cross(z, x);
      return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
    },
    multiply(a, b) {
      const out = new Array(16);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
          out[c * 4 + r] = sum;
        }
      }
      return out;
    },
    invert(m) {
      const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
      const b00 = a00 * a11 - a01 * a10; const b01 = a00 * a12 - a02 * a10;
      const b02 = a00 * a13 - a03 * a10; const b03 = a01 * a12 - a02 * a11;
      const b04 = a01 * a13 - a03 * a11; const b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30; const b07 = a20 * a32 - a22 * a30;
      const b08 = a20 * a33 - a23 * a30; const b09 = a21 * a32 - a22 * a31;
      const b10 = a21 * a33 - a23 * a31; const b11 = a22 * a33 - a23 * a32;
      const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
      return [
        (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
        (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
        (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
        (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
        (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
        (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
        (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
        (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
      ];
    },
    transform(m, [x, y, z, w]) {
      return [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * w);
    },
  };
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  // --- GPU setup ---------------------------------------------------------------

  const VERTEX_SHADER = `#version 300 es
    in vec3 a_pos;
    in vec3 a_normal;
    in vec4 i_offset;   // xyz = corner of the cube, w = edge length
    in vec4 i_color;
    uniform mat4 u_viewProj;
    out vec4 v_color;
    out vec3 v_local;
    void main() {
      gl_Position = u_viewProj * vec4(i_offset.xyz + a_pos * i_offset.w, 1.0);
      float light = 0.6 + 0.4 * max(dot(a_normal, normalize(vec3(0.35, 1.0, 0.2))), 0.0);
      v_color = vec4(i_color.rgb * light, i_color.a);
      v_local = a_pos;
    }`;

  const FRAGMENT_SHADER = `#version 300 es
    precision mediump float;
    in vec4 v_color;
    in vec3 v_local;
    out vec4 outColor;
    void main() {
      // Darken a thin border on every face so individual blocks stay readable.
      vec3 d = min(v_local, 1.0 - v_local);
      float second = d.x + d.y + d.z - min(d.x, min(d.y, d.z)) - max(d.x, max(d.y, d.z));
      float edge = 1.0 - 0.3 * (1.0 - smoothstep(0.02, 0.05, second));
      outColor = vec4(v_color.rgb * edge, v_color.a);
    }`;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const loc = {
    pos: gl.getAttribLocation(program, 'a_pos'),
    normal: gl.getAttribLocation(program, 'a_normal'),
    offset: gl.getAttribLocation(program, 'i_offset'),
    color: gl.getAttribLocation(program, 'i_color'),
    viewProj: gl.getUniformLocation(program, 'u_viewProj'),
  };

  // Unit cube, 6 faces x 2 triangles, with per-face normals.
  const FACES = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[0, -1, 0], [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]]],
    [[0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  const cube = [];
  for (const [n, [a, b, c, d]] of FACES) for (const v of [a, b, c, a, c, d]) cube.push(...v, ...n);

  const cubeBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cube), gl.STATIC_DRAW);

  function makeBatch() {
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffer);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(loc.normal);
    gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc.offset);
    gl.vertexAttribPointer(loc.offset, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(loc.offset, 1);
    gl.enableVertexAttribArray(loc.color);
    gl.vertexAttribPointer(loc.color, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(loc.color, 1);
    gl.bindVertexArray(null);
    return { vao, buffer, count: 0 };
  }

  const batches = { opaque: makeBatch(), translucent: makeBatch(), agent: makeBatch(), path: makeBatch() };

  function upload(batch, instances) {
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instances), gl.DYNAMIC_DRAW);
    batch.count = instances.length / 8;
  }

  // --- Scene state -------------------------------------------------------------

  let sight = null;
  // Planned routes by kind: { cells: [[x, y, z], ...] starting at the robot, trail: already walked }
  const paths = { walk: { cells: [], trail: false }, fly: { cells: [], trail: false } };
  let agentPos = [0, 0, 0];
  let visible = new Map(); // "x,y,z" -> block name, for hover lookups
  const camera = { yaw: Math.PI / 4, pitch: 0.6, distance: 28 };

  const FACING_NAMES = ['Z+ (south)', 'X- (west)', 'Z- (north)', 'X+ (east)'];

  function facingVector(yRot) {
    const snapped = (((Math.round(yRot / 90) * 90) % 360) + 360) % 360;
    return { 0: [0, 0, 1], 90: [-1, 0, 0], 180: [0, 0, -1], 270: [1, 0, 0] }[snapped];
  }

  function rebuild() {
    if (!sight) return;
    tooltip.hidden = true;
    const radius = Number(radiusInput.value);
    const [ax, ay, az] = agentPos;

    // Blocks within the zoom radius (a cube around the robot, measured in blocks).
    const within = new Map();
    const { palette, blocks } = sight;
    for (let i = 0; i < blocks.length; i += 4) {
      const x = blocks[i]; const y = blocks[i + 1]; const z = blocks[i + 2];
      if (Math.max(Math.abs(x - ax), Math.abs(y - ay), Math.abs(z - az)) > radius) continue;
      within.set(`${x},${y},${z}`, palette[blocks[i + 3]]);
    }

    // Skip blocks whose six neighbours are all solid: they can't be seen.
    const solid = (key) => within.has(key) && !isTranslucent(within.get(key));
    const opaque = [];
    const translucent = [];
    visible = new Map();
    for (const [key, name] of within) {
      const [x, y, z] = key.split(',').map(Number);
      const see = isTranslucent(name);
      const hidden = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].every(([dx, dy, dz]) => {
        const k = `${x + dx},${y + dy},${z + dz}`;
        return solid(k) || (see && within.get(k) === name);
      });
      if (hidden) continue;
      visible.set(key, name);
      const [r, g, b] = blockRgb(name);
      (see ? translucent : opaque).push(x, y, z, 1, r, g, b, see ? TRANSLUCENT_ALPHA : 1);
    }
    upload(batches.opaque, opaque);
    upload(batches.translucent, translucent);

    // The robot: a body plus a small "nose" on the side it's facing.
    const [fx, , fz] = facingVector(sight.agent.yRot);
    upload(batches.agent, [
      ax + 0.15, ay + 0.1, az + 0.15, 0.7, ...AGENT_COLOR,
      ax + 0.35 + fx * 0.5, ay + 0.45, az + 0.35 + fz * 0.5, 0.3, ...AGENT_COLOR.map((c, i) => (i < 3 ? c * 0.6 : c)),
    ]);

    // Planned routes: a bead per cell, already-walked cells faded.
    const beads = [];
    for (const [kind, { cells, trail }] of Object.entries(paths)) {
      const at = cells.findIndex(([x, y, z]) => x === ax && y === ay && z === az);
      cells.forEach(([x, y, z], i) => {
        if (x === ax && y === ay && z === az) return; // don't draw inside the robot
        const walked = trail || (at !== -1 && i <= at);
        beads.push(x + 0.375, y + 0.375, z + 0.375, 0.25, ...PATH_COLORS[kind], walked ? 0.25 : 1);
      });
    }
    upload(batches.path, beads);

    info.textContent = `${sight.scanned.toLocaleString()} blocks scanned at ${ax} ${ay} ${az}, `
      + `facing ${FACING_NAMES[(((Math.round(sight.agent.yRot / 90) % 4) + 4) % 4)]} · `
      + `${visible.size.toLocaleString()} drawn · `
      + `${new Date(sight.time).toLocaleTimeString([], { hour12: false })}`;
    requestDraw();
  }

  // --- Drawing ----------------------------------------------------------------

  let viewProj = null;
  let drawQueued = false;

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(draw);
  }

  function eyePosition() {
    const target = [agentPos[0] + 0.5, agentPos[1] + 0.5, agentPos[2] + 0.5];
    const { yaw, pitch, distance } = camera;
    return {
      target,
      eye: [
        target[0] + distance * Math.cos(pitch) * Math.sin(yaw),
        target[1] + distance * Math.sin(pitch),
        target[2] + distance * Math.cos(pitch) * Math.cos(yaw),
      ],
    };
  }

  function draw() {
    drawQueued = false;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    gl.viewport(0, 0, width, height);
    gl.clearColor(0.07, 0.075, 0.085, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!sight) return;

    const { eye, target } = eyePosition();
    viewProj = mat4.multiply(
      mat4.perspective(Math.PI / 4, width / height, 0.1, 1000),
      mat4.lookAt(eye, target, [0, 1, 0]),
    );

    gl.useProgram(program);
    gl.uniformMatrix4fv(loc.viewProj, false, viewProj);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const batch of [batches.opaque, batches.agent]) {
      gl.bindVertexArray(batch.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, batch.count);
    }

    // See-through blocks last, blended over everything and without hiding each other.
    // The path is drawn with them so it stays visible through leaves, grass and water.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const batch of [batches.path, batches.translucent]) {
      gl.bindVertexArray(batch.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, batch.count);
    }
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  new ResizeObserver(requestDraw).observe(canvas);

  // --- Mouse: drag to orbit, wheel to move the camera, hover to identify ------

  let drag = null;

  canvas.addEventListener('pointerdown', (ev) => {
    drag = { x: ev.clientX, y: ev.clientY };
    canvas.setPointerCapture(ev.pointerId);
    tooltip.hidden = true;
  });
  canvas.addEventListener('pointerup', (ev) => {
    drag = null;
    canvas.releasePointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      camera.yaw -= (ev.clientX - drag.x) * 0.008;
      camera.pitch = Math.max(-1.45, Math.min(1.45, camera.pitch + (ev.clientY - drag.y) * 0.008));
      drag = { x: ev.clientX, y: ev.clientY };
      requestDraw();
    } else {
      hover(ev);
    }
  });
  canvas.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    camera.distance = Math.max(3, Math.min(150, camera.distance * Math.exp(ev.deltaY * 0.001)));
    requestDraw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    Object.assign(camera, { yaw: Math.PI / 4, pitch: 0.6, distance: 28 });
    requestDraw();
  });

  /** Walk the ray under the cursor through the voxel grid and report the first visible block. */
  function hover(ev) {
    if (!viewProj || !visible.size) return;
    const rect = canvas.getBoundingClientRect();
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((ev.clientY - rect.top) / rect.height) * 2;
    const inv = mat4.invert(viewProj);
    const unproject = (z) => { const p = mat4.transform(inv, [nx, ny, z, 1]); return [p[0] / p[3], p[1] / p[3], p[2] / p[3]]; };
    const origin = unproject(-1);
    const dir = norm(sub(unproject(1), origin));

    const cell = origin.map(Math.floor);
    const step = dir.map((d) => (d > 0 ? 1 : -1));
    const tDelta = dir.map((d) => Math.abs(1 / d));
    const tMax = dir.map((d, i) => (d > 0 ? cell[i] + 1 - origin[i] : origin[i] - cell[i]) * tDelta[i]);

    for (let i = 0; i < 600; i++) {
      const key = cell.join(',');
      if (visible.has(key)) {
        tooltip.textContent = `${visible.get(key)}  ${cell.join(' ')}`;
        tooltip.style.left = `${ev.clientX - rect.left + 14}px`;
        tooltip.style.top = `${ev.clientY - rect.top + 14}px`;
        tooltip.hidden = false;
        return;
      }
      const axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      cell[axis] += step[axis];
      tMax[axis] += tDelta[axis];
    }
    tooltip.hidden = true;
  }

  // --- Controls and data ------------------------------------------------------

  radiusInput.addEventListener('input', () => {
    radiusValue.textContent = radiusInput.value;
    rebuild();
  });

  scanButton.addEventListener('click', () => {
    window.ptolemy.send({ type: 'scan', radius: scanRadius.value ? Number(scanRadius.value) : null });
    info.textContent = 'Scanning...';
  });

  document.addEventListener('ptolemy:sight', (ev) => {
    sight = ev.detail;
    const { x, y, z } = sight.agent.position;
    agentPos = [x, y, z];
    empty.hidden = true;
    rebuild();
  });

  document.addEventListener('ptolemy:path', (ev) => {
    const { kind = 'walk', cells, trail = false } = ev.detail;
    paths[kind] = { cells, trail };
    rebuild();
  });

  // The robot moved (e.g. while walking a path): move its marker and the camera with it.
  document.addEventListener('ptolemy:agent', (ev) => {
    if (!sight) return;
    const { x, y, z } = ev.detail.position;
    agentPos = [x, y, z];
    sight.agent = { ...sight.agent, position: ev.detail.position, yRot: ev.detail.yRot };
    rebuild();
  });

  // The canvas has no size while its tab is hidden, so redraw when it's shown.
  document.addEventListener('ptolemy:tab', (ev) => { if (ev.detail === 'nannycam') requestDraw(); });
})();
