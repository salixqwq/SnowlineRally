// math.js — small, dependency-free helpers. Everything in this file is pure.
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// frame-rate independent exponential approach
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const signOf = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
export const angleDelta = (a, b) => wrapAngle(b - a);

// deterministic RNG
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const v3set = (o, x, y, z) => ((o.x = x), (o.y = y), (o.z = z), o);
export const v3copy = (a) => ({ x: a.x, y: a.y, z: a.z });
export const v3add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const v3sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const v3mul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const v3dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const v3len = (a) => Math.hypot(a.x, a.y, a.z);
export const v3norm = (a) => {
  const l = v3len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
export const v3lerp = (a, b, t) => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

// forward for a yaw around +Y, yaw 0 = +Z, positive yaw turns toward +X (right)
export const fwdX = (yaw) => Math.sin(yaw);
export const fwdZ = (yaw) => Math.cos(yaw);
// right-hand basis: right = (cos yaw, 0, -sin yaw)
export const rightX = (yaw) => Math.cos(yaw);
export const rightZ = (yaw) => -Math.sin(yaw);

export const fmtTime = (ms, signed = false) => {
  const neg = ms < 0;
  ms = Math.abs(ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  const core = `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
  if (signed) return (neg ? '-' : '+') + core;
  return core;
};
export const fmtClock = (ms) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(t).padStart(2, '0')}`;
};
