// carmesh.js — pure geometry for the rally car (no three.js), so it can be previewed offline.
// Units are metres, +Z is forward, origin on the ground at the car's centre.

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function rotXYZ(p, r) {
  const [x, y, z] = p;
  const [rx, ry, rz] = r || [0, 0, 0];
  // X
  let y1 = y * Math.cos(rx) - z * Math.sin(rx);
  let z1 = y * Math.sin(rx) + z * Math.cos(rx);
  // Y
  let x2 = x * Math.cos(ry) + z1 * Math.sin(ry);
  let z2 = -x * Math.sin(ry) + z1 * Math.cos(ry);
  // Z
  let x3 = x2 * Math.cos(rz) - y1 * Math.sin(rz);
  let y3 = x2 * Math.sin(rz) + y1 * Math.cos(rz);
  return [x3, y3, z2];
}

// rounded rectangle cross-section, counter-clockwise in the XY plane
function rr(hw, yb, yt, r, seg = 3) {
  const pts = [];
  const push = (x, y) => pts.push([x, y]);
  r = Math.min(r, (yt - yb) / 2 - 1e-3, hw - 1e-3);
  const arc = (cx, cy, a0) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (Math.PI / 2) * (i / seg);
      push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  arc(hw - r, yb + r, -Math.PI / 2); // bottom right
  arc(hw - r, yt - r, 0); // top right
  arc(-hw + r, yt - r, Math.PI / 2); // top left
  arc(-hw + r, yb + r, Math.PI); // bottom left
  arc(hw - r, yb + r, 1.5 * Math.PI); // close along the bottom
  return pts;
}

function loftSections(sections) {
  // sections: [{z, pts:[[x,y],...]}] ordered rear -> front
  const pos = [];
  const idx = [];
  const n = sections[0].pts.length;
  for (const s of sections) {
    for (const [x, y] of s.pts) pos.push(x, y, s.z);
  }
  for (let s = 0; s < sections.length - 1; s++) {
    for (let k = 0; k < n - 1; k++) {
      const a = s * n + k; // rear k
      const b = s * n + k + 1; // rear k+1
      const c = (s + 1) * n + k; // front k
      const d = (s + 1) * n + k + 1; // front k+1
      idx.push(a, b, c, b, d, c);
    }
  }
  // caps
  const rear = sections[0];
  const front = sections[sections.length - 1];
  const cap = (sec, base, frontFace) => {
    let cx = 0;
    let cy = 0;
    for (const p of sec.pts) {
      cx += p[0];
      cy += p[1];
    }
    cx /= sec.pts.length;
    cy /= sec.pts.length;
    const ci = pos.length / 3;
    pos.push(cx, cy, sec.z);
    for (let k = 0; k < sec.pts.length - 1; k++) {
      const a = base + k;
      const b = base + k + 1;
      if (frontFace) idx.push(ci, a, b);
      else idx.push(ci, b, a);
    }
  };
  cap(rear, 0, false);
  cap(front, (sections.length - 1) * n, true);
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

function boxGeo(cx, cy, cz, sx, sy, sz, rot) {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ];
  const pos = [];
  const idx = [];
  for (const f of faces) {
    const base = pos.length / 3;
    for (const v of f.v) {
      const p = rotXYZ([v[0] + cx, v[1] + cy, v[2] + cz], rot);
      pos.push(p[0], p[1], p[2]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

function cylZ(cx, cy, cz, r, len, seg = 10) {
  const pos = [], idx = [];
  const z0 = cz - len / 2, z1 = cz + len / 2;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z0);
  }
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z1);
  }
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    idx.push(i, j, seg + j, i, seg + j, seg + i);
  }
  const c0 = pos.length / 3; pos.push(cx, cy, z0);
  const c1 = pos.length / 3; pos.push(cx, cy, z1);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    idx.push(c0, j, i);
    idx.push(c1, seg + i, seg + j);
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

function quadGeo(a, b, c, d) {
  return {
    pos: new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]),
    idx: new Uint32Array([0, 1, 2, 3, 4, 5]),
  };
}

function merge(parts) {
  const out = new Map();
  for (const p of parts) {
    if (!out.has(p.mat)) out.set(p.mat, { pos: [], idx: [] });
    const o = out.get(p.mat);
    const base = o.pos.length / 3;
    for (let i = 0; i < p.pos.length; i++) o.pos.push(p.pos[i]);
    for (let i = 0; i < p.idx.length; i++) o.idx.push(p.idx[i] + base);
  }
  return [...out.entries()].map(([mat, o]) => ({ mat, pos: new Float32Array(o.pos), idx: new Uint32Array(o.idx) }));
}

