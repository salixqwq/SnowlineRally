// cockpit.js — driver's interior + cockpit/bonnet camera anchors.
// All coordinates are derived from carmesh.js cabinSections so the interior frame
// closes the same opening as the exterior shell:
//   front slope: (z 0.62, y 1.30, hw 0.70) -> (z 1.12, y 0.98, hw 0.55)
//   roof line:   y 1.36 @ z -0.35 ... 1.30 @ z 0.62
//   belt line:   y 0.90
//   rear:        z -0.95 (y 1.32) ... -1.5 (y 0.95)

export const COCKPIT_EYE = [0.36, 1.16, 0.14];
export const COCKPIT_LOOK = [0.36, 1.13, 26];
export const COCKPIT_FOV = 86;
export const BONNET_EYE = [0, 1.45, 0.30];
export const BONNET_LOOK = [0, 0.92, 26];
export const BONNET_FOV = 66;

export function buildCockpit(THREE) {
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9, metalness: 0.08 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x3a424c, roughness: 0.78, metalness: 0.06 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x6d7783, roughness: 0.9, metalness: 0.02 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.34, metalness: 0.9 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x7a1f12, roughness: 0.7, metalness: 0.15 });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x2f7f9e });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x9fc4dd, transparent: true, opacity: 0.13, roughness: 0.05, metalness: 0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const sideGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0x8fb6cf, transparent: true, opacity: 0.22, roughness: 0.06, metalness: 0,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.9, side: THREE.DoubleSide });

  const g = new THREE.Group();
  g.visible = false;
  const needles = [];

  const box = (w, h, d, x, y, z, mat, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.rotation.z = rz;
    g.add(m);
    return m;
  };
  // bar between two points (pillars, rails)
  const bar = (a, b, t, mat) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const dir = B.clone().sub(A);
    const len = dir.length();
    const m = new THREE.Mesh(new THREE.BoxGeometry(t, len, t), mat);
    m.position.copy(A.add(B).multiplyScalar(0.5));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    g.add(m);
    return m;
  };
  // flat quad from four corners (a,b,c,d counter-clockwise)
  const quad = (a, b, c, d, mat) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      ...a, ...b, ...c, ...d,
    ], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    g.add(m);
    return m;
  };

  // ---- roof + windscreen frame (matches cabinSections) ----
  box(1.32, 0.02, 1.40, 0, 1.318, -0.30, headMat);          // headliner (front edge 0.40)
  box(1.32, 0.02, 0.26, 0, 1.302, 0.51, headMat, 0.11);      // roof → header closure
  box(1.30, 0.02, 0.34, 0, 1.245, -1.02, headMat);          // rear roof (sloping)
  box(1.40, 0.03, 0.09, 0, 1.285, 0.62, trimMat);           // header beam
  bar([0.69, 1.30, 0.62], [0.66, 0.98, 1.12], 0.045, trimMat);   // right A-pillar
  bar([-0.69, 1.30, 0.62], [-0.66, 0.98, 1.12], 0.045, trimMat); // left A-pillar
  quad([-0.69, 1.30, 0.62], [0.69, 1.30, 0.62], [0.66, 0.98, 1.12], [-0.66, 0.98, 1.12], glassMat); // windscreen (trapezoid)
  // windscreen top tint
  quad([-0.685, 1.315, 0.635], [0.685, 1.315, 0.635], [0.675, 1.245, 0.735], [-0.675, 1.245, 0.735],
    new THREE.MeshBasicMaterial({ color: 0x18242c, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }));
  // cowl between windscreen base and dashboard
  box(1.40, 0.04, 0.32, 0, 0.909, 0.975, darkMat, -0.33);

  // ---- side windows, frames and doors ----
  for (const sx of [1, -1]) {
    const X = (v) => sx * v;
    // front side window: trapezoid, its front edge follows the A-pillar
    quad(
      [X(0.695), 1.30, 0.55], [X(0.70), 0.90, 0.95],
      [X(0.71), 0.90, -0.15], [X(0.705), 1.30, -0.15], sideGlassMat
    );
    // rear side window
    quad(
      [X(0.705), 1.30, -0.15], [X(0.71), 0.90, -0.15],
      [X(0.715), 0.90, -0.90], [X(0.71), 1.31, -0.90], sideGlassMat
    );
    // A-pillar surface: windscreen edge -> front window edge (narrow band)
    quad(
      [X(0.69), 1.30, 0.62], [X(0.66), 0.98, 1.12],
      [X(0.70), 0.90, 0.95], [X(0.695), 1.30, 0.55], panelMat
    );
    box(0.05, 0.42, 0.07, X(0.705), 1.11, -0.15, trimMat);    // B-pillar
    box(0.05, 0.045, 1.5, X(0.705), 1.30, -0.15, trimMat);    // top rail
    box(0.05, 0.045, 1.9, X(0.71), 0.915, 0.0, trimMat);      // belt rail
    box(0.03, 0.47, 1.55, X(0.705), 0.67, -0.10, darkMat);    // door card
    box(0.07, 0.055, 0.52, X(0.705) - sx * 0.045, 0.66, -0.10, trimMat);
  }
  box(1.42, 0.88, 0.04, 0, 0.88, -0.95, darkMat);            // rear bulkhead
  box(1.40, 0.03, 2.00, 0, 0.43, 0.02, darkMat);             // floor
  box(1.30, 0.52, 0.04, 0, 0.70, 1.03, darkMat);             // front bulkhead
  for (const sx of [-0.64, 0.64]) box(0.16, 0.48, 0.10, sx, 0.68, 0.99, darkMat); // corner filler
  const panel = (a, b, c2, d) => quad(a, b, c2, d, panelMat);
  for (const sx of [1, -1]) {
    // kick panel: below the belt line, door front to cowl
    const q2 = [
      [sx * 0.705, 0.90, 0.62], [sx * 0.705, 0.44, 0.62],
      [sx * 0.65, 0.44, 1.03], [sx * 0.65, 0.90, 1.03],
    ];
    if (sx > 0) panel(...q2); else panel(...q2.reverse());
  }
  box(0.26, 0.16, 1.30, 0, 0.48, -0.20, trimMat);            // tunnel

  // ---- dashboard ----
  box(1.30, 0.30, 0.40, 0, 0.665, 0.82, darkMat);
  box(1.26, 0.04, 0.38, 0, 0.85, 0.82, trimMat);
  box(0.22, 0.26, 0.08, 0, 0.70, 0.64, trimMat);
  box(0.16, 0.028, 0.015, 0, 0.79, 0.59, glowMat);
  for (let i = 0; i < 3; i++) box(0.12, 0.012, 0.01, 0, 0.72 - i * 0.03, 0.587, glowMat);
  box(0.18, 0.14, 0.55, 0, 0.50, 0.15, darkMat);
  box(0.09, 0.04, 0.16, 0.02, 0.585, 0.22, accentMat);
  for (const sx of [0.16, 0.56]) box(0.07, 0.025, 0.02, sx, 0.86, 0.585, darkMat);
  box(0.16, 0.09, 0.012, 0.05, 0.84, 0.575, glowMat);
  // gear lever + handbrake
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.20, 6), metalMat);
  shaft.position.set(0, 0.70, 0.20); shaft.rotation.x = 0.32; g.add(shaft);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), accentMat);
  knob.position.set(0, 0.79, 0.17); g.add(knob);
  const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.18, 6), metalMat);
  hb.position.set(0, 0.62, 0.02); hb.rotation.x = 1.25; g.add(hb);

  // ---- instrument cluster ----
  box(0.40, 0.024, 0.14, 0.36, 1.015, 0.64, trimMat, 0.10);  // binnacle
  for (const sx of [0.30, 0.42]) {
    const gauge = new THREE.Group();
    gauge.position.set(sx, 0.955, 0.62);
    gauge.rotation.y = Math.PI;
    gauge.rotation.x = 0.14;
    gauge.add(new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.007, 6, 20), metalMat));
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.053, 20), new THREE.MeshBasicMaterial({ color: 0x0d1b21 }));
    face.position.z = 0.002; gauge.add(face);
    const needleGeo = new THREE.BoxGeometry(0.006, 0.045, 0.004);
    needleGeo.translate(0, 0.022, 0);
    const needle = new THREE.Mesh(needleGeo, new THREE.MeshBasicMaterial({ color: 0xe0582e }));
    needle.position.z = 0.007; gauge.add(needle);
    g.add(gauge);
    needles.push(needle);
  }

  // ---- seats ----
  for (const sx of [-0.36, 0.36]) {
    box(0.46, 0.10, 0.46, sx, 0.47, -0.22, darkMat);
    box(0.46, 0.56, 0.10, sx, 0.75, -0.46, darkMat, 0.16);
    box(0.26, 0.15, 0.09, sx, 1.05, -0.52, darkMat, 0.16);
    box(0.05, 0.46, 0.045, sx - 0.19, 0.47, -0.21, accentMat);
    box(0.05, 0.46, 0.045, sx + 0.19, 0.47, -0.21, accentMat);
  }

  // ---- steering wheel ----
  const wheel = new THREE.Group();
  wheel.position.set(0.36, 0.79, 0.61);
  wheel.rotation.x = Math.PI + 0.28;
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.02, 8, 26), trimMat));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.055, 12), metalMat);
  hub.rotation.x = Math.PI / 2; wheel.add(hub);
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.14, 0.02), metalMat);
    spoke.position.set(Math.sin((i / 3) * Math.PI * 2) * 0.078, Math.cos((i / 3) * Math.PI * 2) * 0.078, 0);
    spoke.rotation.z = -(i / 3) * Math.PI * 2;
    wheel.add(spoke);
  }
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.018, 0.026), new THREE.MeshBasicMaterial({ color: 0xd94a2a }));
  marker.position.set(0, -0.145, 0.008);
  wheel.add(marker);
  g.add(wheel);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.26, 8), darkMat);
  column.position.set(0.36, 0.77, 0.66); column.rotation.x = 1.25; g.add(column);
  const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.09, 10), trimMat);
  shroud.position.set(0.36, 0.765, 0.645); shroud.rotation.x = 1.25; g.add(shroud);

  // ---- cockpit-only bonnet, seen over the dashboard ----
  const bonnetMat = new THREE.MeshStandardMaterial({ color: 0xa83318, roughness: 0.42, metalness: 0.2 });
  const bonnet = new THREE.Mesh(new THREE.BoxGeometry(1.30, 0.03, 0.88), bonnetMat);
  bonnet.position.set(0, 0.90, 1.58);
  bonnet.rotation.x = 0.09;
  g.add(bonnet);

  // rear-view mirror + sun visors
  box(0.22, 0.05, 0.03, 0, 1.285, 0.58, trimMat);
  for (const sx of [-0.30, 0.30]) box(0.36, 0.02, 0.14, sx, 1.288, 0.55, darkMat, 0.10);

  return { group: g, wheel, needles };
}
