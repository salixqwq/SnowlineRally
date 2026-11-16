// track.js — procedural rally stage: pace-note plan -> curvature -> spline -> terrain.
// Pure data + math; no three.js and no DOM, so the whole stage can be tested in node.
import { clamp, lerp, smoothstep, mulberry32, TAU } from './math.js';
import { fbm2, ridge2, setNoiseSeed } from './noise.js';

const SAMPLE_DS = 4; // metres between road samples
const GRID_CELL = 26; // spatial hash cell size for road queries

export const THEMES = {
  snow: {
    key: 'snow',
    name: '雪线',
    sub: 'SS1 · 北境林道',
    sky: [0.52, 0.62, 0.74],
    horizon: [0.86, 0.88, 0.92],
    sun: [1.0, 0.93, 0.8],
    sunIntensity: 2.0,
    ambient: 0.55,
    fogColor: [0.74, 0.79, 0.86],
    fogNear: 90,
    fogFar: 620,
    sunDir: [0.55, 0.62, -0.4],
    snow: 1,
    snowFall: 0.55,
    ground: [0.9, 0.92, 0.96],
    groundDark: [0.62, 0.66, 0.72],
    rock: [0.32, 0.33, 0.37],
    road: [0.72, 0.72, 0.73],
    rut: [0.5, 0.5, 0.52],
    tree: [0.16, 0.26, 0.2],
    treeSnow: [0.82, 0.86, 0.9],
    pole: [0.85, 0.2, 0.12],
  },
  dusk: {
    key: 'dusk',
    name: '黄昏湾',
    sub: 'SS2 · 暮色隘口',
    sky: [0.22, 0.2, 0.32],
    horizon: [0.95, 0.56, 0.36],
    sun: [1.0, 0.72, 0.46],
    sunIntensity: 2.6,
    ambient: 0.4,
    fogColor: [0.5, 0.42, 0.44],
    fogNear: 70,
    fogFar: 520,
    sunDir: [0.82, 0.2, -0.25],
    snow: 0.35,
    snowFall: 0.15,
    ground: [0.78, 0.72, 0.68],
    groundDark: [0.45, 0.4, 0.38],
    rock: [0.3, 0.27, 0.27],
    road: [0.55, 0.5, 0.47],
    rut: [0.36, 0.33, 0.31],
    tree: [0.18, 0.22, 0.18],
    treeSnow: [0.55, 0.53, 0.52],
    pole: [0.9, 0.75, 0.25],
  },
  mist: {
    key: 'mist',
    name: '雾谷',
    sub: 'SS3 · 高地雾道',
    sky: [0.5, 0.55, 0.56],
    horizon: [0.76, 0.79, 0.8],
    sun: [0.95, 0.97, 1.0],
    sunIntensity: 1.2,
    ambient: 0.7,
    fogColor: [0.72, 0.75, 0.77],
    fogNear: 25,
    fogFar: 260,
    sunDir: [0.32, 0.72, -0.45],
    snow: 0.12,
    snowFall: 0,
    ground: [0.42, 0.47, 0.38],
    groundDark: [0.26, 0.3, 0.24],
    rock: [0.34, 0.35, 0.33],
    road: [0.47, 0.44, 0.4],
    rut: [0.3, 0.28, 0.26],
    tree: [0.14, 0.22, 0.16],
    treeSnow: [0.5, 0.54, 0.5],
    pole: [0.9, 0.9, 0.85],
  },
};

export const STAGES = [
  { seed: 20261115, theme: 'snow', length: 3450 },
  { seed: 771203, theme: 'dusk', length: 3350 },
  { seed: 4451991, theme: 'mist', length: 3600 },
];