export function buildCarParts() {
  const parts = [];
  const P = (mat, geo) => parts.push({ mat, ...geo });

  // ---- lower body: a lofted shell that tapers and rounds at both ends ----
  const bodySections = [
    { z: -1.99, hw: 0.62, yb: 0.40, yt: 0.74, r: 0.1 },
    { z: -1.86, hw: 0.80, yb: 0.34, yt: 0.86, r: 0.14 },
    { z: -1.55, hw: 0.88, yb: 0.29, yt: 0.94, r: 0.16 },
    { z: -1.05, hw: 0.905, yb: 0.27, yt: 0.985, r: 0.16 },
    { z: -0.35, hw: 0.91, yb: 0.26, yt: 1.0, r: 0.16 },
    { z: 0.35, hw: 0.905, yb: 0.26, yt: 0.985, r: 0.16 },
    { z: 0.95, hw: 0.88, yb: 0.28, yt: 0.945, r: 0.16 },
    { z: 1.45, hw: 0.855, yb: 0.31, yt: 0.9, r: 0.15 },
    { z: 1.82, hw: 0.78, yb: 0.35, yt: 0.84, r: 0.13 },
    { z: 1.99, hw: 0.66, yb: 0.40, yt: 0.76, r: 0.1 },
  ].map((s) => ({ z: s.z, pts: rr(s.hw, s.yb, s.yt, s.r) }));
  P('paint', loftSections(bodySections));

  // ---- cabin / greenhouse (narrower, raked front and rear) ----
  const cabinSections = [
    { z: -1.5, hw: 0.55, yb: 0.9, yt: 0.95, r: 0.05 },
    { z: -1.28, hw: 0.68, yb: 0.9, yt: 1.16, r: 0.08 },
    { z: -0.95, hw: 0.73, yb: 0.9, yt: 1.32, r: 0.1 },
    { z: -0.35, hw: 0.745, yb: 0.9, yt: 1.36, r: 0.1 },
    { z: 0.25, hw: 0.735, yb: 0.9, yt: 1.355, r: 0.1 },
    { z: 0.62, hw: 0.7, yb: 0.9, yt: 1.3, r: 0.09 },
    { z: 0.95, hw: 0.64, yb: 0.9, yt: 1.1, r: 0.07 },
    { z: 1.12, hw: 0.55, yb: 0.9, yt: 0.98, r: 0.05 },
  ].map((s) => ({ z: s.z, pts: rr(s.hw, s.yb, s.yt, s.r, 2) }));
  P('paint', loftSections(cabinSections));

  // ---- glass: quads laid on the cabin's front/rear slopes, plus side windows ----
  P('glass', quadGeo([-0.6, 1.312, 0.637], [0.6, 1.312, 0.637], [0.52, 0.992, 1.137], [-0.52, 0.992, 1.137])); // windscreen
  P('glass', quadGeo([-0.7, 1.331, -0.967], [0.7, 1.331, -0.967], [0.55, 0.961, -1.517], [-0.55, 0.961, -1.517])); // rear screen
  for (const sx of [-1, 1]) {
    P('glass', boxGeo(sx * 0.744, 1.15, 0.2, 0.02, 0.3, 0.62));
    P('glass', boxGeo(sx * 0.744, 1.15, -0.55, 0.02, 0.28, 0.55));
    P('paint', boxGeo(sx * 0.75, 1.15, -0.18, 0.03, 0.3, 0.08)); // B pillar
  }

  // ---- bumpers, skirts, splitter, diffuser ----
  P('dark', boxGeo(0, 0.44, 1.97, 1.5, 0.24, 0.16));
  P('dark', boxGeo(0, 0.4, -1.99, 1.4, 0.26, 0.14));
  P('dark', boxGeo(0, 0.24, 1.93, 1.66, 0.05, 0.32)); // splitter
  P('dark', boxGeo(0, 0.3, -1.95, 1.3, 0.16, 0.2)); // diffuser
  for (const sx of [-1, 1]) P('dark', boxGeo(sx * 0.9, 0.32, 0, 0.09, 0.14, 2.5));
  // wheel arch flares
  for (const [sx, sz] of [[1, 1.31], [-1, 1.31], [1, -1.31], [-1, -1.31]]) {
    P('dark', boxGeo(sx * 0.9, 0.66, sz, 0.1, 0.2, 0.98));
  }

  // ---- rear wing ----
  P('paint', boxGeo(0, 1.46, -1.7, 1.44, 0.06, 0.34));
  for (const sx of [-1, 1]) P('dark', boxGeo(sx * 0.67, 1.14, -1.7, 0.06, 0.64, 0.32));
  P('dark', boxGeo(0, 1.3, -1.8, 0.94, 0.03, 0.1));

  // ---- mirrors ----
  for (const sx of [-1, 1]) {
    P('dark', boxGeo(sx * 0.845, 1.12, 0.62, 0.14, 0.03, 0.04)); // stalk
    P('dark', boxGeo(sx * 0.92, 1.13, 0.62, 0.03, 0.12, 0.16));   // housing
    P('glass', boxGeo(sx * 0.905, 1.13, 0.62, 0.006, 0.10, 0.14)); // mirror glass
  }

  // ---- lights ----
  for (const sx of [-1, 1]) {
    P('lightF', boxGeo(sx * 0.52, 0.7, 1.985, 0.36, 0.13, 0.05, [0, 0, sx * 0.06]));
    P('lightR', boxGeo(sx * 0.58, 0.78, -1.995, 0.3, 0.1, 0.04));
  }
  // grille, hood vent, front lip
  P('dark', boxGeo(0, 0.62, 1.995, 0.86, 0.16, 0.05));
  P('dark', boxGeo(0, 0.9, 1.74, 0.5, 0.025, 0.24));
  P('dark', boxGeo(0, 0.44, 2.01, 1.3, 0.06, 0.1));

  // rally light pod: round housings on a slim bar, with lenses and brackets
  P('dark', boxGeo(0, 0.885, 1.52, 1.30, 0.03, 0.05));
  for (const sx of [-0.48, -0.16, 0.16, 0.48]) {
    P('dark', boxGeo(sx, 0.915, 1.55, 0.04, 0.05, 0.07));       // bracket
    P('dark', cylZ(sx, 0.94, 1.56, 0.058, 0.10, 12));           // housing
    P('rim', cylZ(sx, 0.94, 1.615, 0.06, 0.01, 12));            // bezel
    P('lightF', cylZ(sx, 0.94, 1.622, 0.048, 0.012, 12));       // lens
  }
  // bonnet pins
  for (const sx of [-0.52, 0.52]) P('rim', cylZ(sx, 0.925, 1.78, 0.022, 0.03, 8));

  // roof scoop + antenna-ish details
  P('dark', boxGeo(0, 1.385, 0.02, 0.26, 0.06, 0.34));
  // exhaust
  P('dark', boxGeo(0.5, 0.33, -2.0, 0.12, 0.1, 0.08));

  return merge(parts);
}

