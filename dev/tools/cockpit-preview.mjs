// tools/cockpit-preview.mjs — offline CPU rasteriser for the cockpit/bonnet views.
// Renders the real cockpit group (src/cockpit.js) + car body (src/carmesh.js) so the
// camera framing can be checked without a browser.
import * as THREE from 'three';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildCockpit, COCKPIT_EYE, COCKPIT_LOOK, COCKPIT_FOV, BONNET_EYE, BONNET_LOOK, BONNET_FOV } from '../src/cockpit.js';
import { buildCarParts } from '../src/carmesh.js';

const W = 960, H = 540;
const MAT = {
  paint: [184, 50, 26], dark: [19, 21, 25], trim: [38, 43, 51], metal: [154, 161, 168],
  accent: [122, 31, 18], glass: [10, 16, 22], lightF: [255, 245, 220], lightR: [220, 40, 30],
  rim: [160, 166, 174], brake: [60, 63, 68], tyre: [12, 12, 14], snow: [246, 250, 253],
};

// ---- tiny PNG writer ----
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

function raster(scene, cam, out) {
  scene.updateMatrixWorld(true);
  const buf = new Uint8Array(W * H * 3);
  const zb = new Float32Array(W * H).fill(Infinity);
  // sky gradient
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const r = Math.round(222 + (200 - 222) * t), g = Math.round(236 + (222 - 236) * t), b = Math.round(248 + (240 - 248) * t);
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; }
  }
  const light = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
  const camWorld = cam.position.clone();
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  const n0 = new THREE.Vector3(), tmp = new THREE.Vector3();
  const mwi = cam.matrixWorldInverse;

  scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (o.material && o.material.transparent) return; // glass: transparent in game
    const geo = o.geometry;
    const posAttr = geo.attributes.position, nAttr = geo.attributes.normal;
    if (!posAttr) return;
    const idx = geo.index ? geo.index.array : null;
    const triCount = idx ? idx.length / 3 : posAttr.count / 3;
    const mat = o.material;
    const base = Array.isArray(mat) ? [120, 120, 120] : (MAT[o.userData.mat] || (mat.color ? [mat.color.r * 255, mat.color.g * 255, mat.color.b * 255] : [120, 120, 120]));
    const projected = [];
    for (let t = 0; t < triCount; t++) {
      const ia = idx ? idx[t * 3] : t * 3, ib = idx ? idx[t * 3 + 1] : t * 3 + 1, ic = idx ? idx[t * 3 + 2] : t * 3 + 2;
      v0.fromBufferAttribute(posAttr, ia).applyMatrix4(o.matrixWorld);
      v1.fromBufferAttribute(posAttr, ib).applyMatrix4(o.matrixWorld);
      v2.fromBufferAttribute(posAttr, ic).applyMatrix4(o.matrixWorld);
      // face normal from geometry normals (average) transformed
      n0.subVectors(v1, v0).cross(tmp.subVectors(v2, v0));
      if (n0.lengthSq() < 1e-12) continue;
      n0.normalize();
      tmp.copy(v0).add(v1).add(v2).multiplyScalar(1 / 3);
      if (n0.dot(tmp.sub(camWorld)) > 0) continue; // backface cull (front normal faces camera)
      const p = [v0, v1, v2].map((v) => v.clone().applyMatrix4(mwi));
      if (p.some((v) => v.z > -0.05)) continue;
      const sp = p.map((v) => {
        const q = v.clone().applyMatrix4(cam.projectionMatrix);
        return { x: (q.x * 0.5 + 0.5) * W, y: (1 - (q.y * 0.5 + 0.5)) * H, z: -v.z };
      });
      // signed area for winding
      const area = (sp[1].x - sp[0].x) * (sp[2].y - sp[0].y) - (sp[2].x - sp[0].x) * (sp[1].y - sp[0].y);
      if (Math.abs(area) < 1e-6) continue;
      const lam = Math.max(0, n0.dot(light));
      const shade = 0.42 + 0.58 * lam;
      const col = base.map((c) => Math.min(255, Math.round(c * shade + 26)));
      const minX = Math.max(0, Math.floor(Math.min(sp[0].x, sp[1].x, sp[2].x)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(sp[0].x, sp[1].x, sp[2].x)));
      const minY = Math.max(0, Math.floor(Math.min(sp[0].y, sp[1].y, sp[2].y)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(sp[0].y, sp[1].y, sp[2].y)));
      const den = area || 1;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const w0 = ((sp[1].x - x) * (sp[2].y - y) - (sp[2].x - x) * (sp[1].y - y)) / den;
          const w1 = ((sp[2].x - x) * (sp[0].y - y) - (sp[0].x - x) * (sp[2].y - y)) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * sp[0].z + w1 * sp[1].z + w2 * sp[2].z;
          const pi = y * W + x;
          if (z >= zb[pi]) continue;
          zb[pi] = z;
          const i = pi * 3; buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2];
        }
      }
    }
  });
  fs.writeFileSync(out, png(W, H, Buffer.from(buf)));
  console.log('wrote', out);
}

