// tools/closure-check.mjs — ray-casts the cockpit group to find holes (no interior hit).
import * as THREE from 'three';
import { buildCockpit, COCKPIT_EYE, COCKPIT_FOV } from '../src/cockpit.js';

const cp = buildCockpit(THREE);
cp.group.updateMatrixWorld(true);
const eye = new THREE.Vector3(...COCKPIT_EYE);
const W = 240, H = 135, aspect = 16 / 9;
const vf = (COCKPIT_FOV * Math.PI) / 180;
const hf = 2 * Math.atan(Math.tan(vf / 2) * aspect);
const rc = new THREE.Raycaster();
let miss = 0, total = 0;
const dir = new THREE.Vector3();
for (let y = 0; y < H; y++) {
  const vy = (0.5 - (y + 0.5) / H) * 2;
  for (let x = 0; x < W; x++) {
    const vx = ((x + 0.5) / W - 0.5) * 2;
    dir.set(Math.tan(hf / 2) * vx, Math.tan(vf / 2) * vy, 1).normalize();
    rc.set(eye, dir);
    total++;
    if (!rc.intersectObject(cp.group, true).length) miss++;
  }
}
console.log(`eye ${COCKPIT_EYE.join(',')} → no-hit ${miss}/${total} = ${(miss / total * 100).toFixed(2)}%`);