// compose the corner plan: [type, length, radius, dir]
function buildPlan(rnd, targetLength) {
  const corners = [];
  const sevs = [
    { r: 140, w: 22 }, // fast
    { r: 105, w: 20 },
    { r: 82, w: 18 },
    { r: 62, w: 16 },
    { r: 46, w: 14 },
    { r: 34, w: 11 },
    { r: 24, w: 8 },
    { r: 15, w: 5 },
    { r: 9, w: 3 }, // hairpin
  ];
  const totalW = sevs.reduce((a, s) => a + s.w, 0);
  const pickSev = () => {
    let t = rnd() * totalW;
    for (const s of sevs) {
      t -= s.w;
      if (t <= 0) return s.r;
    }
    return 80;
  };

  let len = 0;
  let dir = rnd() < 0.5 ? 1 : -1;
  let sameRun = 0;
  len += 140; // opening straight
  while (len < targetLength - 260) {
    // straight
    const straight = 55 + rnd() * 120 + (rnd() < 0.12 ? 140 * rnd() : 0);
    len += straight;

    // one or two corners, sometimes a linked S
    const count = rnd() < 0.28 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const radius = pickSev();
      const tight = radius < 30;
      // sweep angle: tight corners are longer in angle
      const sweep = tight ? (70 + rnd() * 90) * (Math.PI / 180) : (35 + rnd() * 85) * (Math.PI / 180);
      const cLen = Math.max(14, radius * sweep);
      // direction: fresh corners tend to alternate, hairpins toss a coin
      if (sameRun >= 2) dir = -dir;
      else if (rnd() < (radius < 20 ? 0.5 : 0.62)) dir = -dir;
      sameRun = radius < 30 ? 0 : sameRun + 1;
      corners.push({ s0: len, s1: len + cLen, radius, dir, sweep });
      len += cLen;
      if (i < count - 1) len += 16 + rnd() * 22; // short link inside an S
    }
  }
  return { corners, total: len };
}

function buildCurvature(plan, total) {
  const n = Math.ceil(total) + 8;
  const k = new Float32Array(n);
  for (const c of plan.corners) {
    const ramp = Math.min(12, (c.s1 - c.s0) * 0.34);
    const peak = c.dir / c.radius;
    const i0 = Math.max(0, Math.floor(c.s0));
    const i1 = Math.min(n - 1, Math.ceil(c.s1));
    for (let i = i0; i <= i1; i++) {
      const s = i;
      const w = smoothstep(0, ramp, s - c.s0) * smoothstep(0, ramp, c.s1 - s);
      k[i] += peak * w;
    }
  }
  return k;
}

function buildElevation(total, rnd) {
  const n = Math.ceil(total) + 8;
  const y = new Float32Array(n);
  const p1 = rnd() * TAU;
  const p2 = rnd() * TAU;
  const p3 = rnd() * TAU;
  const base = 42;
  for (let i = 0; i < n; i++) {
    const s = i;
    y[i] = base + 11 * Math.sin(s * 0.0031 + p1) + 6 * Math.sin(s * 0.0077 + p2) + 3 * Math.sin(s * 0.016 + p3);
  }
  // flatten the start and finish so the car does not spawn on a crest
  const y0 = y[0];
  const yN = y[n - 1];
  for (let i = 0; i < n; i++) {
    const s = i;
    if (s < 60) y[i] = lerp(y0, y[i], smoothstep(0, 60, s));
    const tail = n - 1 - i;
    if (tail < 90) y[i] = lerp(yN, y[i], smoothstep(0, 90, tail));
  }
  return y;
}