function buildScene(includeInterior, includeBody = true) {
  const scene = new THREE.Group();
  for (const part of (includeBody ? buildCarParts() : [])) {
    if (part.mat === 'glass') continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(part.idx, 1));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    m.userData.mat = part.mat;
    scene.add(m);
  }
  // ground plane so the horizon reads
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-200,0,5, 200,0,5, 200,0,205, -200,0,205], 3));
  g.setIndex([0,3,2,0,2,1]);
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  ground.userData.mat = 'snow';
  scene.add(ground);
  if (includeInterior) {
    const cp = buildCockpit(THREE);
    scene.add(cp.group);
  }
  return scene;
}

function shoot(eye, look, fov, interior, out, body = true) {
  const scene = buildScene(interior, body);
  const cam = new THREE.PerspectiveCamera(fov, W / H, 0.05, 200);
  cam.position.set(eye[0], eye[1], eye[2]);
  cam.lookAt(look[0], look[1], look[2]);
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  cam.updateProjectionMatrix();
  raster(scene, cam, out);
}

shoot(COCKPIT_EYE, COCKPIT_LOOK, COCKPIT_FOV, true, '/tmp/cockpit.png', false);
shoot(COCKPIT_EYE, COCKPIT_LOOK, COCKPIT_FOV, true, '/tmp/cockpit-interior.png', false);
shoot(COCKPIT_EYE, COCKPIT_LOOK, COCKPIT_FOV, false, '/tmp/cockpit-body.png');
shoot(BONNET_EYE, BONNET_LOOK, BONNET_FOV, false, '/tmp/hood.png');
shoot([0, 1.55, 0.40], [0, 0.90, 26], 68, false, '/tmp/bonnet-hi.png');
shoot([0, 1.08, 1.80], [0, 0.98, 26], 68, false, '/tmp/bonnet-front.png');
shoot([0, 1.68, 0.05], [0, 0.90, 26], 66, false, '/tmp/roof-high.png');
shoot([0, 1.45, 0.30], [0, 0.92, 26], 66, false, '/tmp/bonnet-v2.png');
shoot([0, 1.24, 0.85], [0, 1.00, 26], 66, false, '/tmp/bonnet-v3.png');
shoot([0, 1.30, 0.72], [0, 0.98, 26], 64, false, '/tmp/bonnet-v4.png');
shoot([0, 1.12, 1.55], [0, 1.02, 26], 68, false, '/tmp/hood-a.png');
shoot([0, 1.00, 1.45], [0, 0.95, 26], 68, false, '/tmp/hood-b.png');
shoot([0, 1.06, 1.85], [0, 1.00, 26], 68, false, '/tmp/hood-c.png');
shoot([0, 1.56, -0.20], [0, 1.00, 26], 68, false, '/tmp/roofcam.png');
shoot([0, 0.98, 2.30], [0, 0.90, 26], 68, false, '/tmp/nosecam.png');
shoot([0, 1.30, 0.55], [0, 0.90, 26], 68, false, '/tmp/hoodtop.png');
shoot([0, 1.20, 0.75], [0, 0.85, 26], 68, false, '/tmp/hoodtop2.png');
shoot([0, 2.4, -6.5], [0, 1.2, 0], 60, false, '/tmp/chase.png');
shoot([0, 2.6, 0.2], [0, 0.7, 3.2], 60, false, '/tmp/above.png');
