// tools/preview.mjs — offline CPU preview of the same world data, to sanity-check composition
// without a browser. Not part of the game build; it shares track.js only.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildStage, STAGES } from '../src/track.js';

const W = 720, H = 405;
const theme = null;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const stage = buildStage(STAGES[0]);
const b = stage.bbox;

// ---- camera ----
function lookAt(eye, target, upv = { x: 0, y: 1, z: 0 }) {
  const f = norm(sub(target, eye));
  const r = norm(cross(f, upv));
  const u = cross(r, f);
  return { eye, f, r, u };
}
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const lerp = (a, b, t) => a + (b - a) * t;

const sun = norm({ x: 0.62, y: 0.52, z: -0.42 });
const fogC = [0.74, 0.79, 0.86];
const fogNear = 90, fogFar = 620;

function renderCamera(idx, back, height, out) {
  const S = stage.samples;
  const sm = S[Math.min(S.length - 1, idx)];
  const fwd = { x: Math.sin(sm.yaw), y: 0, z: Math.cos(sm.yaw) };
  const eye = { x: sm.x - fwd.x * back, y: sm.y + height, z: sm.z - fwd.z * back };
  const target = { x: sm.x + fwd.x * 8, y: sm.y + 1.2, z: sm.z + fwd.z * 8 };
  const cam = lookAt(eye, target);

  const focal = H / 2 / Math.tan((62 * Math.PI) / 360);
  const aspect = W / H;
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const img = new Float32Array(W * H * 3);

  // sky
  const zenith = [0.52, 0.62, 0.74], horizon = [0.86, 0.88, 0.92];
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const ndx = ((px + 0.5) / W * 2 - 1) * aspect * Math.tan((62 * Math.PI) / 360);
      const ndy = (1 - (py + 0.5) / H * 2) * Math.tan((62 * Math.PI) / 360);
      const dir = norm(add(cam.f, add(mul(cam.r, ndx), mul(cam.u, ndy))));
      const t = Math.min(1, Math.max(0, dir.y * 1.35 + 0.02));
      const sd = Math.max(0, dot(dir, sun));
      const glow = Math.pow(sd, 220) * 2.2 + Math.pow(sd, 8) * 0.2;
      const i = (py * W + px) * 3;
      img[i] = lerp(horizon[0], zenith[0], t) + glow * 1.0;
      img[i + 1] = lerp(horizon[1], zenith[1], t) + glow * 0.9;
      img[i + 2] = lerp(horizon[2], zenith[2], t) + glow * 0.75;
    }
  }

  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz, col, shade = 1) => {
    // view space
    const toView = (p) => ({ x: dot(sub(p, cam.eye), cam.r), y: dot(sub(p, cam.eye), cam.u), z: dot(sub(p, cam.eye), cam.f) });
    const A = toView({ x: ax, y: ay, z: az });
    const B = toView({ x: bx, y: by, z: bz });
    const C = toView({ x: cx, y: cy, z: cz });
    if (A.z < 0.4 || B.z < 0.4 || C.z < 0.4) return;
    const proj = (p) => ({ x: W / 2 + (p.x / p.z) * focal, y: H / 2 - (p.y / p.z) * focal, w: p.z });
    const a = proj(A), b2 = proj(B), c = proj(C);
    const minx = Math.max(0, Math.floor(Math.min(a.x, b2.x, c.x)));
    const maxx = Math.min(W - 1, Math.ceil(Math.max(a.x, b2.x, c.x)));
    const miny = Math.max(0, Math.floor(Math.min(a.y, b2.y, c.y)));
    const maxy = Math.min(H - 1, Math.ceil(Math.max(a.y, b2.y, c.y)));
    if (minx > maxx || miny > maxy) return;
    const area = (b2.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b2.y - a.y);
    if (Math.abs(area) < 1e-6) return;
    // fog tint
    const wAvg = (a.w + b2.w + c.w) / 3;
    const fog = Math.min(1, Math.max(0, (wAvg - fogNear) / (fogFar - fogNear)));
    const col2 = col.map((v) => v * shade);
    const r = lerp(col2[0], fogC[0], fog), g = lerp(col2[1], fogC[1], fog), bl = lerp(col2[2], fogC[2], fog);
    for (let py = miny; py <= maxy; py++) {
      for (let px = minx; px <= maxx; px++) {
        const px2 = px + 0.5, py2 = py + 0.5;
        const wa = ((b2.x - px2) * (c.y - py2) - (c.x - px2) * (b2.y - py2)) / area;
        const wb = ((c.x - px2) * (a.y - py2) - (a.x - px2) * (c.y - py2)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const invw = wa / a.w + wb / b2.w + wc / c.w;
        const z = 1 / invw;
        const pi = py * W + px;
        if (z >= zbuf[pi]) continue;
        zbuf[pi] = z;
        const i3 = pi * 3;
        img[i3] = r; img[i3 + 1] = g; img[i3 + 2] = bl;
      }
    }
  };

  // terrain (same grid as the renderer)
  const step = 9;
  const nx = Math.floor((b.maxX - b.minX) / step);
  const nz = Math.floor((b.maxZ - b.minZ) / step);
  const hs = new Float32Array((nx + 1) * (nz + 1));
  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      hs[iz * (nx + 1) + ix] = stage.heightAt(b.minX + ix * step, b.minZ + iz * step);
    }
  }
  const snow = [0.92, 0.94, 0.97], rock = [0.36, 0.37, 0.41];
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x0 = b.minX + ix * step, x1 = x0 + step;
      const z0 = b.minZ + iz * step, z1 = z0 + step;
      const h00 = hs[iz * (nx + 1) + ix], h10 = hs[iz * (nx + 1) + ix + 1];
      const h01 = hs[(iz + 1) * (nx + 1) + ix], h11 = hs[(iz + 1) * (nx + 1) + ix + 1];
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (Math.hypot(cx - eye.x, cz - eye.z) > 800) continue;
      const n = norm({ x: (h00 + h01 - h10 - h11) / 2, y: 2 * step, z: (h00 + h10 - h01 - h11) / 2 });
      const shade = 0.55 + 0.75 * Math.max(0, dot(n, sun));
      const rocky = n.y < 0.8 ? Math.min(1, (0.8 - n.y) / 0.25) : 0;
      const col = [lerp(snow[0], rock[0], rocky), lerp(snow[1], rock[1], rocky), lerp(snow[2], rock[2], rocky)];
      tri(x0, h00, z0, x0, h01, z1, x1, h10, z0, col, shade);
      tri(x1, h10, z0, x0, h01, z1, x1, h11, z1, col, shade);
    }
  }

  // road ribbon + banks
  const S2 = stage.samples;
  const roadCol = [0.72, 0.72, 0.73], bankCol = [0.95, 0.96, 0.99];
  for (let i = 0; i < S2.length - 1; i++) {
    const s0 = S2[i], s1 = S2[i + 1];
    if (Math.hypot(s0.x - eye.x, s0.z - eye.z) > 700) continue;
    const hw = 4.9;
    const p = (s, o) => ({ x: s.x + s.rx * o, y: s.y + 0.06, z: s.z + s.rz * o });
    const a0 = p(s0, -hw), a1 = p(s0, hw), b0 = p(s1, -hw), b1 = p(s1, hw);
    tri(a0.x, a0.y, a0.z, b0.x, b0.y, b0.z, a1.x, a1.y, a1.z, roadCol, 0.9);
    tri(a1.x, a1.y, a1.z, b0.x, b0.y, b0.z, b1.x, b1.y, b1.z, roadCol, 0.9);
    for (const side of [-1, 1]) {
      const o0 = 5.0 * side, o1 = 6.2 * side;
      const q0 = { x: s0.x + s0.rx * o0, y: s0.y + 0.02, z: s0.z + s0.rz * o0 };
      const q1 = { x: s0.x + s0.rx * o1, y: s0.y + 0.38, z: s0.z + s0.rz * o1 };
      const r0 = { x: s1.x + s1.rx * o0, y: s1.y + 0.02, z: s1.z + s1.rz * o0 };
      const r1 = { x: s1.x + s1.rx * o1, y: s1.y + 0.38, z: s1.z + s1.rz * o1 };
      tri(q0.x, q0.y, q0.z, r1.x, r1.y, r1.z, r0.x, r0.y, r0.z, bankCol, 0.95);
      tri(q0.x, q0.y, q0.z, q1.x, q1.y, q1.z, r1.x, r1.y, r1.z, bankCol, 0.95);
    }
  }

  // trees as low-poly cones
  const treeCol = [0.16, 0.26, 0.2];
  for (const t of stage.trees) {
    if (Math.hypot(t.x - eye.x, t.z - eye.z) > 500) continue;
    const r = 1.1 * t.scale, h = 4.2 * t.scale;
    const seg = 6;
    const shade = 0.5 + 0.7 * 0.7;
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      const x0 = t.x + Math.cos(a0) * r, z0 = t.z + Math.sin(a0) * r;
      const x1 = t.x + Math.cos(a1) * r, z1 = t.z + Math.sin(a1) * r;
      tri(x0, t.y, z0, x1, t.y, z1, t.x, t.y + h, t.z, treeCol, shade);
    }
  }

  // car placeholder box
  const carCol = [0.85, 0.31, 0.1];
  const cs = [
    [-0.9, 0, -1.95], [0.9, 0, -1.95], [0.9, 0, 1.95], [-0.9, 0, 1.95],
    [-0.9, 1.35, -1.95], [0.9, 1.35, -1.95], [0.9, 1.35, 1.95], [-0.9, 1.35, 1.95],
  ];
  const rot = (p) => {
    const c = Math.cos(sm.yaw), s = Math.sin(sm.yaw);
    return { x: sm.x + p[0] * c + p[2] * s, y: sm.y + p[1], z: sm.z - p[0] * s + p[2] * c };
  };
  const P = cs.map(rot);
  const quad = (i, j, k, l, sh) => {
    tri(P[i].x, P[i].y, P[i].z, P[j].x, P[j].y, P[j].z, P[k].x, P[k].y, P[k].z, carCol, sh);
    tri(P[i].x, P[i].y, P[i].z, P[k].x, P[k].y, P[k].z, P[l].x, P[l].y, P[l].z, carCol, sh);
  };
  quad(0, 1, 5, 4, 0.8); quad(1, 2, 6, 5, 0.7); quad(2, 3, 7, 6, 0.8); quad(3, 0, 4, 7, 0.9);
  tri(P[4].x, P[4].y, P[4].z, P[5].x, P[5].y, P[5].z, P[6].x, P[6].y, P[6].z, carCol, 1.0);
  tri(P[4].x, P[4].y, P[4].z, P[6].x, P[6].y, P[6].z, P[7].x, P[7].y, P[7].z, carCol, 1.0);

  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) {
    buf[i] = Math.max(0, Math.min(255, Math.round(Math.pow(img[i], 1 / 1.0) * 255)));
  }
  fs.writeFileSync(out, png(W, H, buf));
  console.log('wrote', out);
}

renderCamera(6, 7.2, 2.62, '/tmp/preview-start.png');
renderCamera(Math.floor(stage.samples.length * 0.45), 7.2, 2.62, '/tmp/preview-mid.png');
renderCamera(Math.floor(stage.samples.length * 0.19), 7.2, 2.62, '/tmp/preview-hairpin.png');
