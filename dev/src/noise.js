// noise.js — seeded value noise + fbm, pure and cheap.
import { mulberry32 } from './math.js';

const HASH_SIZE = 512;
const perm = new Uint8Array(HASH_SIZE);
const grad = new Float32Array(HASH_SIZE);

function reseed(seed) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < HASH_SIZE; i++) {
    perm[i] = Math.floor(rnd() * 256);
    grad[i] = rnd() * 2 - 1;
  }
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

let seeded = false;
export function setNoiseSeed(seed) {
  reseed(seed || 1);
  seeded = true;
}
function ensure() {
  if (!seeded) reseed(1337);
}

// smoothed value noise in [-1,1]
export function noise2(x, y) {
  ensure();
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);

  const a = perm[(xi & 255) + perm[yi & 255]];
  const b = perm[((xi + 1) & 255) + perm[yi & 255]];
  const c = perm[(xi & 255) + perm[(yi + 1) & 255]];
  const d = perm[((xi + 1) & 255) + perm[(yi + 1) & 255]];

  // value at lattice points from the grad table
  const va = grad[a];
  const vb = grad[b];
  const vc = grad[c];
  const vd = grad[d];

  const top = va + (vb - va) * u;
  const bot = vc + (vd - vc) * u;
  return top + (bot - top) * v;
}

export function fbm2(x, y, octaves = 4, lac = 2.03, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(fx, fy) * amp;
    norm += amp;
    amp *= gain;
    fx *= lac;
    fy *= lac;
  }
  return sum / (norm || 1);
}

// ridged noise, good for mountain silhouettes
export function ridge2(x, y, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += (1 - Math.abs(noise2(fx, fy))) * amp;
    amp *= 0.5;
    fx *= 2.03;
    fy *= 2.03;
  }
  return sum;
}
