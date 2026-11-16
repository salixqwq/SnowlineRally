// tools/preview-car.mjs — offline look at the car mesh from three angles (flat shaded).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildCarParts, buildWheelParts } from '../src/carmesh.js';

const W = 720, H = 420;

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
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const COL = {
  paint: [0.82, 0.2, 0.07],
  glass: [0.07, 0.1, 0.14],
  dark: [0.075, 0.075, 0.085],
  tyre: [0.05, 0.05, 0.055],
  rim: [0.62, 0.64, 0.68],
  brake: [0.22, 0.22, 0.24],
  lightF: [1.0, 0.95, 0.8],
  lightR: [0.9, 0.1, 0.05],
};

const car = buildCarParts();
const wheels = buildWheelParts();
const all = [];
for (const p of car) all.push(p);
for (const p of wheels.details) all.push(p);
for (const p of wheels.tyre) all.push(p);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function render(eye, target, out, wheelOffsets) {
  const f = norm(sub(target, eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const focal = H / 2 / Math.tan((32 * Math.PI) / 180);
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const img = new Float32Array(W * H * 3);
  // sky
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const t = py / H;
      const i = (py * W + px) * 3;
      img[i] = 0.72 + 0.16 * t; img[i + 1] = 0.78 + 0.14 * t; img[i + 2] = 0.84 + 0.1 * t;
    }
  }
  const sun = norm([0.5, 0.75, 0.4]);
  const tri = (p0, p1, p2, col) => {
    const v = [p0, p1, p2].map((p) => {
      const d = sub(p, eye);
      return { x: dot(d, r), y: dot(d, u), z: dot(d, f) };
    });
    if (v.some((q) => q.z < 0.2)) return;
    const pr = v.map((q) => ({ x: W / 2 + (q.x / q.z) * focal, y: H / 2 - (q.y / q.z) * focal, w: q.z }));
    const [a, b, c] = pr;
    const minx = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxx = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const miny = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxy = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    if (minx > maxx || miny > maxy) return;
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(area) < 1e-6) return;
    const n = norm(cross(sub(p1, p0), sub(p2, p0)));
    const lit = 0.28 + 0.95 * Math.max(0, dot(n, sun));
    for (let py = miny; py <= maxy; py++) {
      for (let px = minx; px <= maxx; px++) {
        const wa = ((b.x - px - 0.5) * (c.y - py - 0.5) - (c.x - px - 0.5) * (b.y - py - 0.5)) / area;
        const wb = ((c.x - px - 0.5) * (a.y - py - 0.5) - (a.x - px - 0.5) * (c.y - py - 0.5)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const z = 1 / (wa / a.w + wb / b.w + wc / c.w);
        const pi = py * W + px;
        if (z >= zbuf[pi]) continue;
        zbuf[pi] = z;
        const i = pi * 3;
        img[i] = col[0] * lit; img[i + 1] = col[1] * lit; img[i + 2] = col[2] * lit;
      }
    }
  };
  const drawPart = (part, ox, oz) => {
    const pos = part.pos;
    const col = COL[part.mat] || [0.5, 0.5, 0.5];
    for (let i = 0; i < part.idx.length; i += 3) {
      const a = part.idx[i] * 3;
      const b = part.idx[i + 1] * 3;
      const c = part.idx[i + 2] * 3;
      tri(
        [pos[a] + ox, pos[a + 1], pos[a + 2] + oz],
        [pos[b] + ox, pos[b + 1], pos[b + 2] + oz],
        [pos[c] + ox, pos[c + 1], pos[c + 2] + oz],
        col
      );
    }
  };
  for (const p of all) {
    if (p.mat === 'tyre' || p.mat === 'rim' || p.mat === 'brake') continue;
    drawPart(p, 0, 0);
  }
  for (const [ox, oz] of wheelOffsets) {
    for (const p of wheels.tyre) drawPart(p, ox, oz);
    for (const p of wheels.details) drawPart(p, ox, oz);
  }
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) buf[i] = Math.max(0, Math.min(255, Math.round(img[i] * 255)));
  fs.writeFileSync(out, png(W, H, buf));
  console.log('wrote', out);
}

const wheelsAt = [[0.79, 1.31], [-0.79, 1.31], [0.79, -1.31], [-0.79, -1.31]];
render([4.6, 2.3, 5.2], [0, 0.72, 0], '/tmp/car-front34.png', wheelsAt);
render([-4.4, 2.1, -5.0], [0, 0.72, 0], '/tmp/car-rear34.png', wheelsAt);
render([0.02, 1.5, 7.4], [0, 0.75, 0], '/tmp/car-front.png', wheelsAt);
