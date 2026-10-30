/*
 * ncCAM worker: part analysis and toolpath planning off the UI thread.
 * Runs as one Blob after clipper.js and autocam-engine.js. Messages: {id, type, ...} -> {id, data | error | partial}.
 */
(function () {
  var source = null; // occt-import-js meshes (plain arrays)
  var cache = {}; // orientation -> {mesh, model}
  var last = null; // the latest plan, for simulation

  function entry(up, flip) {
    var k = JSON.stringify(AutoCAM.matrixOf(up)) + '|' + (flip || '');
    if (!cache[k]) {
      var mesh = AutoCAM.readMesh(source, up, flip);
      cache[k] = { mesh: mesh, model: AutoCAM.analyze(mesh) };
    }
    return cache[k];
  }

  function holeInfo(h) {
    return { x: h.x, y: h.y, diameter: h.diameter, depth: h.depth, through: h.through, zTop: h.zTop, zBottom: h.zBottom };
  }

  // Plans hold tool objects and long move lists: send moves as one Float32Array per operation (x, y, z, rapid).
  function pack(p, machine) {
    var single = Object.assign({}, machine, { toolChangeS: 0 });
    return {
      warnings: p.warnings, notes: p.notes, stock: p.stock, origin: p.origin, originName: p.originName,
      setup: p.setup, split: p.split, safeZ: p.safeZ, seconds: AutoCAM.estimateSeconds(p, machine),
      ops: p.ops.map(function (op) {
        var a = new Float32Array(op.moves.length * 4);
        op.moves.forEach(function (m, i) { a[4 * i] = m.x; a[4 * i + 1] = m.y; a[4 * i + 2] = m.z; a[4 * i + 3] = m.r ? 1 : 0; });
        return {
          name: op.name, cutting: op.cutting, moves: a, seconds: AutoCAM.estimateSeconds({ ops: [op] }, single),
          tool: { number: op.tool.number, label: op.tool.label, diameter: op.tool.diameter, kind: op.tool.kind }
        };
      })
    };
  }

  function plan(msg) {
    var tools = AutoCAM.buildTools(msg.ncTools, msg.cfg.tools, msg.cfg.material);
    var cfg = msg.cfg, machine = msg.machine, plans;
    if (!msg.flip) {
      plans = [AutoCAM.plan(entry(msg.up).model, tools, machine, Object.assign({}, cfg, { setup: 0 }))];
    } else {
      var p1 = AutoCAM.plan(entry(msg.up).model, tools, machine, Object.assign({}, cfg, { setup: 1, flip: msg.flip }));
      // Holes from setup 1, where they sit once the part is turned over.
      var turn = AutoCAM.FLIP[msg.flip];
      var turned = function (h) { var q = turn(h.x, h.y, 0); return { x: q[0], y: q[1], diameter: h.diameter }; };
      var p2 = AutoCAM.plan(entry(msg.up, msg.flip).model, tools, machine, Object.assign({}, cfg, {
        setup: 2, flip: msg.flip, split: p1.split,
        skipHoles: p1.drilled.map(function (d) { return turned(d.hole); }),
        otherSide: p1.openHoles.map(turned), doneInSetup1: p1.finishedHoles.map(turned)
      }));
      plans = [p1, p2];
    }
    plans.forEach(function (p, i) { p.placement = (msg.placement || [])[i] || []; });
    // Replay each setup once: a rapid that would brush leftover stock (a corner too tight for roughing)
    // becomes a feed move at plunge speed, so the program never rapids into material.
    plans.forEach(function (p, i) {
      var r = AutoCAMSim.simulate(p, entry(msg.up, i === 1 ? msg.flip : null).mesh, machine, { repair: true });
      if (r.repaired) p.warnings.push(r.repaired + ' rapid move' + (r.repaired > 1 ? 's' : '') + ' into leftover stock changed to plunge-speed feed moves.');
    });
    var gcodes = plans.map(function (p, i) { return AutoCAM.post(p, msg.name + (plans.length > 1 ? ' setup ' + (i + 1) : '')); });
    last = { plans: plans, gcodes: gcodes, up: msg.up, flip: msg.flip, machine: machine };
    return { plans: plans.map(function (p) { return pack(p, machine); }), gcodes: gcodes };
  }

  self.onmessage = function (ev) {
    var msg = ev.data;
    function reply(data, transfer) { self.postMessage({ id: msg.id, data: data }, transfer || []); }
    try {
      if (msg.type === 'load') {
        source = { meshes: msg.meshes };
        cache = {};
        reply(true);
      } else if (msg.type === 'analyze') {
        var e = entry(msg.up), f = AutoCAM.features(e.mesh, e.model);
        reply({
          bbox: e.model.bbox, floors: e.model.floors, holes: e.model.holes.map(holeInfo), triangles: e.mesh.tris.length,
          faceClass: f.faceClass, pockets: f.pockets, holeGroups: f.holeGroups, height: f.height, sloped: f.sloped
        });
      } else if (msg.type === 'sides') {
        var out = {};
        Object.keys(AutoCAM.UP_MATRIX).forEach(function (u) {
          var m = entry(u).model, h = AutoCAM.hiddenFraction(m, true);
          out[u] = { hidden: h.one, hidden2: h.two, bbox: m.bbox };
          self.postMessage({ id: msg.id, partial: { side: u, hidden: h.one, hidden2: h.two, bbox: m.bbox } });
        });
        reply(out);
      } else if (msg.type === 'simulate') {
        // Stock simulation and checks for setup msg.index of the latest plan.
        var i = msg.index, p = last.plans[i];
        var mesh = entry(last.up, i === 1 ? last.flip : null).mesh;
        var sim = AutoCAMSim.simulate(p, mesh, last.machine);
        sim.checks.gcode = AutoCAMSim.checkGcode(last.gcodes[i]);
        var tr = sim.frames.map(function (f) { return f.buffer; }).concat([sim.gouge.buffer, sim.uncut.buffer]);
        reply(sim, tr);
      } else if (msg.type === 'plan') {
        var r = plan(msg);
        var transfer = [];
        r.plans.forEach(function (p) { p.ops.forEach(function (op) { transfer.push(op.moves.buffer); }); });
        reply(r, transfer);
      }
    } catch (err) {
      self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
    }
  };
})();
