/*
 * AutoCAM engine for ncSender.
 * STEP mesh (from occt-import-js) -> 2.5D features -> automatic operations -> grblHAL G-code.
 * Plain browser JavaScript; needs ClipperLib (clipper-lib 6.4.2) loaded globally.
 * All lengths in mm, Z up, part machined from the top in one setup.
 */
(function (root) {
  'use strict';

  var SCALE = 1000; // Clipper integer units per mm
  var EPS = 1e-3;
  var SLICE = 0.25; // Z spacing of sections through sloped or curved walls, mm

  // ------------------------------------------------------------------ 2D regions
  // A region is an array of closed paths [{x, y}, ...]; outers CCW, holes CW (Clipper convention).

  function C() { return root.ClipperLib; }

  function toC(paths) {
    return paths.map(function (p) {
      return p.map(function (q) { return { X: Math.round(q.x * SCALE), Y: Math.round(q.y * SCALE) }; });
    });
  }

  function fromC(paths) {
    return paths.map(function (p) {
      return p.map(function (q) { return { x: q.X / SCALE, y: q.Y / SCALE }; });
    });
  }

  function clip(type, subj, clipPaths, subjFill) {
    var L = C();
    var c = new L.Clipper();
    if (subj.length) c.AddPaths(toC(subj), L.PolyType.ptSubject, true);
    if (clipPaths && clipPaths.length) c.AddPaths(toC(clipPaths), L.PolyType.ptClip, true);
    var out = new L.Paths();
    c.Execute(type, out, subjFill === undefined ? L.PolyFillType.pftNonZero : subjFill, L.PolyFillType.pftNonZero);
    return fromC(out);
  }

  var Region = {
    union: function (a, b) { return clip(C().ClipType.ctUnion, a, b || []); },
    evenOdd: function (a) { return clip(C().ClipType.ctUnion, a, [], C().PolyFillType.pftEvenOdd); },
    diff: function (a, b) { return clip(C().ClipType.ctDifference, a, b); },
    inter: function (a, b) { return clip(C().ClipType.ctIntersection, a, b); },
    // tol: how far arc chords may sit inside the true arc. 5 µm by default (finish walls);
    // roughing passes a coarser value because it leaves stock on the walls anyway.
    offset: function (a, d, tol) {
      if (!a.length) return [];
      var L = C();
      var co = new L.ClipperOffset(2, (tol || 0.005) * SCALE);
      co.AddPaths(toC(a), L.JoinType.jtRound, L.EndType.etClosedPolygon);
      var out = new L.Paths();
      co.Execute(out, d * SCALE);
      return fromC(out);
    },
    area: function (a) {
      var L = C();
      return toC(a).reduce(function (s, p) { return s + L.Clipper.Area(p); }, 0) / (SCALE * SCALE);
    },
    rect: function (x0, y0, x1, y1) {
      return [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]];
    },
    circle: function (cx, cy, r) {
      var n = Math.max(24, Math.ceil(2 * Math.PI * r / 0.2));
      var p = [];
      for (var i = 0; i < n; i++) p.push({ x: cx + r * Math.cos(2 * Math.PI * i / n), y: cy + r * Math.sin(2 * Math.PI * i / n) });
      return [p];
    },
    contains: function (a, x, y) { // even-odd ray cast
      var inside = false;
      a.forEach(function (p) {
        for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
          if ((p[i].y > y) !== (p[j].y > y) &&
              x < (p[j].x - p[i].x) * (y - p[i].y) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
        }
      });
      return inside;
    },
    clean: function (a, d) { return Region.offset(Region.offset(a, -d), d); },
    outers: function (a) { return Region.union(a.filter(function (p) { return Region.area([p]) > 0; })); }
  };

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function segRectDistance(p, q, r) { // r = [x0, y0, x1, y1]
    function inside(pt) { return pt.x >= r[0] && pt.x <= r[2] && pt.y >= r[1] && pt.y <= r[3]; }
    if (inside(p) || inside(q)) return 0;
    function ptRect(pt) {
      var dx = Math.max(r[0] - pt.x, 0, pt.x - r[2]), dy = Math.max(r[1] - pt.y, 0, pt.y - r[3]);
      return Math.hypot(dx, dy);
    }
    var d = Math.min(ptRect(p), ptRect(q));
    var corners = [{ x: r[0], y: r[1] }, { x: r[2], y: r[1] }, { x: r[2], y: r[3] }, { x: r[0], y: r[3] }];
    corners.forEach(function (c) { d = Math.min(d, ptSeg(c, p, q)); });
    return d;
  }

  function ptSeg(c, p, q) {
    var dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / L2)) : 0;
    return Math.hypot(c.x - (p.x + t * dx), c.y - (p.y + t * dy));
  }

  function nearestOnRegion(a, pt) {
    var best = null, bd = Infinity;
    a.forEach(function (p) {
      for (var i = 0; i < p.length; i++) {
        var u = p[i], v = p[(i + 1) % p.length];
        var dx = v.x - u.x, dy = v.y - u.y, L2 = dx * dx + dy * dy;
        var t = L2 ? Math.max(0, Math.min(1, ((pt.x - u.x) * dx + (pt.y - u.y) * dy) / L2)) : 0;
        var q = { x: u.x + t * dx, y: u.y + t * dy }, d = dist(q, pt);
        if (d < bd) { bd = d; best = q; }
      }
    });
    return best;
  }

  function segmentInside(a, p, q, step) {
    var n = Math.max(2, Math.ceil(dist(p, q) / (step || 0.2)));
    for (var i = 0; i <= n; i++) {
      if (!Region.contains(a, p.x + (q.x - p.x) * i / n, p.y + (q.y - p.y) * i / n)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ mesh + features

  // Which way the part sits: rows of the rotation taking model coordinates to machine (Z-up) ones.
  // '+Z' keeps the model as drawn; '-Y' puts the model's front face (-Y) on top, and so on.
  var UP_MATRIX = {
    '+Z': [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    '-Z': [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
    '+Y': [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    '-Y': [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
    '+X': [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    '-X': [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]
  };

  function matrixOf(up) { return Array.isArray(up) ? up : UP_MATRIX[up || '+Z']; }

  function mulMat(a, b) {
    return [0, 1, 2].map(function (i) { return [0, 1, 2].map(function (j) { return a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]; }); });
  }

  /** Rotation that turns direction n (unit) to +Z, the shortest way. */
  function alignToZ(n) {
    var c = n[2];
    if (c > 1 - 1e-9) return UP_MATRIX['+Z'];
    if (c < -1 + 1e-9) return UP_MATRIX['-Z'];
    var kx = n[1], ky = -n[0], s = Math.hypot(kx, ky); // axis = n x Z, normalised
    kx /= s; ky /= s;
    var C = 1 - c;
    return [[c + kx * kx * C, kx * ky * C, ky * s], [kx * ky * C, c + ky * ky * C, -kx * s], [-ky * s, kx * s, c]];
  }

  // Turning the part over for a second setup: half a turn about the X or the Y axis.
  var FLIP = {
    X: function (x, y, z) { return [x, -y, -z]; },
    Y: function (x, y, z) { return [-x, y, -z]; }
  };

  /** Flatten an occt-import-js result into triangles (Z up per `up`, then turned over per `flip`) plus B-rep face ranges.
   *  up: '+Z' / '-Y' / ... or a 3x3 rotation matrix. */
  function readMesh(occt, up, flip) {
    var M = matrixOf(up);
    var base = function (x, y, z) {
      return [M[0][0] * x + M[0][1] * y + M[0][2] * z, M[1][0] * x + M[1][1] * y + M[1][2] * z, M[2][0] * x + M[2][1] * y + M[2][2] * z];
    };
    var turn = flip ? FLIP[flip] : null;
    var tf = turn ? function (x, y, z) { var p = base(x, y, z); return turn(p[0], p[1], p[2]); } : base;
    var tris = [], faces = [];
    occt.meshes.forEach(function (m) {
      var pos = m.attributes.position.array, idx = m.index.array;
      var nrm = m.attributes.normal ? m.attributes.normal.array : null;
      var base = tris.length;
      function v(i) { var p = tf(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); return { x: p[0], y: p[1], z: p[2] }; }
      for (var t = 0; t < idx.length / 3; t++) {
        var i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
        var a = v(i0), b = v(i1), c = v(i2), n;
        if (nrm) {
          var s = [0, 0, 0];
          [i0, i1, i2].forEach(function (i) {
            var q = tf(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]);
            s[0] += q[0]; s[1] += q[1]; s[2] += q[2];
          });
          n = s;
        } else {
          var ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
          n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
        }
        var len = Math.hypot(n[0], n[1], n[2]) || 1;
        tris.push({ a: a, b: b, c: c, n: { x: n[0] / len, y: n[1] / len, z: n[2] / len } });
      }
      (m.brep_faces || []).forEach(function (f) { faces.push({ start: base + f.first, end: base + f.last }); });
    });
    return { tris: tris, faces: faces };
  }

  function section(tris, z) {
    var segs = [];
    function key(p) { return p.x.toFixed(5) + ',' + p.y.toFixed(5); }
    function cut(p, q) {
      if (p.x > q.x || (p.x === q.x && (p.y > q.y || (p.y === q.y && p.z > q.z)))) { var t0 = p; p = q; q = t0; }
      var t = (z - p.z) / (q.z - p.z);
      return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
    }
    tris.forEach(function (t) {
      var vs = [t.a, t.b, t.c], up = vs.map(function (v) { return v.z >= z; });
      if (up[0] === up[1] && up[1] === up[2]) return;
      var pts = [];
      for (var i = 0; i < 3; i++) {
        var j = (i + 1) % 3;
        if (up[i] !== up[j]) pts.push(cut(vs[i], vs[j]));
      }
      if (pts.length === 2 && key(pts[0]) !== key(pts[1])) segs.push(pts);
    });
    // Chain segments into loops by shared end points.
    var at = {};
    segs.forEach(function (s, i) {
      [0, 1].forEach(function (e) { (at[key(s[e])] = at[key(s[e])] || []).push([i, e]); });
    });
    var used = new Array(segs.length), loops = [];
    for (var s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      used[s0] = true;
      var loop = [segs[s0][0], segs[s0][1]], startKey = key(segs[s0][0]), curKey = key(segs[s0][1]);
      while (curKey !== startKey) {
        var next = (at[curKey] || []).filter(function (h) { return !used[h[0]]; })[0];
        if (!next) break;
        used[next[0]] = true;
        var far = segs[next[0]][1 - next[1]];
        loop.push(far);
        curKey = key(far);
      }
      if (loop.length >= 4) loops.push(loop);
    }
    return Region.evenOdd(loops);
  }

  function fitCircle(pts) {
    // Kasa least-squares fit: x^2 + y^2 + D x + E y + F = 0
    var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0, n = pts.length;
    pts.forEach(function (p) {
      var zz = p.x * p.x + p.y * p.y;
      sx += p.x; sy += p.y; sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
      sxz += p.x * zz; syz += p.y * zz; sz += zz;
    });
    var A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], b = [-sxz, -syz, -sz];
    var det = function (m) {
      return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    };
    var d = det(A);
    if (Math.abs(d) < 1e-9) return null;
    var sol = [0, 1, 2].map(function (k) {
      var M = A.map(function (row, i) { return row.map(function (v, j) { return j === k ? b[i] : v; }); });
      return det(M) / d;
    });
    var cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2];
    return r2 > 0 ? { x: cx, y: cy, r: Math.sqrt(r2) } : null;
  }

  function findHoles(mesh, zmin) {
    var groups = {};
    mesh.faces.forEach(function (f, fi) {
      var tris = mesh.tris.slice(f.start, f.end + 1);
      if (tris.length < 2 || !tris.every(function (t) { return Math.abs(t.n.z) < 0.02; })) return;
      var seen = {}, pts = [], zlo = Infinity, zhi = -Infinity;
      tris.forEach(function (t) {
        [t.a, t.b, t.c].forEach(function (v) {
          zlo = Math.min(zlo, v.z); zhi = Math.max(zhi, v.z);
          var k = v.x.toFixed(4) + ',' + v.y.toFixed(4);
          if (!seen[k]) { seen[k] = 1; pts.push(v); }
        });
      });
      if (pts.length < 6) return;
      var c = fitCircle(pts);
      if (!c || c.r > 500) return;
      var dev = Math.max.apply(null, pts.map(function (p) { return Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - c.r); }));
      if (dev > 0.01 + c.r * 0.002) return;
      var concave = tris.filter(function (t) {
        var g = { x: (t.a.x + t.b.x + t.c.x) / 3, y: (t.a.y + t.b.y + t.c.y) / 3 };
        return (c.x - g.x) * t.n.x + (c.y - g.y) * t.n.y > 0;
      }).length;
      if (concave * 2 < tris.length) return; // a boss, not a hole
      var ang = pts.map(function (p) { return Math.atan2(p.y - c.y, p.x - c.x); }).sort(function (a, b) { return a - b; });
      var gap = ang[0] + 2 * Math.PI - ang[ang.length - 1];
      for (var i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
      var key = c.x.toFixed(2) + ',' + c.y.toFixed(2) + ',' + c.r.toFixed(3);
      var g = groups[key] || (groups[key] = { x: c.x, y: c.y, r: c.r, span: 0, zlo: zlo, zhi: zhi, faces: [] });
      g.faces.push(fi);
      g.span += 2 * Math.PI - gap;
      g.zlo = Math.min(g.zlo, zlo); g.zhi = Math.max(g.zhi, zhi);
    });
    return Object.keys(groups).map(function (k) { return groups[k]; })
      .filter(function (g) { return g.span >= 2 * Math.PI - 0.15; })
      .map(function (g) {
        return { x: g.x, y: g.y, diameter: Math.round(g.r * 2000) / 1000, zTop: g.zhi, zBottom: g.zlo,
                 depth: g.zhi - g.zlo, through: g.zlo <= zmin + EPS, faces: g.faces };
      });
  }

  /** Analyse the part: bounding box, Z slabs with their cross-sections, floors and vertical holes. */
  function analyze(mesh) {
    var bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    mesh.tris.forEach(function (t) {
      [t.a, t.b, t.c].forEach(function (v) {
        bb[0] = Math.min(bb[0], v.x); bb[1] = Math.min(bb[1], v.y); bb[2] = Math.min(bb[2], v.z);
        bb[3] = Math.max(bb[3], v.x); bb[4] = Math.max(bb[4], v.y); bb[5] = Math.max(bb[5], v.z);
      });
    });
    var zmin = bb[2], zmax = bb[5];
    var flat = {}, floors = {};
    mesh.tris.forEach(function (t) {
      // Truly flat triangles only: fillets near a face can be almost horizontal without being level.
      if (Math.abs(t.n.z) < 0.999 || Math.max(t.a.z, t.b.z, t.c.z) - Math.min(t.a.z, t.b.z, t.c.z) > 1e-4) return;
      var z = Math.round((t.a.z + t.b.z + t.c.z) / 3 * 1000) / 1000;
      flat[z] = 1;
      if (t.n.z > 0) floors[z] = 1;
    });
    var levels = Object.keys(flat).map(Number).concat([zmin, zmax]).sort(function (a, b) { return a - b; });
    var uniq = [];
    levels.forEach(function (z) { if (!uniq.length || z - uniq[uniq.length - 1] > EPS) uniq.push(z); });
    // Z ranges of sloped triangles (neither vertical nor flat): bands containing them are sliced densely.
    var sloped = [];
    mesh.tris.forEach(function (t) {
      var nz = Math.abs(t.n.z);
      if (nz > 0.01 && nz < 0.999) sloped.push([Math.min(t.a.z, t.b.z, t.c.z), Math.max(t.a.z, t.b.z, t.c.z)]);
    });
    var slabs = [], samples = [];
    for (var i = 0; i + 1 < uniq.length; i++) {
      var lo = uniq[i], hi = uniq[i + 1];
      var isSloped = hi - lo > 0.05 && sloped.some(function (iv) { return iv[1] > lo + EPS && iv[0] < hi - EPS; });
      var hs = [];
      if (isSloped) {
        // End slices hug the flat levels: a shallow slope can spread far sideways within 0.01 mm.
        var n = Math.max(2, Math.ceil((hi - lo - 0.004) / SLICE));
        for (var k = 0; k <= n; k++) hs.push(lo + 0.002 + (hi - lo - 0.004) * k / n);
      } else {
        hs = hi - lo > 0.05 ? [lo + 0.01, (lo + hi) / 2, hi - 0.01] : [(lo + hi) / 2];
      }
      var slab = { zLo: lo, zHi: hi, sloped: isSloped, section: [] };
      hs.forEach(function (z) {
        var sec = section(mesh.tris, z);
        samples.push({ z: z, slab: slab, section: sec });
        slab.section = Region.union(slab.section, sec);
      });
      slabs.push(slab);
    }
    var floorList = Object.keys(floors).map(Number)
      .filter(function (z) { return z > zmin + EPS && z < zmax - EPS; })
      .sort(function (a, b) { return b - a; });
    samples.sort(function (a, b) { return b.z - a.z; });
    return new PartModel(bb, slabs, samples, floorList, findHoles(mesh, zmin));
  }

  function PartModel(bbox, slabs, samples, floors, holes) {
    this.bbox = bbox;
    this.slabs = slabs;
    this.samples = samples; // sections, highest first
    this.floors = floors;
    this.holes = holes;
    this.filledHoles = [];
    this._cum = [[]]; // _cum[n] = union of the n highest sections
    this._cache = {};
  }

  PartModel.prototype.zTop = function () { return this.bbox[5]; };
  PartModel.prototype.zBottom = function () { return this.bbox[2]; };

  /** Material at or above z (the tool tip at z must stay out of it); drilled holes count as solid. */
  // Sections that count at height z: everything above it, plus, inside a band, the whole band when its
  // walls are vertical, or the section just below z when they slope (covers the wall between sections).
  // A tool tip exactly on a flat level never sees the band below it.
  PartModel.prototype.materialAbove = function (z) {
    var t = z - EPS;
    this.slabs.forEach(function (s) {
      if (z > s.zLo + EPS && z < s.zHi - EPS) t = s.sloped ? Math.max(s.zLo, z - SLICE - 0.01) : s.zLo;
    });
    var n = 0;
    while (n < this.samples.length && this.samples[n].z >= t) n++;
    var inHoles = this.filledHoles.filter(function (h) { return h.zTop > z + EPS; });
    var key = n + '/' + inHoles.map(function (h) { return h.x.toFixed(3) + ',' + h.y.toFixed(3) + ',' + h.diameter; }).join(';');
    if (this._cache[key]) return this._cache[key];
    while (this._cum.length <= n) {
      var i = this._cum.length;
      this._cum.push(Region.union(this._cum[i - 1], this.samples[i - 1].section));
    }
    var out = this._cum[n];
    var holes = [];
    inHoles.forEach(function (h) { holes = holes.concat(Region.circle(h.x, h.y, h.diameter / 2 + 0.05)); });
    if (holes.length) out = Region.union(out, holes);
    out = out.slice();
    out.key = key;
    return (this._cache[key] = out);
  };

  // ------------------------------------------------------------------ what the part looks like from the top

  var FACE = { other: 0, pocket: 1, hole: 2, outline: 3 };

  /** Classify each B-rep face for display (FACE.*) and summarise pockets, holes and the outline. */
  function features(mesh, model) {
    var bb = model.bbox, zmin = bb[2], zmax = bb[5];
    var cls = new Int8Array(mesh.faces.length);
    model.holes.forEach(function (h) { (h.faces || []).forEach(function (i) { cls[i] = FACE.hole; }); });
    var outline = Region.outers(model.materialAbove(zmin - 1));
    var band = Region.diff(Region.offset(outline, 0.05), Region.offset(outline, -0.05));
    var sloped = false;
    mesh.faces.forEach(function (f, i) {
      var n = f.end - f.start + 1, step = Math.max(1, Math.floor(n / 6)), top = true, bottom = true, onOutline = true;
      for (var k = f.start; k <= f.end; k++) {
        var t = mesh.tris[k];
        [t.a, t.b, t.c].forEach(function (v) { if (v.z < zmax - 1e-3) top = false; if (v.z > zmin + 1e-3) bottom = false; });
        var nz = Math.abs(t.n.z);
        if (nz > 0.01 && nz < 0.999) sloped = true;
        if ((k - f.start) % step === 0 && onOutline &&
            !Region.contains(band, (t.a.x + t.b.x + t.c.x) / 3, (t.a.y + t.b.y + t.c.y) / 3)) onOutline = false;
      }
      if (cls[i]) return;
      if (onOutline && !top && !bottom) cls[i] = FACE.outline;
      else if (!top && !bottom) cls[i] = FACE.pocket;
    });
    // Pockets: openings in the top layer inside the outline, holes left out.
    var topSec = model.slabs.length ? model.slabs[model.slabs.length - 1].section : [];
    var bottomSec = model.slabs.length ? model.slabs[0].section : [];
    var voids = Region.diff(outline, topSec);
    model.holes.forEach(function (h) { voids = Region.diff(voids, Region.circle(h.x, h.y, h.diameter / 2 + 0.1)); });
    voids = Region.clean(voids, 0.1);
    var pockets = voids.filter(function (p) { return Region.area([p]) > 1; }).map(function (p) {
      var inner = Region.offset([p], -0.2)[0] || p;
      return { area: Region.area([p]), through: !Region.contains(bottomSec, inner[0].x, inner[0].y) };
    });
    var holeGroups = {};
    model.holes.forEach(function (h) {
      var k = Math.round(h.diameter * 100) / 100 + (h.through ? ' through' : '');
      holeGroups[k] = (holeGroups[k] || 0) + 1;
    });
    return { faceClass: cls, pockets: pockets, holeGroups: holeGroups, height: zmax - zmin, sloped: sloped };
  }

  /** Share of the space under the top view that overhangs hide from the cutter (0 = all reachable, < 1).
   *  With both, also the share hidden from the top AND the bottom: what two setups (turned over) can't reach. */
  function hiddenFraction(model, both) {
    // Walk the sections from the top down; each stands for the Z range half way to its neighbours.
    var sm = model.samples, cum = [], hidden = 0, volume = 0, tops = [], ts = [];
    for (var i = 0; i < sm.length; i++) {
      var above = i ? (sm[i - 1].z + sm[i].z) / 2 : sm[i].slab.zHi;
      var below = i + 1 < sm.length ? (sm[i].z + sm[i + 1].z) / 2 : sm[i].slab.zLo;
      var t = above - below, a = Region.area(sm[i].section);
      cum = Region.union(cum, sm[i].section);
      hidden += (Region.area(cum) - a) * t;
      volume += a * t;
      tops.push(cum); ts.push(t);
    }
    var one = volume ? hidden / (hidden + volume) : 0;
    if (!both) return one;
    // From the bottom up: hidden from both sides = (covered from above) ∩ (covered from below) − the section itself.
    var cumB = [], hidden2 = 0;
    for (var j = sm.length - 1; j >= 0; j--) {
      cumB = Region.union(cumB, sm[j].section);
      hidden2 += Math.max(0, Region.area(Region.inter(tops[j], cumB)) - Region.area(sm[j].section)) * ts[j];
    }
    return { one: one, two: volume ? hidden2 / (hidden2 + volume) : 0 };
  }

  // ------------------------------------------------------------------ tools + cutting data

  var MATERIALS = {
    aluminum: { label: 'Aluminium', flat: [300, 0.008], face: [300, 0.05], drill: [50, 0.01], spot: [60, 0.02], doc: 0.5, step: 0.4 },
    wood: { label: 'Wood / MDF', flat: [350, 0.01], face: [500, 0.08], drill: [100, 0.02], spot: [150, 0.03], doc: 1.0, step: 0.45 },
    plastic: { label: 'Plastic (acrylic, HDPE)', flat: [250, 0.006], face: [350, 0.06], drill: [60, 0.015], spot: [100, 0.03], doc: 0.75, step: 0.45 },
    brass: { label: 'Brass', flat: [150, 0.003], face: [200, 0.04], drill: [40, 0.01], spot: [50, 0.02], doc: 0.4, step: 0.35 },
    steel: { label: 'Mild steel', flat: [80, 0.002], face: [120, 0.03], drill: [20, 0.008], spot: [30, 0.015], doc: 0.3, step: 0.3 }
  };

  /** Map an ncSender tool (from /api/tools/active) to the CAM's tool kind, or null if CAM can't use it. */
  function kindOf(ncTool) {
    switch (ncTool.type) {
      case 'flat': return 'flat';
      case 'surfacing': return 'face';
      case 'drill': return 'drill';
      case 'chamfer': case 'v-bit': return 'spot';
      default: return null; // ball, thread-mill, probe: not used by 2.5D CAM
    }
  }

  /** Default flutes, cutting speed and feed for a tool; per-tool overrides win. */
  // Router-bit names often carry what the tool table leaves empty, e.g. "Single Flute 1/4 6mm 22mm".
  var FLUTE_WORDS = { single: 1, one: 1, o: 1, two: 2, double: 2, three: 3, triple: 3, four: 4 };

  function flutesFromName(name) {
    var n = /(\d)\s*-?\s*(fl|flute)/i.exec(name) || /\b(single|one|o|two|double|three|triple|four)[\s-]*flutes?\b/i.exec(name);
    return n ? (Number(n[1]) || FLUTE_WORDS[n[1].toLowerCase()]) : null;
  }

  /** Cutting length from a name: the largest "<n>mm" well above the diameter. */
  function fluteLengthFromName(name, D) {
    var best = null, re = /(\d+(?:\.\d+)?)\s*mm/gi, m;
    while ((m = re.exec(name))) {
      var v = Number(m[1]);
      if (v > D * 1.5 && v <= 150 && (best === null || v > best)) best = v;
    }
    return best;
  }

  function angleFromName(name) {
    var m = /(\d{2,3})\s*(°|deg|%)/i.exec(name);
    return m && Number(m[1]) > 10 && Number(m[1]) < 180 ? Number(m[1]) : null;
  }

  function defaultCutting(ncTool, materialKey) {
    var kind = kindOf(ncTool), m = MATERIALS[materialKey] || MATERIALS.aluminum, D = ncTool.diameter;
    // Unknown flute count: 2, the safe guess (more flutes would mean a higher feed).
    var flutes = flutesFromName(ncTool.name || '') || 2;
    var preset = m[kind] || m.flat;
    var fz = kind === 'flat' || kind === 'drill' ? preset[1] * D : preset[1];
    fz = Math.max(0.005, Math.min(fz, kind === 'drill' ? 0.3 : 0.1));
    return { flutes: flutes, vc: preset[0], fz: Math.round(fz * 10000) / 10000 };
  }

  function cuttingData(tool, machine) {
    var rpm = tool.rpm || tool.vc * 1000 / (Math.PI * tool.diameter);
    var ideal = rpm;
    rpm = Math.max(machine.minRpm, Math.min(machine.maxRpm, rpm));
    var feed = tool.feed || rpm * tool.flutes * tool.fz;
    feed = Math.min(machine.maxFeed, feed);
    return { rpm: Math.round(rpm), feed: Math.round(feed), plunge: Math.round(feed * 0.3), ramp: Math.round(feed * 0.5),
             clampedRpm: !tool.rpm && Math.abs(ideal - rpm) > 1 ? Math.round(ideal) : null };
  }

  /** Build CAM tools from ncSender tools + per-tool settings. */
  function buildTools(ncTools, overrides, materialKey) {
    var m = MATERIALS[materialKey] || MATERIALS.aluminum;
    return ncTools.filter(function (t) { return kindOf(t) && t.diameter > 0 && t.toolId > 0; }).map(function (t) {
      var kind = kindOf(t), o = (overrides || {})[t.toolId] || {}, d = defaultCutting(t, materialKey);
      if (o.enabled === false) return null;
      var D = t.diameter;
      var flute = (t.dimensions && t.dimensions.flute_length) || o.fluteLength || (kind !== 'spot' && fluteLengthFromName(t.name || '', D)) ||
        (kind === 'drill' ? D * 8 : kind === 'face' ? 3 : kind === 'spot' ? D : D * 3);
      var point = kind === 'spot' ? (t.dimensions && t.dimensions.taper_angle) || angleFromName(t.name || '') || 90 :
        kind === 'drill' ? (t.dimensions && t.dimensions.taper_angle) || 118 : 180;
      return {
        number: t.toolId, label: 'T' + t.toolId + ' ' + (t.name || t.type) + ' D' + D, name: t.name || '', kind: kind,
        diameter: D, radius: D / 2, fluteLength: flute, flutes: o.flutes || d.flutes, vc: o.vc || d.vc, fz: o.fz || d.fz,
        rpm: o.rpm || 0, feed: o.feed || 0, pointAngle: point,
        maxDoc: o.maxDoc || Math.min(flute * 0.9, kind === 'face' ? 0.5 : D * m.doc),
        stepover: o.stepover || D * (kind === 'face' ? 0.7 : m.step),
        tipLength: point >= 180 ? 0 : (D / 2) / Math.tan(point / 2 * Math.PI / 180)
      };
    }).filter(Boolean);
  }

  // ------------------------------------------------------------------ planning

  function Path(op, safeZ) { this.op = op; this.safeZ = safeZ; this.pos = null; }
  Path.prototype.rapid = function (x, y, z) { this.op.moves.push({ r: 1, x: x, y: y, z: z }); this.pos = { x: x, y: y, z: z }; };
  Path.prototype.feed = function (x, y, z, f) { this.op.moves.push({ r: 0, x: x, y: y, z: z, f: f }); this.pos = { x: x, y: y, z: z }; };
  Path.prototype.goSafe = function (x, y) {
    if (this.pos && this.pos.z < this.safeZ) this.rapid(this.pos.x, this.pos.y, this.safeZ);
    this.rapid(x, y, this.safeZ);
  };
  Path.prototype.retract = function () { if (this.pos) this.goSafe(this.pos.x, this.pos.y); };

  function closed(p) { return p.concat([p[0]]); }

  /** Drop vertices that sit within tol of the chord to the next kept vertex (closed path). */
  function simplify(p, tol) {
    if (p.length < 5) return p;
    var out = [p[0]];
    for (var i = 1; i < p.length; i++) {
      var next = p[(i + 1) % p.length];
      if (ptSeg(p[i], out[out.length - 1], next) > tol) out.push(p[i]);
    }
    return out.length >= 3 ? out : p;
  }

  /** Rings of a region that come within `reach` of the stock (skips pure-air rings beyond it). */
  function rings(region, stockRect, reach) {
    return region.filter(function (p) {
      for (var i = 0; i < p.length; i++) {
        if (segRectDistance(p[i], p[(i + 1) % p.length], stockRect) < reach) return true;
      }
      return false;
    }).map(function (p) { return closed(simplify(p, 0.002)); });
  }

  function rotateTo(loop, pt) {
    var ring = loop.slice(0, -1), bi = 0, bd = Infinity;
    ring.forEach(function (q, i) { var d = dist(q, pt); if (d < bd) { bd = d; bi = i; } });
    ring = ring.slice(bi).concat(ring.slice(0, bi));
    return closed(ring);
  }

  function loopLength(loop) {
    var L = 0;
    for (var i = 1; i < loop.length; i++) L += dist(loop[i - 1], loop[i]);
    return L;
  }

  /** Ramp down along the loop itself (whole laps), then cut one lap at depth. */
  function rampThenLoop(path, loop, zFrom, zTo, cut, angle) {
    var length = loopLength(loop);
    path.feed(loop[0].x, loop[0].y, zFrom, cut.ramp);
    if (length < 1e-3) { path.feed(loop[0].x, loop[0].y, zTo, cut.plunge); return; }
    var need = (zFrom - zTo) / Math.tan(angle * Math.PI / 180);
    var laps = Math.max(1, Math.ceil(need / length)), total = laps * length, d = 0;
    for (var l = 0; l < laps; l++) {
      for (var i = 1; i < loop.length; i++) {
        d += dist(loop[i - 1], loop[i]);
        path.feed(loop[i].x, loop[i].y, zFrom - (zFrom - zTo) * d / total, cut.ramp);
      }
    }
    for (var k = 1; k < loop.length; k++) path.feed(loop[k].x, loop[k].y, zTo, cut.feed);
  }

  /** Offset (contour-parallel) clearing of a tool-centre region, from the inside out. */
  function clearRegion(path, region, z, zPrev, tool, cut, stockRect, s) {
    var loops = [], cur = region;
    while (cur.length) {
      loops = loops.concat(rings(cur, stockRect, tool.radius - 0.01));
      cur = Region.offset(cur, -tool.stepover, 0.05);
    }
    loops.reverse();
    var allowed = Region.offset(region, 0.01);
    var atDepth = false;
    loops.forEach(function (loop) {
      if (atDepth) {
        loop = rotateTo(loop, path.pos);
        if (dist(path.pos, loop[0]) <= tool.stepover * 1.5 && segmentInside(allowed, path.pos, loop[0])) {
          loop.forEach(function (q) { path.feed(q.x, q.y, z, cut.feed); });
          return;
        }
      }
      path.goSafe(loop[0].x, loop[0].y);
      path.rapid(loop[0].x, loop[0].y, zPrev + 0.5);
      rampThenLoop(path, loop, zPrev + 0.5, z, cut, s.rampAngle);
      atDepth = true;
    });
  }

  function levelsBetween(top, floors, bottom, step) {
    var bounds = [top].concat(floors.filter(function (f) { return f > bottom && f < top; })).concat([bottom]);
    var out = [];
    for (var i = 0; i + 1 < bounds.length; i++) {
      var a = bounds[i], b = bounds[i + 1], n = Math.max(1, Math.ceil((a - b) / step - 1e-9));
      for (var k = 1; k <= n; k++) out.push(a - (a - b) * k / n);
    }
    return out;
  }

  var DEFAULTS = {
    stockXY: 2, stockTop: 1, leave: 0.2, skin: 1, safeZ: 5, rampAngle: 3, coverage: 0.9, origin: 'front-left',
    // Two setups: setup 1 (from the top) or 2 (turned over); 0 = one setup.
    setup: 0, split: 0, stockBottom: 1, frame: 6, web: 0.5, overlap: 0.2, skipHoles: [],
    slopeStep: 0.5, // finishing contour spacing through sloped or curved walls, mm
    room: 0.1 // a tool needs this share of its diameter as free room (each side) to work in a pocket or hole
  };

  /** Depth from the part top where setup 1 hands over to setup 2 (0 in settings = automatic). */
  function autoSplit(partH, flute) {
    return Math.round(Math.min(flute, Math.max(partH / 2, partH - flute)) * 10) / 10;
  }

  /**
   * Plan every operation automatically.
   * tools: from buildTools(); machine: {maxRpm, minRpm, maxFeed, rapidRate, toolChangeS}; settings: see DEFAULTS.
   */
  function plan(model, tools, machine, settings) {
    var s = Object.assign({}, DEFAULTS, settings || {});
    var bb = model.bbox, zmin = bb[2], zmax = bb[5], partH = zmax - zmin;
    var two = s.setup === 1 || s.setup === 2;
    var ops = [], warnings = [];
    var mills = tools.filter(function (t) { return t.kind === 'flat'; }).sort(function (a, b) { return b.diameter - a.diameter; });
    if (!mills.length) throw new Error('No flat end mill is loaded in ncSender. Add at least one to the tool table.');
    model.filledHoles = [];
    var longest = mills.reduce(function (a, t) { return t.fluteLength > a.fluteLength ? t : a; });

    // Two setups: roughing clears only a moat around the part and leaves a full-height frame of stock,
    // which the vise holds in both setups and setup 2 zeroes on.
    var footprint = Region.outers(model.materialAbove(zmin - 1));
    var moat = two ? Math.ceil(mills[0].diameter + 1) : 0;
    var stockXY = two ? Math.max(s.stockXY, moat + s.frame) : s.stockXY;
    if (two && stockXY > s.stockXY) {
      warnings.push('Two setups keep a ' + s.frame + ' mm frame outside a ' + moat + ' mm moat, so the stock margin is ' +
        stockXY + ' mm per side.');
    }
    var sr = [bb[0] - stockXY, bb[1] - stockXY, bb[3] + stockXY, bb[4] + stockXY];
    var stock = Region.rect(sr[0], sr[1], sr[2], sr[3]);
    var clearArea = two ? Region.inter(stock, Region.offset(footprint, moat)) : stock;
    var faceAllow = s.setup === 2 ? s.stockBottom : s.stockTop;
    var stockTop = zmax + faceAllow, safe = stockTop + s.safeZ;

    // Depth: one setup stops at the bottom skin; setup 1 at the split; setup 2 just past it inside the part
    // outline, and a web short of it in the moat so the part stays on the frame. Never deeper than the flutes.
    // A hole can be machined from the top only if nothing covers it.
    model.holes.forEach(function (h) {
      var above = Region.inter(model.materialAbove(h.zTop), Region.circle(h.x, h.y, h.diameter / 2 * 0.9));
      h.openTop = Region.area(above) < 0.01;
    });
    var split = 0;
    if (two && s.split > 0) {
      split = Math.min(s.split, partH);
    } else if (two) {
      // Automatic: about half way, but where every hole can be finished from the side it opens to.
      split = autoSplit(partH, longest.fluteLength);
      if (s.setup === 1) {
        var lo = 0, hi = partH;
        model.holes.forEach(function (h) {
          if (h.openTop && !h.through) lo = Math.max(lo, zmax - h.zBottom); // setup 1 must reach its bottom
          if (!h.openTop) hi = Math.min(hi, zmax - h.zTop); // setup 2 must reach its top end
        });
        lo = Math.min(lo, longest.fluteLength);
        hi = Math.max(hi, partH - longest.fluteLength);
        if (lo <= hi) split = Math.round(Math.max(lo, Math.min(hi, split)) * 10) / 10;
      }
    }
    var zLimit, zMoat;
    if (s.setup === 1) {
      zLimit = zMoat = zmax - split;
    } else if (s.setup === 2) {
      var meet = zmax - (partH - split);
      zLimit = meet - s.overlap;
      zMoat = meet + s.web;
    } else {
      zLimit = zMoat = zmin + s.skin;
      if (s.skin > 0) {
        warnings.push('Milling stops ' + s.skin + ' mm above the part bottom (Leave at bottom), so through holes, slots and the ' +
          'outline are not cut through. Set it to 0, or a little below to cut into the spoilboard, to cut through; the part then ' +
          'needs holding down (screws, vacuum or tabs).');
      } else {
        warnings.push('This program cuts through the bottom' + (s.skin < 0 ? ' and ' + (-s.skin) + ' mm into the spoilboard' : '') +
          ': the part comes free at the end. Hold it down with screws, vacuum or tape (no holding tabs are added yet).');
      }
    }

    if (s.setup === 2 && zmax - zLimit > longest.fluteLength + EPS && zmax - (zLimit + s.overlap) <= longest.fluteLength + EPS) {
      zLimit = zmax - longest.fluteLength; // only the break-through overshoot is out of reach: just trim it
    } else if (zmax - zLimit > longest.fluteLength + EPS) {
      var short = zmax - zLimit - longest.fluteLength;
      zLimit = zmax - longest.fluteLength;
      zMoat = Math.max(zMoat, zLimit);
      warnings.push(two
        ? 'Setup ' + s.setup + ' needs ' + (longest.fluteLength + short).toFixed(1) + ' mm of depth but the longest end mill (' +
          longest.label + ') has ' + longest.fluteLength + ' mm of flute: ' + short.toFixed(1) + ' mm ' +
          'where the setups meet stays uncut. Load a longer tool' + (s.setup === 1 ? '.' : ', or change the split depth.')
        : 'The longest end mill (' + longest.label + ') has ' + longest.fluteLength + ' mm of flute, so milling stops ' +
          longest.fluteLength + ' mm deep, ' + (zLimit - zmin).toFixed(1) + ' mm above the part bottom. Use Two setups ' +
          'to machine the rest from the other side, or load a longer tool.');
    }

    var skinLimited = !two && Math.abs(zLimit - (zmin + s.skin)) < EPS;

    // Step-down levels stop on every floor, and on the web depth in setup 2.
    var stops = model.floors.concat(two && zMoat > zLimit + EPS ? [zMoat] : []).sort(function (a, b) { return b - a; });

    var outerCache = {}, centreCache = {};
    // Tool-centre region at height z. Coarse (0.05 mm arcs) is fine whenever at least 0.1 mm of stock is left
    // on the walls, or when only measuring; finishing (leave 0) uses the fine default.
    function centresAt(z, r, leave, coarse) {
      var part = model.materialAbove(z);
      var side = two && z < zMoat - EPS ? 'in' : 'out';
      var tol = coarse || leave >= 0.1 ? 0.05 : 0.005;
      var key = part.key + '|' + r + '|' + leave + '|' + side + '|' + tol;
      if (centreCache[key]) return centreCache[key];
      if (!outerCache[r + side]) {
        outerCache[r + side] = !two ? Region.offset(stock, r + 1)
          : side === 'in' ? Region.offset(footprint, -r) // under the web: only inside the part outline
          : Region.offset(footprint, moat - r);
      }
      return (centreCache[key] = { region: Region.diff(outerCache[r + side], Region.offset(part, r + leave, tol)), part: part });
    }
    // What there is to cut at z: under the web only the inside of the part outline.
    function cutArea(z) { return two && z < zMoat - EPS ? footprint : clearArea; }
    // Drop the parts of a tool-centre region too narrow to move in: an end mill that only just fits a hole
    // would have to plunge straight down like a drill.
    function roomy(region, r, tol) {
      var c = 2 * r * s.room;
      return c > 0 ? Region.offset(Region.offset(region, -c, tol), c, tol) : region;
    }
    // Where a roughing tool may go at z: judged for room against the true wall (no allowance), then kept the
    // allowance away from it. Judging with the allowance would skip holes the finishing pass then plunges into.
    function cutRegion(z, tool, leave) {
      var withRoom = roomy(centresAt(z, tool.radius, 0, true).region, tool.radius, 0.05);
      return Region.inter(centresAt(z, tool.radius, leave).region, withRoom);
    }
    function residual(z, r) {
      var c = centresAt(z, r, 0, true);
      return Region.area(Region.diff(Region.diff(cutArea(z), c.part), Region.offset(roomy(c.region, r, 0.05), r)));
    }

    function newOp(name, tool) {
      var op = { name: name, tool: tool, cutting: cuttingData(tool, machine), moves: [] };
      if (op.cutting.clampedRpm && ops.every(function (o) { return o.tool !== tool; })) {
        warnings.push(tool.label + ' wants ' + op.cutting.clampedRpm + ' RPM; the spindle range limits it to ' +
          op.cutting.rpm + ' RPM (chip load kept).');
      }
      ops.push(op);
      return { op: op, path: new Path(op, safe) };
    }

    // Holes finished in setup 1 are left alone in setup 2.
    var done = model.holes.filter(function (h) {
      return (s.skipHoles || []).some(function (k) {
        return Math.abs(k.x - h.x) < 0.05 && Math.abs(k.y - h.y) < 0.05 && Math.abs(k.diameter - h.diameter) < 0.02;
      });
    });

    // Holes with a matching drill are drilled; milling treats them as solid.
    var drilled = [];
    model.holes.forEach(function (h) {
      if (!h.openTop || done.indexOf(h) >= 0) return;
      var d = tools.filter(function (t) {
        return t.kind === 'drill' && Math.abs(t.diameter - h.diameter) <= 0.02 && t.fluteLength >= h.depth + t.tipLength;
      }).sort(function (a, b) { return a.fluteLength - b.fluteLength; })[0];
      if (d) drilled.push({ hole: h, tool: d });
    });
    model.filledHoles = drilled.map(function (d) { return d.hole; }).concat(done);

    // 1. Facing
    if (faceAllow > 0.01) {
      var faceTool = tools.filter(function (t) { return t.kind === 'face'; }).sort(function (a, b) { return b.diameter - a.diameter; })[0] || mills[0];
      var f = newOp('Face', faceTool), r = faceTool.radius, ys = [], y = sr[1] + r - 1;
      for (;;) {
        ys.push(Math.min(y, sr[3] - r + 1));
        if (ys[ys.length - 1] + r >= sr[3]) break;
        y += faceTool.stepover;
      }
      var xa = sr[0] - r - 2, xb = sr[2] + r + 2;
      levelsBetween(stockTop, [], zmax, faceTool.maxDoc).forEach(function (z) {
        f.path.goSafe(xa, ys[0]);
        f.path.rapid(xa, ys[0], z);
        ys.forEach(function (yy, i) {
          var x0 = i % 2 ? xb : xa, x1 = i % 2 ? xa : xb;
          f.path.feed(x0, yy, z, f.op.cutting.feed);
          f.path.feed(x1, yy, z, f.op.cutting.feed);
        });
      });
      f.path.retract();
    }

    // 2. Tool choice: roughing tool by reach and coverage, rest tool for what it misses.
    // Sample the bottom of every Z slab in reach, so features between floors (holes, slots) count too.
    var sample = [zLimit];
    model.slabs.forEach(function (sl) {
      var z = Math.max(sl.zLo + 0.01, zLimit);
      if (sl.zHi > zLimit + EPS && sample.every(function (q) { return Math.abs(q - z) > EPS; })) sample.push(z);
    });
    var reach = zmax - zLimit;
    var longMills = mills.filter(function (t) { return t.fluteLength >= reach; });
    if (!longMills.length) {
      longMills = [mills.slice().sort(function (a, b) { return b.fluteLength - a.fluteLength; })[0]];
      warnings.push('No end mill has ' + reach.toFixed(1) + ' mm of flute; using the longest one. Check holder clearance.');
    }
    var res = {};
    mills.forEach(function (t) {
      res[t.number] = {};
      sample.forEach(function (z) { res[t.number][z] = residual(z, t.radius); });
    });
    var total = sample.reduce(function (acc, z) { return acc + Region.area(Region.diff(cutArea(z), model.materialAbove(z))); }, 0) || 1;
    function sum(t) { return sample.reduce(function (acc, z) { return acc + res[t.number][z]; }, 0); }
    var rough = longMills.filter(function (t) { return 1 - sum(t) / total >= s.coverage; })[0] || longMills[longMills.length - 1];
    function leftAfter(t) {
      return sample.reduce(function (acc, z) {
        return acc + (z >= zmax - t.fluteLength * 0.95 ? res[t.number][z] : res[rough.number][z]);
      }, 0);
    }
    var smaller = mills.filter(function (t) { return t.diameter < rough.diameter; }), rest = null;
    if (smaller.length) {
      var best = Math.min.apply(null, smaller.map(leftAfter));
      if (leftAfter(rough) - best > 1) {
        var slack = Math.max(2, 0.05 * leftAfter(rough));
        rest = smaller.filter(function (t) { return leftAfter(t) <= best + slack; })[0];
      }
    }
    var left = leftAfter(rest || rough);
    if (left > 5) warnings.push('About ' + Math.round(left) + ' mm² (summed over levels) is narrower than the smallest end mill and stays uncut.');

    // 3. Roughing
    var ro = newOp('Rough', rough), zPrev = zmax;
    levelsBetween(zmax, stops, zLimit, rough.maxDoc).forEach(function (z) {
      var region = cutRegion(z, rough, s.leave);
      if (!region.length) return;
      clearRegion(ro.path, region, z, zPrev, rough, ro.op.cutting, sr, s);
      zPrev = z;
    });
    ro.path.retract();

    // 4. Rest roughing
    var restFloor = rest ? zmax - rest.fluteLength * 0.95 : zmax;
    if (rest) {
      var rr = newOp('Rest rough', rest);
      zPrev = zmax;
      levelsBetween(zmax, stops, Math.max(zLimit, restFloor), rest.maxDoc).forEach(function (z) {
        var small = centresAt(z, rest.radius, s.leave).region;
        // What roughing really cleared: it skips spots too tight to move in (see roomy), so rest machining must not count them.
        var big = cutRegion(z, rough, s.leave);
        var remaining = Region.clean(Region.inter(Region.diff(Region.offset(small, rest.radius), Region.offset(big, rough.radius)), clearArea), 0.05);
        if (Region.area(remaining) < 0.5) return;
        clearRegion(rr.path, Region.inter(cutRegion(z, rest, s.leave), Region.offset(remaining, rest.radius)), z, zPrev, rest, rr.op.cutting, sr, s);
        zPrev = z;
      });
      if (!rr.op.moves.length) ops.splice(ops.indexOf(rr.op), 1); else rr.path.retract();
    }

    // 5. Wall finishing: climb, lead in from roughed-out area. Small tool where it reaches, rough tool below.
    var finStep = Math.min.apply(null, [rough, rest].filter(Boolean).map(function (t) { return t.fluteLength; })) * 0.8;
    var finLevels = levelsBetween(zmax, stops, zLimit, finStep);
    // Sloped or curved walls: a contour every slopeStep mm, so the stairs roughing leaves stay small.
    model.slabs.forEach(function (sl) {
      if (!sl.sloped) return;
      var step = Math.max(0.1, s.slopeStep || 0);
      if (!(s.slopeStep > 0)) return; // 0 = no extra finishing on slopes
      for (var zz = Math.min(sl.zHi, zmax) - step; zz > Math.max(sl.zLo, zLimit) + 0.05; zz -= step) finLevels.push(zz);
    });
    finLevels.sort(function (a, b) { return b - a; });
    finLevels = finLevels.filter(function (z, i) { return !i || finLevels[i - 1] - z > 0.05; });
    var restLevels = rest ? finLevels.filter(function (z) { return z >= restFloor; }) : [];
    [[rest, restLevels], [rough, finLevels.filter(function (z) { return restLevels.indexOf(z) < 0; })]].forEach(function (pair) {
      var tool = pair[0], lv = pair[1];
      if (!tool || !lv.length) return;
      var fo = newOp('Finish walls', tool);
      var zp = tool === rough && restLevels.length ? restLevels[restLevels.length - 1] : zmax;
      lv.forEach(function (z) {
        var c = centresAt(z, tool.radius, 0), region = roomy(c.region, tool.radius, 0.005);
        var approach = Region.offset(region, -(s.leave + 0.5));
        var inside = Region.offset(region, 0.01);
        var nearPart = Region.offset(c.part, tool.radius + 0.1);
        rings(region, sr, tool.radius - 0.01).filter(function (loop) { // walls only, not the moat's outer edge
          return [0, 1, 2].some(function (k) { var q = loop[Math.floor(k * (loop.length - 1) / 3)]; return Region.contains(nearPart, q.x, q.y); });
        }).forEach(function (loop) {
          var start = loop[0], entry = null;
          if (approach.length) {
            var p = nearestOnRegion(approach, start);
            if (p && dist(p, start) < tool.diameter * 2 && segmentInside(inside, start, p)) entry = p;
          }
          var pt = entry || start;
          fo.path.goSafe(pt.x, pt.y);
          fo.path.rapid(pt.x, pt.y, (entry ? z : zp) + 0.5);
          fo.path.feed(pt.x, pt.y, z, fo.op.cutting.plunge);
          loop.forEach(function (q) { fo.path.feed(q.x, q.y, z, fo.op.cutting.feed); });
          if (entry) fo.path.feed(entry.x, entry.y, z, fo.op.cutting.feed);
        });
        zp = z;
      });
      fo.path.retract();
    });

    // 6. Spot + peck drilling
    if (drilled.length) {
      var spot = tools.filter(function (t) { return t.kind === 'spot'; }).sort(function (a, b) { return b.diameter - a.diameter; })[0];
      if (spot) {
        var so = newOp('Spot drill', spot);
        nearestOrder(drilled.map(function (d) { return d.hole; })).forEach(function (h) {
          // A V-bit's library diameter is often its tip (e.g. 0.1 mm); its cone is about a 1/4" shank wide.
          var d = Math.min(h.diameter, spot.diameter >= 1 ? spot.diameter * 0.9 : 6);
          var bottom = h.zTop - (d / 2) / Math.tan(spot.pointAngle / 2 * Math.PI / 180);
          so.path.goSafe(h.x, h.y);
          so.path.rapid(h.x, h.y, h.zTop + 2);
          so.path.feed(h.x, h.y, bottom, so.op.cutting.plunge);
          so.path.rapid(h.x, h.y, h.zTop + 2);
        });
        so.path.retract();
      }
      var byTool = {};
      drilled.forEach(function (d) { (byTool[d.tool.number] = byTool[d.tool.number] || { tool: d.tool, holes: [] }).holes.push(d.hole); });
      Object.keys(byTool).map(function (k) { return byTool[k]; })
        .sort(function (a, b) { return a.tool.diameter - b.tool.diameter; })
        .forEach(function (g) {
          var dop = newOp('Drill', g.tool), drill = g.tool;
          nearestOrder(g.holes).forEach(function (h) {
            var rPlane = h.zTop + 2;
            var bottom = h.zBottom - drill.tipLength - (h.through ? 1 : 0);
            var peck = h.zTop - bottom > 3 * drill.diameter ? drill.diameter : h.zTop - bottom + 2;
            dop.path.goSafe(h.x, h.y);
            dop.path.rapid(h.x, h.y, rPlane);
            var z = h.zTop;
            while (z > bottom + 1e-6) {
              z = Math.max(bottom, z - peck);
              dop.path.feed(h.x, h.y, z, dop.op.cutting.plunge);
              dop.path.rapid(h.x, h.y, rPlane);
              if (z > bottom + 1e-6) dop.path.rapid(h.x, h.y, z + 0.5);
            }
          });
          dop.path.retract();
        });
    }

    function listed(list, h) {
      return (list || []).some(function (k) {
        return Math.abs(k.x - h.x) < 0.05 && Math.abs(k.y - h.y) < 0.05 && Math.abs(k.diameter - h.diameter) < 0.02;
      });
    }
    var milledHoles = [];
    model.holes.forEach(function (h) {
      if (model.filledHoles.indexOf(h) >= 0 || listed(s.doneInSetup1, h)) return;
      var where = 'Hole Ø' + h.diameter + ' at (' + h.x.toFixed(1) + ', ' + h.y.toFixed(1) + ')';
      if (!h.openTop) {
        if (listed(s.otherSide, h)) return; // machined (or reported) in setup 1
        warnings.push(where + (s.setup === 1 ? ' opens from the other side: it is machined in setup 2.'
          : s.setup === 2 ? ' is covered from both sides: NOT machined.'
          : ' is covered from above (it opens from below): use Two setups to machine it from the other side.'));
        return;
      }
      var fitsIn = function (t) { return t.diameter * (1 + 2 * s.room) <= h.diameter + 1e-6; };
      var mill = rest && fitsIn(rest) && h.zBottom >= restFloor - EPS ? rest : fitsIn(rough) ? rough : null;
      if (!mill) {
        var fits = mills.filter(fitsIn);
        var depth = zmax - h.zBottom;
        warnings.push(where + ': no Ø' + h.diameter + ' drill is loaded, and ' + (fits.length
          ? 'the end mills small enough for it (' + fits.map(function (t) { return 'T' + t.number; }).join(', ') +
            ') are too short for its ' + depth.toFixed(1) + ' mm depth'
          : 'every end mill is too big for it') + ': NOT machined.');
      } else if (h.zBottom < zLimit - EPS && skinLimited) {
        milledHoles.push(h); // stops at the bottom skin, as warned above
      } else if (h.zBottom < zLimit - EPS) {
        warnings.push(where + ' is ' + (zmax - h.zBottom).toFixed(1) + ' mm deep from this side but milling reaches ' +
          (zmax - zLimit).toFixed(1) + ' mm: ' + mill.label + ' leaves its last ' + (zLimit - h.zBottom).toFixed(1) +
          ' mm uncut. A longer end mill would finish it.');
      } else {
        milledHoles.push(h);
        warnings.push(where + ' has no matching drill: milled by ' + mill.label + '.');
      }
    });

    var origin = s.origin === 'center'
      ? { x: (sr[0] + sr[2]) / 2, y: (sr[1] + sr[3]) / 2, z: stockTop }
      : { x: sr[0], y: sr[1], z: stockTop };
    var stockZ0 = two ? zmin - (s.setup === 2 ? s.stockTop : s.stockBottom) : zmin;
    return {
      ops: ops, warnings: warnings, safeZ: safe, origin: origin, originName: s.origin,
      stock: { x0: sr[0], y0: sr[1], z0: stockZ0, x1: sr[2], y1: sr[3], z1: stockTop },
      tools: { rough: rough, rest: rest }, drilled: drilled, setup: s.setup, split: split, zFloor: zLimit,
      openHoles: model.holes.filter(function (h) { return h.openTop; }),
      finishedHoles: drilled.map(function (d) { return d.hole; }).concat(milledHoles),
      notes: !two ? [] : s.setup === 1
        ? ['Setup 1 of 2: from the top, down to ' + split.toFixed(1) + ' mm below the part top. A ' + stockXY +
           ' mm margin keeps a frame of stock for the vise.']
        : ['Setup 2 of 2: part turned over about the ' + (s.flip || 'X') + ' axis, clamped on the frame.',
           'Re-zero G54 on the new stock top, ' + (s.origin === 'center' ? 'centre' : 'front-left corner') + '.',
           'A ' + s.web + ' mm web holds the part to the frame; cut it free afterwards.']
    };
  }

  function nearestOrder(holes) {
    var left = holes.slice(), out = [], cur = { x: 0, y: 0 };
    while (left.length) {
      var bi = 0, bd = Infinity;
      left.forEach(function (h, i) { var d = dist(h, cur); if (d < bd) { bd = d; bi = i; } });
      cur = left.splice(bi, 1)[0];
      out.push(cur);
    }
    return out;
  }

  function estimateSeconds(p, machine) {
    var t = 0, prevTool = null, pos = null;
    p.ops.forEach(function (op) {
      if (op.tool !== prevTool) { t += machine.toolChangeS; prevTool = op.tool; }
      op.moves.forEach(function (m) {
        if (pos) t += Math.hypot(m.x - pos.x, m.y - pos.y, m.z - pos.z) / (m.r ? machine.rapidRate : m.f) * 60;
        pos = m;
      });
    });
    return t;
  }

  // ------------------------------------------------------------------ post (grblHAL / ncSender)

  function num(v) {
    var s = v.toFixed(3).replace(/\.?0+$/, '');
    return s === '-0' || s === '' ? '0' : s;
  }

  // grblHAL ends a comment at the first ')', so brackets inside one (a file named "part (1).step") must go.
  // grblHAL comments: no nested brackets, plain ASCII only (file names and labels may hold − × Ø and the like).
  function comment(text) {
    var t = String(text).replace(/\(/g, '[').replace(/\)/g, ']').replace(/[\u2212\u2013\u2014]/g, '-').replace(/\u00d7/g, 'x').replace(/[\u00d8\u2300]/g, 'D');
    return '(' + t.replace(/[^\x20-\x7e]/g, '?') + ')';
  }

  function post(p, name) {
    var o = p.origin, st = p.stock, safe = num(p.safeZ - o.z);
    var out = [
      comment(name + ' - AutoCAM for ncSender'),
      '(Stock ' + num(st.x1 - st.x0) + ' x ' + num(st.y1 - st.y0) + ' x ' + num(st.z1 - st.z0) + ' mm)',
      '(G54 zero: stock top, ' + (p.originName === 'center' ? 'centre' : 'front-left corner') + ')',
      '(MODEL-ORIGIN X' + num(o.x) + ' Y' + num(o.y) + ' Z' + num(o.z) + ')'
    ].concat((p.placement || []).map(comment)).concat((p.notes || []).map(comment)).concat([
      'G21 G90 G94 G17',
      'G54'
    ]);
    var tool = null;
    p.ops.forEach(function (op) {
      out.push(comment(op.name + ' - ' + op.tool.label + ' S' + op.cutting.rpm + ' F' + op.cutting.feed));
      if (op.tool !== tool) {
        out.push('G0 Z' + safe, 'M5', 'M6 T' + op.tool.number, 'S' + op.cutting.rpm + ' M3', 'G4 P3');
        tool = op.tool;
      } else {
        out.push('S' + op.cutting.rpm);
      }
      var last = { G: null, X: null, Y: null, Z: null, F: null };
      op.moves.forEach(function (m) {
        var axes = [];
        [['X', m.x - o.x], ['Y', m.y - o.y], ['Z', m.z - o.z]].forEach(function (a) {
          var t = num(a[1]);
          if (t !== last[a[0]]) { axes.push(a[0] + t); last[a[0]] = t; }
        });
        if (!axes.length) return;
        var words = [], g = m.r ? 'G0' : 'G1';
        if (g !== last.G) { words.push(g); last.G = g; }
        words = words.concat(axes);
        if (!m.r && num(m.f) !== last.F) { last.F = num(m.f); words.push('F' + last.F); }
        out.push(words.join(' '));
      });
    });
    out.push('G0 Z' + safe, 'M5', 'G0 X0 Y0', 'M30');
    return out.join('\n') + '\n';
  }

  root.AutoCAM = {
    Region: Region, readMesh: readMesh, analyze: analyze, FLIP: FLIP, autoSplit: autoSplit, UP_MATRIX: UP_MATRIX,
    matrixOf: matrixOf, mulMat: mulMat, alignToZ: alignToZ, features: features, hiddenFraction: hiddenFraction, FACE: FACE, section: section, MATERIALS: MATERIALS, kindOf: kindOf,
    defaultCutting: defaultCutting, cuttingData: cuttingData, buildTools: buildTools, plan: plan, post: post,
    estimateSeconds: estimateSeconds, DEFAULTS: DEFAULTS
  };
})(typeof window !== 'undefined' ? window : globalThis);
