import { buildStage, STAGES, noteLabel } from './src/track.js';

for (const cfg of STAGES) {
  const t0 = performance.now();
  const st = buildStage(cfg);
  const ms = performance.now() - t0;
  let minR = Infinity, maxGrade = 0, maxK = 0;
  for (let i = 1; i < st.samples.length - 1; i++) {
    const a = st.samples[i - 1], b = st.samples[i + 1];
    const grade = Math.abs(b.y - a.y) / Math.hypot(b.x - a.x, b.z - a.z);
    maxGrade = Math.max(maxGrade, grade);
    minR = Math.min(minR, st.samples[i].radius);
    maxK = Math.max(maxK, Math.abs(st.samples[i].ks));
  }
  // road/terrain consistency
  let worst = 0;
  for (let i = 0; i < st.samples.length; i += 7) {
    const s = st.samples[i];
    worst = Math.max(worst, Math.abs(st.heightAt(s.x, s.z) - s.y));
  }
  const ys = st.samples.map(s => s.y);
  console.log(`[${st.name}] len=${st.totalLength.toFixed(0)}m gen=${ms.toFixed(0)}ms trees=${st.trees.length} rocks=${st.rocks.length} poles=${st.poles.length} notes=${st.notes.length}`);
  console.log(`   minRadius=${minR.toFixed(1)}m maxGrade=${(maxGrade*100).toFixed(1)}% roadVsTerrainErr=${worst.toFixed(2)}m  y=[${Math.min(...ys).toFixed(1)},${Math.max(...ys).toFixed(1)}]`);
  console.log(`   bbox x[${st.bbox.minX.toFixed(0)},${st.bbox.maxX.toFixed(0)}] z[${st.bbox.minZ.toFixed(0)},${st.bbox.maxZ.toFixed(0)}]  area=${((st.bbox.maxX-st.bbox.minX)*(st.bbox.maxZ-st.bbox.minZ)/1e6).toFixed(2)}km2`);
  console.log(`   notes: ${st.notes.slice(0, 10).map(n => noteLabel(n) + '@' + n.s0.toFixed(0)).join(' ')}`);
  const nan = st.samples.some(s => !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z));
  console.log(`   NaN=${nan} firstSample=${JSON.stringify(st.start)}`);
}
