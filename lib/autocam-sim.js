/*
 * AutoCAM stock simulation and pre-flight checks.
 * A height map of the stock (one Z per grid cell, cut from above) is lowered move by move with the tool's shape
 * (flat end mill, or the cone of a drill / spot drill). Along the way it catches cuts into the part, rapids through
 * material, straight plunges and cuts deeper than the flutes, and at the end it measures what was left uncut.
 */
(function (root) {
  'use strict';

  var MAX_CELLS = 160000;
  var FRAMES = 150; // playback frames per setup; with MAX_CELLS this stays under ~50 MB
  var TOL = 0.03; // mm: below this nothing counts as a gouge or a collision

  /** Highest point of the part above each cell centre (-Infinity where there is no material). */
  function partTop(mesh, g) {
    var top = new Float32Array(g.nx * g.ny).fill(-Infinity);
    mesh.tris.forEach(function (t) {
      var a = t.a, b = t.b, c = t.c;
      var i0 = Math.max(0, Math.ceil((Math.min(a.x, b.x, c.x) - g.x0) / g.cell)), i1 = Math.min(g.nx - 1, Math.floor((Math.max(a.x, b.x, c.x) - g.x0) / g.cell));
      var j0 = Math.max(0, Math.ceil((Math.min(a.y, b.y, c.y) - g.y0) / g.cell)), j1 = Math.min(g.ny - 1, Math.floor((Math.max(a.y, b.y, c.y) - g.y0) / g.cell));
      var d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
      if (Math.abs(d) < 1e-12) return; // vertical triangle: its edges are covered by its neighbours
      for (var j = j0; j <= j1; j++) {
        var y = g.y0 + j * g.cell;
        for (var i = i0; i <= i1; i++) {
          var x = g.x0 + i * g.cell;
          var w1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / d;
          var w2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / d;
          var w3 = 1 - w1 - w2;
          if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
          var z = w1 * a.z + w2 * b.z + w3 * c.z, k = j * g.nx + i;
          if (z > top[k]) top[k] = z;
        }
      }
    });
    return top;
  }

  /**
   * Simulate one planned setup.
   * plan: raw plan from AutoCAM.plan (ops with tool objects and moves); mesh: the part as that setup sees it.
   * Returns frames for playback plus check results.
   */
  /**
   * opts.repair: instead of reporting rapids that would touch stock, turn them into feed moves at the
   * operation's plunge feed (in place, on plan), and return only {repaired}. Used once after planning.
   */
  function simulate(plan, mesh, machine, opts) {
    var repair = !!(opts && opts.repair), repaired = 0;
    var st = plan.stock;
    var cell = Math.max(0.08, Math.sqrt((st.x1 - st.x0) * (st.y1 - st.y0) / MAX_CELLS)); // fine on small parts
    // The grid is shifted by an odd fraction of a cell so cell centres don't sit exactly on part walls
    // (stock margins and part sizes are often round numbers): a centre on a wall is neither in nor out.
    var shift = cell * 0.3719;
    var g = { x0: st.x0 + shift, y0: st.y0 + shift, cell: cell, nx: Math.ceil((st.x1 - st.x0 - shift) / cell) + 1, ny: Math.ceil((st.y1 - st.y0 - shift) / cell) + 1 };
    var n = g.nx * g.ny;
    var h = new Float32Array(n).fill(st.z1);
    var top = partTop(mesh, g);
    var gouge = new Uint8Array(n);
    var zLow = st.z0 - 5, zHigh = st.z1, span = zHigh - zLow;
    var found = { gouges: [], rapids: [], plunges: [], flute: [] };
    var gougeCells = 0, gougeMax = 0;

    // Time line: cumulative seconds per move, to spread the frames evenly in machining time.
    var moves = [], t = 0, prev = null;
    plan.ops.forEach(function (op, oi) {
      if (oi && op.tool !== plan.ops[oi - 1].tool) t += machine.toolChangeS;
      op.moves.forEach(function (m) {
        if (prev) t += Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z) / (m.r ? machine.rapidRate : m.f) * 60;
        moves.push({ m: m, op: oi, t: t, from: prev });
        prev = m;
      });
    });
    var total = t || 1;
    var frames = [], info = [], nextFrame = 0;

    function snapshot(k) {
      if (repair) return;
      var q = new Uint16Array(n);
      for (var c = 0; c < n; c++) q[c] = Math.round((Math.max(zLow, Math.min(zHigh, h[c])) - zLow) / span * 65535);
      frames.push(q);
      var mv = moves[k];
      info.push({ t: mv ? mv.t : total, op: mv ? mv.op : plan.ops.length - 1, x: mv ? mv.m.x : 0, y: mv ? mv.m.y : 0, z: mv ? mv.m.z : zHigh });
    }

    function note(list, item) { if (list.length < 50) list.push(item); }

    function wcs(x, y, z) {
      var o = plan.origin;
      return 'X' + (x - o.x).toFixed(2) + ' Y' + (y - o.y).toFixed(2) + ' Z' + (z - o.z).toFixed(2);
    }

    moves.forEach(function (mv, k) {
      while (nextFrame < FRAMES && mv.t >= total * nextFrame / FRAMES) { snapshot(k); nextFrame++; }
      if (!mv.from) return;
      var op = plan.ops[mv.op], tool = op.tool, m = mv.m, a = mv.from;
      var cone = tool.kind === 'drill' || tool.kind === 'spot';
      var tanHalf = cone ? Math.tan((tool.pointAngle || 118) / 2 * Math.PI / 180) : 0;
      var r = cone && tool.diameter < 1 ? 3.2 : tool.radius; // V-bit listed by its tip: use its cone up to a 1/4" shank
      var dx = m.x - a.x, dy = m.y - a.y, dz = m.z - a.z, len = Math.hypot(dx, dy);
      var steps = Math.max(1, Math.ceil(len / cell)), deepest = 0, rapidHit = 0, removedCentre = 0;
      var ri = Math.ceil(r / cell);
      for (var s = 1; s <= steps; s++) {
        var px = a.x + dx * s / steps, py = a.y + dy * s / steps, pz = a.z + dz * s / steps;
        var ci = Math.round((px - g.x0) / cell), cj = Math.round((py - g.y0) / cell);
        for (var j = Math.max(0, cj - ri); j <= Math.min(g.ny - 1, cj + ri); j++) {
          var yy = g.y0 + j * cell - py;
          for (var i = Math.max(0, ci - ri); i <= Math.min(g.nx - 1, ci + ri); i++) {
            var xx = g.x0 + i * cell - px, d = Math.hypot(xx, yy);
            if (d > r - 0.01) continue;
            var bottom = cone ? pz + d / tanHalf : pz, c = j * g.nx + i;
            if (h[c] <= bottom) continue;
            var depth = h[c] - bottom;
            if (m.r) { if (depth > rapidHit) rapidHit = depth; }
            else if (h[c] - pz > deepest) deepest = h[c] - pz; // stock height the flutes must reach
            if (d < cell && depth > removedCentre) removedCentre = depth;
            if (bottom < top[c] - TOL) {
              if (!gouge[c]) gougeCells++;
              gouge[c] = 1;
              var gd = top[c] - bottom;
              if (gd > gougeMax) gougeMax = gd;
              if (gd > 0.05) note(found.gouges, { op: op.name, tool: tool.label, depth: gd, at: wcs(g.x0 + i * cell, g.y0 + j * cell, bottom) });
            }
            h[c] = bottom;
          }
        }
      }
      if (m.r && rapidHit > TOL) {
        if (repair) { m.r = 0; m.f = op.cutting.plunge; repaired++; }
        else note(found.rapids, { op: op.name, tool: tool.label, depth: rapidHit, at: wcs(m.x, m.y, m.z) });
      }
      if (!m.r && !cone && len < 0.01 && dz < 0 && removedCentre > 0.5) note(found.plunges, { op: op.name, tool: tool.label, depth: removedCentre, at: wcs(m.x, m.y, m.z) });
      if (!m.r && deepest > tool.fluteLength + 0.05) note(found.flute, { op: op.name, tool: tool.label, depth: deepest, flute: tool.fluteLength, at: wcs(m.x, m.y, m.z) });
    });
    if (repair) return { repaired: repaired };
    while (nextFrame <= FRAMES) { snapshot(moves.length - 1); nextFrame++; }

    // Left uncut: inside the part's outline, stock still above the part (plus the finish allowance),
    // down to the deepest level this setup was meant to reach. Outside the outline only for one setup:
    // a two-setup frame is left on purpose.
    // Compared with the highest part surface around each cell: right where a rounded edge meets a wall the
    // grid can miss the thin, nearly vertical strip and see the floor below instead.
    var near = new Float32Array(n);
    for (var cj = 0; cj < g.ny; cj++) for (var ci = 0; ci < g.nx; ci++) {
      var best = -Infinity;
      for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) {
        var ii = ci + di, jj = cj + dj;
        if (ii >= 0 && jj >= 0 && ii < g.nx && jj < g.ny && top[jj * g.nx + ii] > best) best = top[jj * g.nx + ii];
      }
      near[cj * g.nx + ci] = best;
    }
    var floor = plan.zFloor, allow = 0.3, uncut = new Uint8Array(n), uncutCells = 0, uncutMax = 0;
    for (var c = 0; c < n; c++) {
      var inside = top[c] > -Infinity;
      if (!inside && (plan.setup || plan.cutAround)) continue; // a frame or scrap left outside on purpose
      var want = Math.max(inside ? near[c] : -Infinity, floor);
      var excess = h[c] - want - allow;
      if (excess > 0) { uncut[c] = 1; uncutCells++; if (excess > uncutMax) uncutMax = excess; }
    }
    // Group uncut cells into areas so each can be listed with where it is.
    var seen = new Uint8Array(n), areas = [];
    for (var c0 = 0; c0 < n; c0++) {
      if (!uncut[c0] || seen[c0]) continue;
      var stack = [c0], cells = 0, sx = 0, sy = 0, hi = 0;
      seen[c0] = 1;
      while (stack.length) {
        var q = stack.pop(), qi = q % g.nx, qj = (q - qi) / g.nx;
        cells++; sx += qi; sy += qj;
        var e = h[q] - Math.max(top[q] > -Infinity ? near[q] : -Infinity, floor);
        if (e > hi) hi = e;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (dd) {
          var ni = qi + dd[0], nj = qj + dd[1];
          if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.ny) return;
          var nk = nj * g.nx + ni;
          if (uncut[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
        });
      }
      areas.push({ area: cells * cell * cell, high: hi, at: wcs(g.x0 + sx / cells * cell, g.y0 + sy / cells * cell, floor) });
    }
    areas.sort(function (a, b) { return b.area - a.area; });

    return {
      grid: { x0: g.x0, y0: g.y0, cell: cell, nx: g.nx, ny: g.ny, zLow: zLow, zHigh: zHigh },
      frames: frames, info: info, total: total, gouge: gouge, uncut: uncut,
      checks: {
        gouges: found.gouges, gougeArea: gougeCells * cell * cell, gougeMax: gougeMax,
        rapids: found.rapids, plunges: found.plunges, flute: found.flute,
        uncutArea: uncutCells * cell * cell, uncutMax: uncutMax, uncutAreas: areas.slice(0, 20)
      }
    };
  }

  var GRBLHAL_G = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 10: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1, 28: 1, 30: 1, 33: 1, 38.2: 1, 38.3: 1, 38.4: 1, 38.5: 1,
    40: 1, 43.1: 1, 49: 1, 53: 1, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1, 59: 1, 61: 1, 64: 1, 73: 1, 76: 1, 80: 1, 81: 1, 82: 1, 83: 1, 85: 1, 86: 1, 89: 1,
    90: 1, 91: 1, 91.1: 1, 92: 1, 93: 1, 94: 1, 95: 1, 96: 1, 97: 1, 98: 1, 99: 1 };
  var GRBLHAL_M = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 30: 1, 48: 1, 49: 1, 50: 1, 51: 1, 56: 1, 61: 1, 62: 1, 63: 1, 64: 1, 65: 1, 66: 1, 67: 1, 68: 1 };

  /** Lines grblHAL would reject: unknown words or codes, bad numbers, lines over 256 characters. */
  function checkGcode(text) {
    var bad = [];
    text.split('\n').forEach(function (raw, i) {
      if (/[^\x09\x20-\x7e]/.test(raw)) { if (bad.length < 20) bad.push({ line: i + 1, text: raw.slice(0, 60), why: 'contains a non-ASCII character' }); return; }
      var line = raw.replace(/\([^)]*\)/g, '').replace(/;.*/, '').trim().toUpperCase();
      if (!line) return;
      var why = null;
      if (/^\s*\([^)]*\(/.test(raw)) why = 'a comment contains "(": grblHAL ends it at the first ")"';
      if (why) { /* already explained */ }
      else if (raw.length > 256) why = 'longer than 256 characters';
      else {
        var rest = line.replace(/\s+/g, '');
        var words = rest.match(/[A-Z][-+]?(\d+\.?\d*|\.\d+)/g) || [];
        if (words.join('') !== rest) why = 'cannot be parsed';
        words.forEach(function (w) {
          var L = w[0], v = Number(w.slice(1));
          if ('FGHIJKLMNPQRSTXYZ'.indexOf(L) < 0) why = why || 'unknown word ' + w;
          else if (L === 'G' && !GRBLHAL_G[v]) why = why || 'unsupported ' + w;
          else if (L === 'M' && !GRBLHAL_M[v]) why = why || 'unsupported ' + w;
        });
      }
      if (why && bad.length < 20) bad.push({ line: i + 1, text: raw.slice(0, 60), why: why });
    });
    return bad;
  }

  root.AutoCAMSim = { simulate: simulate, checkGcode: checkGcode, FRAMES: FRAMES };
})(typeof window !== 'undefined' ? window : globalThis);
