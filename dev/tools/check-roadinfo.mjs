// tools/check-roadinfo.mjs — compares roadInfo() with a brute-force nearest-sample search,
// especially for points far off the road (where the spatial hash used to return wrong segments).
import { buildStage, STAGES } from '../src/track.js';

for (const opts of STAGES) {
  const stage = buildStage(opts);
  const sm = stage.samples;
  let worst = 0, worstAt = null, bad = 0, n = 0;
  // deterministic pseudo-random probes
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 3000; k++) {
    const i = Math.floor(rnd() * sm.length);
    const a = sm[i];
    const side = rnd() < 0.5 ? 1 : -1;
    const off = 10 + rnd() * 55;
    const x = a.x + a.rx * off * side;
    const z = a.z + a.rz * off * side;
    // brute force nearest sample
    let bd = Infinity;
    for (let j = 0; j < sm.length; j++) {
      const dx = sm[j].x - x, dz = sm[j].z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) bd = d;
    }
    const truth = Math.sqrt(bd);
    const got = stage.roadInfo(x, z);
    const err = Math.abs(got.dist - truth);
    n++;
    if (err > 0.6) { bad++; if (err > worst) { worst = err; worstAt = { i, off: +off.toFixed(1), truth: +truth.toFixed(1), got: +got.dist.toFixed(1), s: +got.s.toFixed(0) }; } }
  }
  console.log(`${opts.name || opts.id}: probes ${n}, >0.6m ${bad} (${(bad / n * 100).toFixed(2)}%), worst ${worst.toFixed(1)}m`, worstAt || '');
}