export function buildStage(opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const seed = opts.seed || 1;
  const themeKey = opts.theme || 'snow';
  const theme = THEMES[themeKey] || THEMES.snow;
  const targetLength = opts.length || 3400;

  setNoiseSeed(seed);
  const rnd = mulberry32(seed ^ 0x9e3779b9);

  const plan = buildPlan(rnd, targetLength);
  const total = plan.total + 190;
  const kArr = buildCurvature(plan, total);
  const yArr = buildElevation(total, rnd);

  // integrate heading and position at 1 m resolution
  const n1 = Math.ceil(total) + 2;
  const yawArr = new Float32Array(n1);
  const xArr = new Float32Array(n1);
  const zArr = new Float32Array(n1);
  let yaw = 0;
  let x = 0;
  let z = 0;
  for (let i = 0; i < n1; i++) {
    yawArr[i] = yaw;
    xArr[i] = x;
    zArr[i] = z;
    const k = kArr[i];
    const mid = yaw + k * 0.5;
    x += Math.sin(mid);
    z += Math.cos(mid);
    yaw += k;
  }

  // decimated samples every SAMPLE_DS metres
  const samples = [];
  let acc = 0;
  for (let i = 0; i < n1; i += SAMPLE_DS) {
    samples.push({
      i: samples.length,
      s: i,
      x: xArr[i],
      y: yArr[i],
      z: zArr[i],
      yaw: yawArr[i],
      k: kArr[i],
    });
  }
  // tangents + right vectors + smoothed curvature (from finite difference of yaw)
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const sm = samples[i];
    sm.tx = dx / l;
    sm.tz = dz / l;
    sm.rx = sm.tz; // right = (tz, 0, -tx)
    sm.rz = -sm.tx;
    const j0 = Math.max(0, i - 2);
    const j1 = Math.min(samples.length - 1, i + 2);
    const ds = (j1 - j0) * SAMPLE_DS;
    sm.ks = ds > 0 ? (samples[j1].yaw - samples[j0].yaw) / ds : 0;
    sm.radius = Math.abs(sm.ks) > 1e-4 ? 1 / Math.abs(sm.ks) : 9999;
  }

  // spatial hash of road samples for nearest-point queries
  const grid = new Map();
  const cellKey = (cx, cz) => `${cx},${cz}`; // string key: the old 32-bit xor collided across the map
  for (let i = 0; i < samples.length; i++) {
    const cx = Math.floor(samples[i].x / GRID_CELL);
    const cz = Math.floor(samples[i].z / GRID_CELL);
    const key = cellKey(cx, cz);
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push(i);
  }

  function nearestSample(x, z) {
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= 4; ring++) {
      for (let ix = cx - ring; ix <= cx + ring; ix++) {
        for (let iz = cz - ring; iz <= cz + ring; iz++) {
          if (ring > 0 && ix > cx - ring && ix < cx + ring && iz > cz - ring && iz < cz + ring) continue;
          const bucket = grid.get(cellKey(ix, iz));
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const s = samples[bucket[bi]];
            const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
            if (d < bestD) {
              bestD = d;
              best = bucket[bi];
            }
          }
        }
      }
      // only stop once the best hit is provably closer than anything outside this ring
      if (best >= 0 && bestD <= (ring * GRID_CELL) * (ring * GRID_CELL)) break;
    }
    return best;
  }

  // exact distance to the road polyline, plus the arc length of the closest point
  function roadInfo(x, z) {
    const idx = nearestSample(x, z);
    if (idx < 0) return { dist: 1e6, s: 0, y: 0, idx: -1 };
    let bestD = Infinity;
    let bestS = 0;
    let bestY = 0;
    for (let j = idx - 1; j <= idx + 1; j++) {
      if (j < 0 || j >= samples.length - 1) continue;
      const a = samples[j];
      const b = samples[j + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1;
      let t = ((x - a.x) * abx + (z - a.z) * abz) / len2;
      t = clamp(t, 0, 1);
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < bestD) {
        bestD = d;
        bestS = a.s + (b.s - a.s) * t;
        bestY = lerp(a.y, b.y, t);
      }
    }
    return { dist: Math.sqrt(bestD), s: bestS, y: bestY, idx };
  }

  function mountainHeight(x, z) {
    return 24 + 52 * ridge2(x * 0.0008, z * 0.0008, 4) + 11 * fbm2(x * 0.004, z * 0.004, 3);
  }

  // inverse-distance weighted road field: keeps the terrain continuous where the
  // nearest-sample switch would otherwise snap between two legs of a hairpin
  function nearField(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const R = 70; // sample influence radius; heightAt blends to the mountains by then
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    const cand = [];
    // scan the full 3-ring neighbourhood (out to ~78 m) instead of stopping at the
    // first ring that has enough samples: at a hairpin that broke the terrain into two
    for (let ring = 0; ring <= 3; ring++) {
      for (let ix = cx - ring; ix <= cx + ring; ix++) {
        for (let iz = cz - ring; iz <= cz + ring; iz++) {
          if (ring > 0 && ix > cx - ring && ix < cx + ring && iz > cz - ring && iz < cz + ring) continue;
          const bucket = grid.get(cellKey(ix, iz));
          if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const sm = samples[bucket[bi]];
            const dx = sm.x - x;
            const dz = sm.z - z;
            cand.push({ d2: dx * dx + dz * dz, i: bucket[bi] });
          }
        }
      }
    }
    if (!cand.length) return null;
    cand.sort((a, b) => a.d2 - b.d2);
    let wsum = 0;
    let ys = 0;
    let ss = 0;
    let sides = 0;
    const n = Math.min(220, cand.length);
    for (let j = 0; j < n; j++) {
      const c = cand[j];
      const sm = samples[c.i];
      // 1/d^2 over every nearby sample: near both legs of a hairpin the average is
      // continuous instead of snapping to whichever leg happens to be nearer
      const dist = Math.sqrt(c.d2);
      const falloff = 1 - smoothstep(R * 0.55, R, dist);
      if (falloff <= 0) continue;
      const dd = dist + 1;
      const w = falloff / (dd * dd);
      const side = (x - sm.x) * sm.rx + (z - sm.z) * sm.rz > 0 ? 1 : -1;
      wsum += w;
      ys += sm.y * w;
      ss += sm.s * w;
      sides += side * w;
    }
    if (!(wsum > 1e-9)) return null;
    return { y: ys / wsum, s: ss / wsum, side: sides / wsum, d: Math.sqrt(cand[0].d2) };
  }

  function heightAt(x, z) {
    const nf = nearField(x, z);
    if (!nf) return mountainHeight(x, z);
    // use the distance to the nearest sample (continuous) rather than the
    // segment distance, which can jump when the nearest segment changes
    const d = nf.d;
    const t = smoothstep(10, 85, d);
    const wall = 12 + 7 * fbm2(nf.s * 0.0042, nf.side * 3.1, 3);
    // side is continuous in [-1,1]: uphill cut on one side, valley on the other
    const sideFactor = 0.32 + 0.73 * (nf.side * 0.5 + 0.5);
    const rise = t * t * wall * sideFactor;
    const bumps = fbm2(x * 0.021, z * 0.021, 3) * 3.1 * smoothstep(9, 20, d);
    const drift = fbm2(x * 0.006, z * 0.006, 2) * 4.4 * smoothstep(10, 34, d);
    const near = nf.y + rise + bumps + drift;
    const far = mountainHeight(x, z);
    // the near field fades to zero by R=70 m, so this blend cannot show a seam.
    // the far field is capped relative to the road so the valley wall stays drivable
    const farCapped = Math.min(far, near + 10);
    return lerp(near, farCapped, smoothstep(42, 70, d));
  }

  // ---- pace notes from curvature ----
  const raw = [];
  let cur = null;
  for (let i = 1; i < samples.length - 1; i++) {
    const s = samples[i];
    const tight = s.radius < 165 && Math.abs(s.ks) > 0.0045;
    if (tight) {
      if (!cur) cur = { s0: s.s, s1: s.s, r: s.radius, dir: Math.sign(s.ks) };
      else {
        cur.s1 = s.s;
        cur.r = Math.min(cur.r, s.radius);
        // keep the dominant direction
        cur.dir = Math.sign(s.ks);
      }
    } else if (cur) {
      if (cur.s1 - cur.s0 > 6) raw.push(cur);
      cur = null;
    }
  }
  if (cur) raw.push(cur);

  const notes = [];
  for (const r of raw) {
    const radius = r.r;
    const sev = radius >= 150 ? 6 : radius >= 110 ? 5 : radius >= 80 ? 4 : radius >= 55 ? 3 : radius >= 36 ? 2 : radius >= 22 ? 1 : 0;
    const last = notes[notes.length - 1];
    if (last && r.s0 - last.s1 < 22 && last.dir === r.dir) {
      last.s1 = r.s1;
      last.r = Math.min(last.r, radius);
      last.sev = Math.min(last.sev, sev);
      continue;
    }
    notes.push({ s0: r.s0, s1: r.s1, dir: r.dir, radius, sev });
  }
  // simplify: drop notes smashed into the previous one
  const clean = [];
  for (const nt of notes) {
    const prev = clean[clean.length - 1];
    if (prev && nt.s0 - prev.s1 < 12) {
      if (nt.radius < prev.radius) {
        prev.s1 = Math.max(prev.s1, nt.s1);
        prev.radius = nt.radius;
        prev.sev = Math.min(prev.sev, nt.sev);
        prev.dir = nt.dir;
      } else prev.s1 = Math.max(prev.s1, nt.s1);
    } else clean.push({ ...nt });
  }

  const finishIdx = samples.length - 1;
  const fin = samples[finishIdx];

  // ---- props ----
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const s of samples) {
    b.minX = Math.min(b.minX, s.x);
    b.maxX = Math.max(b.maxX, s.x);
    b.minZ = Math.min(b.minZ, s.z);
    b.maxZ = Math.max(b.maxZ, s.z);
  }
  // remember the road-only bounds (used by the minimap) before expanding the terrain
  const roadBounds = { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  const margin = 480;
  b.minX -= margin;
  b.maxX += margin;
  b.minZ -= margin;
  b.maxZ += margin;

  const trees = [];
  const rocks = [];
  const prnd = mulberry32(seed ^ 0x51ed270b);
  const area = (b.maxX - b.minX) * (b.maxZ - b.minZ);
  const treeTarget = Math.round(clamp(area / 900, 900, 2600) * (theme.key === 'mist' ? 1.15 : 0.9));
  let guard = 0;
  while (trees.length < treeTarget && guard++ < treeTarget * 40) {
    const x = lerp(b.minX + 40, b.maxX - 40, prnd());
    const z = lerp(b.minZ + 40, b.maxZ - 40, prnd());
    const ri = roadInfo(x, z);
    if (ri.dist < 11.5) continue;
    const h = heightAt(x, z);
    // slope test
    const e = 1.6;
    const hx = heightAt(x + e, z) - heightAt(x - e, z);
    const hz = heightAt(x, z + e) - heightAt(x, z - e);
    const slope = Math.hypot(hx, hz) / (2 * e);
    if (slope > 0.62) continue;
    if (h > 110) continue;
    const scale = 0.75 + prnd() * 0.85;
    trees.push({ x, y: h, z, scale, rot: prnd() * TAU, kind: prnd() < 0.18 ? 1 : 0 });
  }
  guard = 0;
  while (rocks.length < 460 && guard++ < 20000) {
    const x = lerp(b.minX + 40, b.maxX - 40, prnd());
    const z = lerp(b.minZ + 40, b.maxZ - 40, prnd());
    const ri = roadInfo(x, z);
    if (ri.dist < 9) continue;
    const h = heightAt(x, z);
    const e = 1.6;
    const slope = Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    rocks.push({ x, y: h, z, scale: 0.5 + prnd() * 1.7, rot: prnd() * TAU, slope });
  }

  // forest corridor: extra trees hugging the road so the stage reads as a forest
  const corridorTarget = 900;
  let corridor = 0;
  for (let s = 30; s < samples.length * SAMPLE_DS - 60 && corridor < corridorTarget; s += 5) {
    const i = Math.min(samples.length - 1, Math.round(s / SAMPLE_DS));
    const sm = samples[i];
    for (const side of [-1, 1]) {
      if (prnd() > 0.62) continue;
      const off = 12 + prnd() * 62;
      const x = sm.x + sm.rx * off * side + (prnd() - 0.5) * 9;
      const z = sm.z + sm.rz * off * side + (prnd() - 0.5) * 9;
      const ri2 = roadInfo(x, z);
      if (ri2.dist < 10.5) continue;
      const h = heightAt(x, z);
      const e2 = 1.6;
      const sl = Math.hypot(heightAt(x + e2, z) - heightAt(x - e2, z), heightAt(x, z + e2) - heightAt(x, z - e2)) / (2 * e2);
      if (sl > 0.72) continue;
      trees.push({ x, y: h, z, scale: 0.8 + prnd() * 0.95, rot: prnd() * TAU, kind: prnd() < 0.2 ? 1 : 0 });
      corridor++;
    }
  }

  // snow poles along both edges, every 24 m
  const poles = [];
  for (let s = 30; s < samples.length * SAMPLE_DS - 30; s += 24) {
    const i = Math.min(samples.length - 1, Math.round(s / SAMPLE_DS));
    const sm = samples[i];
    for (const side of [-1, 1]) {
      const off = 6.4;
      const px = sm.x + sm.rx * off * side;
      const pz = sm.z + sm.rz * off * side;
      poles.push({ x: px, y: sm.y, z: pz, rot: sm.yaw });
    }
  }

  // timing splits every 400 m
  const splits = [];
  for (let s = 400; s < samples.length * SAMPLE_DS; s += 400) splits.push(s);

  const stage = {
    seed,
    theme,
    name: theme.name,
    totalLength: (samples.length - 1) * SAMPLE_DS,
    samples,
    notes: clean,
    splits,
    trees,
    rocks,
    poles,
    bbox: b,
    roadBounds,
    start: { x: samples[0].x, y: samples[0].y, z: samples[0].z, yaw: samples[0].yaw },
    finish: { x: fin.x, y: fin.y, z: fin.z, yaw: fin.yaw },
    heightAt,
    roadInfo,
    genMs: 0,
  };
  stage.props = makePropIndex(trees, rocks);
  stage.genMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return stage;
}