// wheels are built separately (they pivot/steer), but the geometry lives here too
export function buildWheelParts() {
  const parts = [];
  const seg = 20;
  const R = 0.345;
  const W = 0.26;
  // tyre: a cylinder made of quads with a slight shoulder radius
  const pos = [];
  const idx = [];
  const ring = (r, z) => {
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * r, Math.sin(a) * r, z);
    }
  };
  // three rings: outer shoulder left, tread, outer shoulder right
  ring(R * 0.86, -W / 2);
  ring(R, -W / 2 + 0.05);
  ring(R, W / 2 - 0.05);
  ring(R * 0.86, W / 2);
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < seg; i++) {
      const a = s * seg + i;
      const b = s * seg + ((i + 1) % seg);
      const c = (s + 1) * seg + i;
      const d = (s + 1) * seg + ((i + 1) % seg);
      idx.push(a, b, c, b, d, c);
    }
  }
  // sidewalls close the tyre between the shoulder and the rim
  const sideStart = pos.length / 3;

  // rim faces
  const rimStart = pos.length / 3;
  for (const z of [-W / 2 + 0.03, W / 2 - 0.03]) {
    ring(R * 0.62, z);
  }
  for (let i = 0; i < seg; i++) {
    const a = rimStart + i;
    const b = rimStart + ((i + 1) % seg);
    const c = rimStart + seg + i;
    const d = rimStart + seg + ((i + 1) % seg);
    idx.push(a, c, b, b, c, d);
  }
  // close the sidewalls: shoulder ring -> rim ring, both sides
  {
    const rimL = rimStart;
    const rimR = rimStart + seg;
    for (let i = 0; i < seg; i++) {
      const a0 = i, b0 = (i + 1) % seg;
      const c0 = rimL + i, d0 = rimL + ((i + 1) % seg);
      idx.push(a0, c0, b0, b0, c0, d0);
      const a1 = 3 * seg + i, b1 = 3 * seg + ((i + 1) % seg);
      const c1 = rimR + i, d1 = rimR + ((i + 1) % seg);
      idx.push(a1, b1, c1, b1, d1, c1);
    }
  }
  parts.push({ mat: 'tyre', pos: new Float32Array(pos), idx: new Uint32Array(idx) });

  // spokes + hub + brake disc
  const addParts = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const geo = boxGeo(0, 0.1, 0, 0.045, 0.26, 0.05, [0, 0, a]);
    // rotate about X so the spokes lie in the wheel plane (Y/Z)
    addParts.push({ mat: 'rim', ...geo });
  }
  addParts.push({ mat: 'rim', ...boxGeo(0, 0, 0, 0.06, 0.12, 0.12) });
  addParts.push({ mat: 'brake', ...boxGeo(0, 0, 0, 0.26, 0.26, 0.03) });
  return { tyre: parts, details: merge(addParts) };
}