// coarse spatial index of solid obstacles for cheap car collisions
export function makePropIndex(trees, rocks, cell = 8) {
  const map = new Map();
  const key = (cx, cz) => cx * 374761393 + cz * 668265263;
  const add = (p, r) => {
    const cx = Math.floor(p.x / cell);
    const cz = Math.floor(p.z / cell);
    const k = key(cx, cz);
    let bucket = map.get(k);
    if (!bucket) map.set(k, (bucket = []));
    bucket.push({ x: p.x, z: p.z, r });
  };
  for (const t of trees) add(t, 0.45 * t.scale + 0.35);
  for (const r of rocks) if (r.scale > 0.8) add(r, 0.55 * r.scale);

  return {
    query(x, z, carRadius) {
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      let best = null;
      let bestD = Infinity;
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
          const bucket = map.get(key(ix, iz));
          if (!bucket) continue;
          for (const p of bucket) {
            const dx = p.x - x;
            const dz = p.z - z;
            const d = dx * dx + dz * dz;
            const min = carRadius + p.r;
            if (d < min * min && d < bestD) {
              bestD = d;
              best = p;
            }
          }
        }
      }
      return best;
    },
  };
}

export function noteLabel(n) {
  if (!n) return '—';
  // curvature > 0 increases yaw, which turns toward +X = the car's LEFT
  const dir = n.dir > 0 ? 'L' : 'R';
  if (n.sev === 0) return `${dir} 发卡弯`;
  return `${dir}${n.sev}`;
}
